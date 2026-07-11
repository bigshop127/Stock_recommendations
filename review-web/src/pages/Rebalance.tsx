import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SlidersHorizontal, AlertTriangle, CheckCircle2, Info, ArrowRightLeft, ShieldAlert, RefreshCw, Loader2, Plus, Trash2, UploadCloud, Cloud, CloudOff, Lock, Unlock } from 'lucide-react';
import { getRebalanceConfig, saveRebalanceConfig, subscribeRebalance, type RebalanceConfig } from '../lib/rebalanceStore';
import { computeRebalance, aggregatePortfolio, BOND_ETFS, ETF_CODE, type RebalanceResult, type Trade, computeFundFlows, computeMarketStatus, type MarketStatus } from '../lib/rebalance';
import { api } from '../lib/api';

// 資產清單（00631L＋防守端債券 ETF）【增修I】
const ASSETS: { code: string; name: string }[] = [
  { code: ETF_CODE, name: '台灣50正2' },
  ...BOND_ETFS.map((b) => ({ code: b.code, name: b.name })),
];
const assetName = (code: string) => ASSETS.find((a) => a.code === code)?.name ?? code;

// 半圓 SVG 儀表元件
const BetaGauge: React.FC<{
  currentBeta: number | null;
  targetBeta: number;
  lowerBand: number;
  upperBand: number;
  etfBeta: number;
}> = ({ currentBeta, targetBeta, lowerBand, upperBand, etfBeta }) => {
  const maxBeta = Math.max(2.0, etfBeta);

  // 將 Beta (0 ~ maxBeta) 轉換成 SVG 角弧度 (180 deg ~ 0 deg)
  const betaToAngle = (b: number) => {
    const clamped = Math.min(Math.max(b, 0), maxBeta);
    return 180 - (clamped / maxBeta) * 180;
  };

  const getCoordinates = (angleDeg: number, radius: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: 120 + radius * Math.cos(rad),
      y: 110 - radius * Math.sin(rad),
    };
  };

  const createArcPath = (startBeta: number, endBeta: number, radius: number) => {
    const startAngle = betaToAngle(startBeta);
    const endAngle = betaToAngle(endBeta);
    const p1 = getCoordinates(startAngle, radius);
    const p2 = getCoordinates(endAngle, radius);
    const largeArcFlag = Math.abs(startAngle - endAngle) <= 180 ? '0' : '1';
    return `M ${p1.x} ${p1.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${p2.x} ${p2.y}`;
  };

  const currentAngle = betaToAngle(currentBeta ?? 0);
  const targetAngle = betaToAngle(targetBeta);
  const needlePos = getCoordinates(currentAngle, 65);
  const targetPos = getCoordinates(targetAngle, 80);

  return (
    <div className="relative flex flex-col items-center justify-center pt-2 pb-1">
      <svg viewBox="0 0 240 135" className="w-full max-w-[280px] overflow-visible">
        {/* 背景底弧 (0 -> maxBeta) */}
        <path
          d={createArcPath(0, maxBeta, 80)}
          fill="none"
          stroke="#27272a"
          strokeWidth="14"
          strokeLinecap="round"
        />

        {/* 正常容忍區間弧形 (LowerBand -> UpperBand) */}
        <path
          d={createArcPath(lowerBand, upperBand, 80)}
          fill="none"
          stroke="#10b981"
          strokeOpacity="0.25"
          strokeWidth="14"
        />

        {/* 刻度標籤 */}
        {/* 0.0x */}
        <text x="32" y="125" textAnchor="middle" fill="#71717a" className="text-[10px] font-mono select-none">
          0.0X
        </text>
        {/* 1.0x */}
        <text x="120" y="20" textAnchor="middle" fill="#71717a" className="text-[10px] font-mono select-none">
          1.0X
        </text>
        {/* 2.0x (或 maxBeta) */}
        <text x="208" y="125" textAnchor="middle" fill="#71717a" className="text-[10px] font-mono select-none">
          {maxBeta.toFixed(1)}X
        </text>

        {/* 目標 Beta 標記點 (白圓圈) */}
        <circle
          cx={targetPos.x}
          cy={targetPos.y}
          r="6"
          fill="#ffffff"
          stroke="#3f3f46"
          strokeWidth="2"
          className="shadow-md transition-all duration-300"
        />

        {/* 現有 Beta 指針 */}
        {currentBeta !== null && (
          <>
            <line
              x1="120"
              y1="110"
              x2={needlePos.x}
              y2={needlePos.y}
              stroke="#3b82f6"
              strokeWidth="3.5"
              strokeLinecap="round"
              className="transition-all duration-300"
            />
            <circle cx="120" cy="110" r="5" fill="#3b82f6" />
          </>
        )}
      </svg>

      {/* 中央大字現值 */}
      <div className="text-center -mt-6">
        <div className="text-3xl font-extrabold tracking-tight font-mono text-zinc-100">
          {currentBeta !== null ? `${currentBeta.toFixed(2)}X` : '—'}
        </div>
        <div className="text-xs text-zinc-400 font-medium mt-0.5 flex items-center justify-center gap-1">
          <span>目前投組 Beta</span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">目標: <strong className="text-zinc-200 font-mono">{targetBeta.toFixed(2)}X</strong></span>
        </div>
      </div>
    </div>
  );
};

function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function newTradeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) { /* fall through */ }
  return `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

type CloudState = {
  status: 'idle' | 'loading' | 'syncing' | 'saved' | 'error';
  savedAt: string | null;
  msg: string | null;
};

type PriceFetchState = Record<string, { loading: boolean; error: string | null; date: string | null }>;

const emptyPriceFetch = (): PriceFetchState =>
  Object.fromEntries(ASSETS.map((a) => [a.code, { loading: false, error: null, date: null }]));

// 由 config 取某資產現價（00631L 走頂層 price、債券走 bonds[]）
function assetPrice(cfg: RebalanceConfig, code: string): number {
  if (code === ETF_CODE) return cfg.price;
  return cfg.bonds.find((b) => b.code === code)?.price ?? 0;
}

export function Rebalance() {
  const [config, setConfig] = useState<RebalanceConfig>(() => getRebalanceConfig());

  // 直接編輯欄位的本地暫存（允許打字未完，如 "12."）——各資產現價、期初部位
  const [priceStrs, setPriceStrs] = useState<Record<string, string>>(() =>
    Object.fromEntries(ASSETS.map((a) => [a.code, assetPrice(config, a.code) ? String(assetPrice(config, a.code)) : ''])),
  );
  const [openStrs, setOpenStrs] = useState<Record<string, { shares: string; avg: string }>>(() => ({
    [ETF_CODE]: {
      shares: config.opening.shares ? String(config.opening.shares) : '',
      avg: config.opening.avg_cost ? String(config.opening.avg_cost) : '',
    },
    ...Object.fromEntries(
      config.opening.bonds.map((b) => [b.code, { shares: b.shares ? String(b.shares) : '', avg: b.avg_cost ? String(b.avg_cost) : '' }]),
    ),
  }));
  const [openCashStr, setOpenCashStr] = useState<string>(() => String(config.opening.cash || ''));
  const [cashReserveStr, setCashReserveStr] = useState<string>(() => String(config.cash_reserve || ''));
  const [cashStr, setCashStr] = useState<string>(() => String(config.cash || ''));
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [marketStatusLoading, setMarketStatusLoading] = useState(false);
  const [marketStatusError, setMarketStatusError] = useState(false);
  const taiexClosesRef = useRef<{ date: string; close: number }[]>([]);

  useEffect(() => {
    let active = true;
    const fetchMarketStatus = async () => {
      if (taiexClosesRef.current.length > 0) {
        const status = computeMarketStatus({
          closes: taiexClosesRef.current,
          tier1_dd: config.tier1_dd,
          tier2_dd: config.tier2_dd,
          tier3_dd: config.tier3_dd,
        });
        setMarketStatus(status);
        return;
      }

      setMarketStatusLoading(true);
      setMarketStatusError(false);
      try {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 3);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const start = `${y}-${m}-${day}`;

        const ohlcvData = await api.ohlcv('TAIEX', { start });
        if (!active) return;
        if (ohlcvData && Array.isArray(ohlcvData.data)) {
          const closes = ohlcvData.data.map((r) => ({ date: r.date, close: r.close }));
          taiexClosesRef.current = closes;
          const status = computeMarketStatus({
            closes,
            tier1_dd: config.tier1_dd,
            tier2_dd: config.tier2_dd,
            tier3_dd: config.tier3_dd,
          });
          setMarketStatus(status);
        } else {
          setMarketStatusError(true);
        }
      } catch (e) {
        console.error('Failed to fetch TAIEX market status', e);
        if (active) {
          setMarketStatusError(true);
        }
      } finally {
        if (active) {
          setMarketStatusLoading(false);
        }
      }
    };

    fetchMarketStatus();
    return () => {
      active = false;
    };
  }, [config.tier1_dd, config.tier2_dd, config.tier3_dd]);

  // 報價單：新增一筆交易的表單（多資產：加標的選擇【增修I】）
  const [tradeCode, setTradeCode] = useState<string>(ETF_CODE);
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy');
  const [tradeDateStr, setTradeDateStr] = useState<string>(() => localToday());
  const [tradeSharesStr, setTradeSharesStr] = useState<string>('');
  const [tradePriceStr, setTradePriceStr] = useState<string>('');

  // 自動抓取最新收盤價的狀態（各資產獨立）
  const [priceFetch, setPriceFetch] = useState<PriceFetchState>(emptyPriceFetch);

  // 雲端同步狀態
  const [cloud, setCloud] = useState<CloudState>({ status: 'idle', savedAt: null, msg: null });

  // 真實同步（玉山證券）狀態：觸發本機 self-hosted runner 執行，輪詢 saved_at 直到更新或逾時
  const [realSync, setRealSync] = useState<{
    status: 'idle' | 'triggering' | 'waiting' | 'done' | 'timeout' | 'error';
    msg: string | null;
  }>({ status: 'idle', msg: null });

  useEffect(() => {
    const unsub = subscribeRebalance(() => {
      const updated = getRebalanceConfig();
      setConfig(updated);
    });
    return unsub;
  }, []);

  // 同步 input 欄位，若外部 store 改變
  const bondPricesKey = config.bonds.map((b) => `${b.code}:${b.price}`).join(',');
  const openBondsKey = config.opening.bonds.map((b) => `${b.code}:${b.shares}:${b.avg_cost}`).join(',');
  useEffect(() => {
    setPriceStrs(
      Object.fromEntries(ASSETS.map((a) => [a.code, assetPrice(config, a.code) ? String(assetPrice(config, a.code)) : ''])),
    );
    setOpenStrs({
      [ETF_CODE]: {
        shares: config.opening.shares ? String(config.opening.shares) : '',
        avg: config.opening.avg_cost ? String(config.opening.avg_cost) : '',
      },
      ...Object.fromEntries(
        config.opening.bonds.map((b) => [b.code, { shares: b.shares ? String(b.shares) : '', avg: b.avg_cost ? String(b.avg_cost) : '' }]),
      ),
    });
    setOpenCashStr(config.opening.cash ? String(config.opening.cash) : '');
    setCashReserveStr(config.cash_reserve ? String(config.cash_reserve) : '');
    setCashStr(config.cash ? String(config.cash) : '0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.price, bondPricesKey, config.opening.shares, config.opening.avg_cost, config.opening.cash, openBondsKey, config.cash_reserve, config.cash]);

  // 套用設定：合併 partial → 重算衍生 shares/avg_cost/cash（＝aggregatePortfolio）→ 存 localStorage
  const applyConfig = (partial: Partial<RebalanceConfig>): RebalanceConfig => {
    const merged = { ...config, ...partial };
    const agg = aggregatePortfolio(
      {
        cash: merged.opening.cash,
        positions: {
          [ETF_CODE]: { shares: merged.opening.shares, avg_cost: merged.opening.avg_cost },
          ...Object.fromEntries(merged.opening.bonds.map((b) => [b.code, { shares: b.shares, avg_cost: b.avg_cost }])),
        },
      },
      merged.trades,
    );
    const etfPos = agg.positions[ETF_CODE];
    const next: RebalanceConfig = {
      ...merged,
      shares: etfPos ? etfPos.shares : 0,
      avg_cost: etfPos ? etfPos.avg_cost : 0,
      cash: Math.max(0, agg.cash), // 【增修H/I】現金為衍生（任一標的買扣賣加），負值 clamp 0
      bonds: merged.bonds.map((b) => {
        const pos = agg.positions[b.code];
        return { ...b, shares: pos ? pos.shares : 0, avg_cost: pos ? pos.avg_cost : 0 };
      }),
    };
    setConfig(next);
    saveRebalanceConfig(next);
    return next;
  };

  // 推送到雲端（gateway 寫 data/rebalance_holdings.json，告警腳本同一份）
  const syncToCloud = async (cfg: RebalanceConfig) => {
    setCloud({ status: 'syncing', savedAt: null, msg: null });
    try {
      const resp = await api.saveRebalanceHoldings({
        shares: cfg.shares,
        avg_cost: cfg.avg_cost,
        price: cfg.price,
        cash: cfg.cash,
        bonds: cfg.bonds,
        cash_reserve: cfg.cash_reserve,
        bond_split: cfg.bond_split,
        locked: cfg.locked,
        target_beta: cfg.target_beta,
        tolerance_mode: cfg.tolerance_mode,
        threshold_pct: cfg.threshold_pct,
        threshold_abs: cfg.threshold_abs,
        etf_beta: cfg.etf_beta,
        opening: cfg.opening,
        trades: cfg.trades,
      });
      setCloud({ status: 'saved', savedAt: resp.saved_at, msg: null });
    } catch (e) {
      setCloud({ status: 'error', savedAt: null, msg: e instanceof Error ? e.message : '同步失敗' });
    }
  };

  // 真實同步：觸發 gateway → GitHub workflow_dispatch → 本機 self-hosted runner 執行
  // sync_fugle_holdings.py（登入玉山證券在本機完成，憑證不經過 VM）。因為實際執行
  // 是非同步的（要等本機電腦接下這個 job），輪詢 saved_at 判斷何時真的完成。
  const syncRealHoldings = async () => {
    setRealSync({ status: 'triggering', msg: null });
    let baseline: string | null = null;
    try {
      const cur = await api.getRebalanceHoldings();
      baseline = cur.saved_at;
      await api.triggerRealSync();
    } catch (e) {
      setRealSync({ status: 'error', msg: e instanceof Error ? e.message : '觸發失敗' });
      return;
    }
    setRealSync({ status: 'waiting', msg: null });
    const maxAttempts = 40; // 3 秒一次，約 2 分鐘逾時
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const resp = await api.getRebalanceHoldings();
        if (resp.exists && resp.holdings && resp.saved_at && resp.saved_at !== baseline) {
          saveRebalanceConfig(resp.holdings as unknown as RebalanceConfig);
          setRealSync({ status: 'done', msg: resp.saved_at });
          return;
        }
      } catch (_) {
        // 單次輪詢失敗不中斷，繼續重試到逾時
      }
    }
    setRealSync({
      status: 'timeout',
      msg: '逾時未收到更新，請確認家中電腦已開機並登入（背景同步服務會在登入時自動啟動）。',
    });
  };

  // 掛載：先從雲端載入（雲端為主）；本機為離線快取。載入後對缺現價的資產自動抓一次即時報價。
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    let cancelled = false;
    setCloud((s) => ({ ...s, status: 'loading' }));
    api
      .getRebalanceHoldings()
      .then((resp) => {
        if (cancelled) return;
        if (resp.exists && resp.holdings) {
          // 雲端為事實來源 → 寫回本機快取並重繪（normalizeConfig 會補齊/重算）
          saveRebalanceConfig(resp.holdings as unknown as RebalanceConfig);
          setCloud({ status: 'saved', savedAt: null, msg: '已從雲端載入' });
        } else {
          setCloud({ status: 'idle', savedAt: null, msg: '雲端尚無資料，將以本機為準' });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCloud({ status: 'error', savedAt: null, msg: '雲端載入失敗，顯示本機資料' });
      })
      .finally(() => {
        if (cancelled) return;
        const cfg = getRebalanceConfig();
        for (const a of ASSETS) {
          if (assetPrice(cfg, a.code) <= 0) void fetchLatestPrice(a.code);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 寫回某資產現價（00631L → 頂層 price；債券 → bonds[]）
  const applyAssetPrice = (code: string, price: number): RebalanceConfig => {
    if (code === ETF_CODE) return applyConfig({ price });
    return applyConfig({ bonds: config.bonds.map((b) => (b.code === code ? { ...b, price } : b)) });
  };

  // /api/.../book 的 time 欄位視來源而異：TWSE MIS 給 "HH:MM:SS" 字串；富果給 epoch 數字（us 或 ms）
  const formatQuoteTime = (raw: unknown): string | null => {
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      const ms = raw > 1e14 ? raw / 1000 : raw < 1e11 ? raw * 1000 : raw; // us→ms／s→ms／已是ms
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d.toLocaleString('zh-TW', { hour12: false });
    }
    return null;
  };

  // 抓取某資產「現在」最新價（即時報價，非前一天收盤；市值＝股數×實際成交價，故不用還原）
  const fetchLatestPrice = async (code: string) => {
    setPriceFetch((s) => ({ ...s, [code]: { ...s[code], loading: true, error: null } }));
    try {
      const res = await api.book(code);
      const book = res?.book as { last_price?: number | null; time?: unknown } | undefined;
      const last = book?.last_price;
      if (!Number.isFinite(last) || (last as number) <= 0) throw new Error('查無即時報價');
      setPriceStrs((s) => ({ ...s, [code]: String(last) }));
      applyAssetPrice(code, last as number);
      setPriceFetch((s) => ({ ...s, [code]: { loading: false, error: null, date: formatQuoteTime(book?.time) } }));
    } catch (e) {
      setPriceFetch((s) => ({ ...s, [code]: { loading: false, error: e instanceof Error ? e.message : '抓取失敗', date: null } }));
    }
  };

  // 一鍵抓取全部資產的最新收盤價
  const fetchAllPrices = () => {
    for (const a of ASSETS) void fetchLatestPrice(a.code);
  };

  // 即時計算結果（config.bonds 形狀即 BondInput[]，cash_reserve / bond_split 一併傳入）
  const result: RebalanceResult = useMemo(() => {
    return computeRebalance(config);
  }, [config]);

  const fundFlows = useMemo(() => {
    return computeFundFlows(result);
  }, [result]);

  const renderBreakdown = (key: string) => {
    const sourceNode = fundFlows.sources.find((s) => s.key === key);
    const useNode = fundFlows.uses.find((u) => u.key === key);
    const node = sourceNode || useNode;
    if (!node || !node.breakdown || node.breakdown.length < 2) return null;

    const isSource = !!sourceNode;
    const getVerb = (targetKey: string) => {
      if (isSource) {
        return targetKey === 'cash' ? '補' : '買';
      } else {
        return targetKey === 'cash' ? '提領' : '賣';
      }
    };

    const breakdownText = node.breakdown
      .map((item) => {
        const verb = getVerb(item.key);
        const pctText = (item.pct * 100).toFixed(0);
        return `${pctText}% ${verb}${item.label}`;
      })
      .join('、');

    return (
      <div className="text-[10px] text-zinc-500 mt-1 leading-normal whitespace-normal break-words">
        └ 其中 {breakdownText}
      </div>
    );
  };


  // 報價單累算（已實現損益 / 超賣提示）
  const agg = useMemo(
    () =>
      aggregatePortfolio(
        {
          cash: config.opening.cash,
          positions: {
            [ETF_CODE]: { shares: config.opening.shares, avg_cost: config.opening.avg_cost },
            ...Object.fromEntries(config.opening.bonds.map((b) => [b.code, { shares: b.shares, avg_cost: b.avg_cost }])),
          },
        },
        config.trades,
      ),
    [config.opening, config.trades],
  );

  // 目前價格所處價帶（供觸發價帶面板標示；由 status 導出）
  const priceZone =
    result.status === 'buy'
      ? { label: '買進區（β 偏低、偏防守）', cls: 'bg-bear/10 border-bear/25 text-bear' }
      : result.status === 'sell'
        ? { label: '賣出區（β 偏高、偏槓桿）', cls: 'bg-bull/10 border-bull/25 text-bull' }
        : result.status === 'normal'
          ? { label: '容忍區間內（無須動作）', cls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' }
          : { label: '—', cls: 'bg-zinc-800/40 border-zinc-700 text-zinc-400' };

  const handlePriceChange = (code: string, val: string) => {
    setPriceStrs((s) => ({ ...s, [code]: val }));
    const parsed = parseFloat(val);
    applyAssetPrice(code, Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
    // 手動改價 → 清掉「自動收盤」標記，避免誤導日期
    setPriceFetch((s) => ({ ...s, [code]: { ...s[code], date: null, error: null } }));
  };

  const handleOpenCashChange = (val: string) => {
    setOpenCashStr(val);
    const parsed = parseFloat(val);
    applyConfig({ opening: { ...config.opening, cash: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 } });
  };

  // 閒置現金＝期初現金＋報價單現金流（衍生）。直接編輯時反解回期初現金，
  // 讓「買扣賣加」的累算邏輯（增修H）不變，只是把可調整的入口搬到這裡。
  const handleCashChange = (val: string) => {
    setCashStr(val);
    const parsed = parseFloat(val);
    const desired = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    const tradesCashDelta = agg.cash - config.opening.cash;
    applyConfig({ opening: { ...config.opening, cash: Math.max(0, desired - tradesCashDelta) } });
  };

  const handleCashReserveChange = (val: string) => {
    setCashReserveStr(val);
    const parsed = parseFloat(val);
    applyConfig({ cash_reserve: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
  };

  // 期初部位（多資產）：00631L 存 opening 頂層，債券存 opening.bonds【增修I】
  const handleOpenChange = (code: string, field: 'shares' | 'avg', val: string) => {
    setOpenStrs((s) => ({ ...s, [code]: { ...(s[code] ?? { shares: '', avg: '' }), [field]: val } }));
    const parsed = parseFloat(val);
    const num = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    if (code === ETF_CODE) {
      applyConfig({ opening: { ...config.opening, [field === 'shares' ? 'shares' : 'avg_cost']: num } });
    } else {
      applyConfig({
        opening: {
          ...config.opening,
          bonds: config.opening.bonds.map((b) =>
            b.code === code ? { ...b, [field === 'shares' ? 'shares' : 'avg_cost']: num } : b,
          ),
        },
      });
    }
  };

  // updateConfig：供上方兩張卡（目標β/容忍/etf_beta/bond_split）沿用
  const updateConfig = (partial: Partial<RebalanceConfig>) => {
    applyConfig(partial);
  };

  // 新增一筆交易 → 累算回填 → 自動同步雲端
  const addTrade = () => {
    const shares = parseFloat(tradeSharesStr);
    const price = parseFloat(tradePriceStr);
    if (!Number.isFinite(shares) || shares <= 0) return;
    if (!Number.isFinite(price) || price < 0) return;
    const t: Trade = {
      id: newTradeId(),
      date: tradeDateStr || localToday(),
      side: tradeSide,
      shares,
      price,
      code: tradeCode,
    };
    const next = applyConfig({ trades: [...config.trades, t] });
    setTradeSharesStr('');
    setTradePriceStr('');
    void syncToCloud(next);
  };

  // 刪除一筆交易 → 累算回填 → 自動同步雲端
  const deleteTrade = (id: string) => {
    const next = applyConfig({ trades: config.trades.filter((t) => t.id !== id) });
    void syncToCloud(next);
  };

  // 交易紀錄依日期降冪顯示（最新在上）
  const tradesSorted = useMemo(
    () => [...config.trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [config.trades],
  );

  // 目標 Beta (00631L % / 防守端 %)
  const targetEtfPctStr = result.target_etf_weight !== null ? (result.target_etf_weight * 100).toFixed(0) : '—';
  const targetDefPctStr = result.target_cash_weight !== null ? (result.target_cash_weight * 100).toFixed(0) : '—';

  // 未實現損益合計（00631L＋債券，任一有值即顯示）
  const pnlParts = [result.unrealized_pnl, ...result.bond_plans.map((p) => p.unrealized_pnl)];
  const hasPnl = pnlParts.some((v) => v !== null);
  const totalPnl = pnlParts.reduce((s: number, v) => s + (v ?? 0), 0);
  const totalCost = (result.cost_basis ?? 0) + result.bond_plans.reduce((s, p) => s + (p.cost_basis ?? 0), 0);
  const totalPnlPct = totalCost > 0 ? totalPnl / totalCost : null;

  // 配置條顏色（現況/目標共用）：00631L 紅、現金 綠、00687B 深藍、00953B 紫；依佔比大→小排列
  const barSegments = (
    weights: { etf: number; cash: number; bonds: number[] },
    values: { etf: number; cash: number; bonds: number[] },
  ) =>
    [
      { w: weights.etf, v: values.etf, cls: 'bg-red-500', txt: 'text-red-400', label: '00631L' },
      { w: weights.cash, v: values.cash, cls: 'bg-emerald-500/80', txt: 'text-emerald-400', label: '現金' },
      { w: weights.bonds[0] ?? 0, v: values.bonds[0] ?? 0, cls: 'bg-blue-700', txt: 'text-blue-400', label: BOND_ETFS[0].code },
      { w: weights.bonds[1] ?? 0, v: values.bonds[1] ?? 0, cls: 'bg-violet-500/80', txt: 'text-violet-400', label: BOND_ETFS[1].code },
    ].sort((a, b) => b.w - a.w);

  const currentSegs = barSegments(
    {
      etf: result.etf_weight ?? 0,
      cash: result.cash_weight ?? 0,
      bonds: result.bond_plans.map((p) => p.weight ?? 0),
    },
    {
      etf: result.etf_value,
      cash: config.cash,
      bonds: result.bond_plans.map((p) => p.value),
    },
  );
  const targetSegs = barSegments(
    {
      etf: result.target_etf_weight ?? 0,
      cash: result.total_value > 0 && result.target_cash_value !== null ? result.target_cash_value / result.total_value : 0,
      bonds: result.bond_plans.map((p) =>
        result.total_value > 0 && p.target_value !== null ? p.target_value / result.total_value : 0,
      ),
    },
    {
      etf: result.target_etf_value ?? 0,
      cash: result.target_cash_value ?? 0,
      bonds: result.bond_plans.map((p) => p.target_value ?? 0),
    },
  );

  // 防守端調整項（現金＋兩檔債券）是否有實質動作或存在鎖定
  const hasDefensiveMoves =
    result.status !== 'empty' &&
    ((result.cash_adjust_delta !== null && Math.abs(result.cash_adjust_delta) >= 1) ||
      result.bond_plans.some((p) => p.value_delta !== null && Math.abs(p.value_delta) >= 1) ||
      config.locked?.cash ||
      Object.values(config.locked?.bonds || {}).some(Boolean));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 標題與簡介 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <SlidersHorizontal className="w-6 h-6 text-primary" />
            00631L「正2 + 防守端」再平衡計算機
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            透過 00631L（β≈2.0）與防守端（固定現金 ${config.cash_reserve.toLocaleString()} ＋ 債券池 {BOND_ETFS[0].code}:{BOND_ETFS[1].code}＝{Math.round(config.bond_split * 100)}:{Math.round((1 - config.bond_split) * 100)}，皆視為 β=0）控管投組風險。不擇時，僅於 Beta 偏離過大時進行高賣低買再平衡。
          </p>
        </div>
      </div>

      {/* 市場狀態 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-500" />
            TAIEX 市場狀態燈號
          </h2>
        </div>

        {marketStatusLoading && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            正在取得 TAIEX 市場狀態...
          </div>
        )}

        {marketStatusError && (
          <div className="text-xs text-zinc-500 py-2">
            市場狀態暫時無法取得
          </div>
        )}

        {!marketStatusLoading && !marketStatusError && marketStatus && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {marketStatus.tier === 0 && (
                <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-emerald-500/10 text-emerald-400">
                  正常
                </span>
              )}
              {marketStatus.tier === 1 && (
                <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-[#fab219]/20 text-[#fab219]">
                  第一警戒
                </span>
              )}
              {marketStatus.tier === 2 && (
                <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-[#e34948]/15 text-[#e34948]">
                  小股災
                </span>
              )}
              {marketStatus.tier === 3 && (
                <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-[#e34948] text-white">
                  股災來臨
                </span>
              )}

              <span className="text-xs text-zinc-300">
                TAIEX 自 {marketStatus.peak_date} 高點 {Math.round(marketStatus.peak_close).toLocaleString()} 回撤 {(marketStatus.drawdown * 100).toFixed(2)}%
                <span className="text-zinc-500 ml-2">(目前收盤: {Math.round(marketStatus.latest_close).toLocaleString()}，統計截止日: {marketStatus.latest_date})</span>
              </span>
            </div>

            {marketStatus.tier === 1 && (
              <p className="text-xs text-amber-500 font-medium bg-amber-500/10 p-3 rounded-lg border border-amber-500/20">
                已達第一警戒，純觀察，不需操作。
              </p>
            )}

            {marketStatus.tier === 2 && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-red-500/10 p-3 rounded-lg border border-red-500/20">
                <span className="text-xs text-red-400 font-medium">已達小股災門檻，建議加碼至中繼 β。</span>
                <button
                  onClick={() => updateConfig({ target_beta: config.beta_mid })}
                  className="px-3 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                >
                  套用中繼 β ({config.beta_mid.toFixed(2)})
                </button>
              </div>
            )}

            {marketStatus.tier === 3 && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-red-600/20 p-3 rounded-lg border border-red-500/40">
                  <span className="text-xs text-red-300 font-semibold">股災來臨！建議全力出清防守端拉滿槓桿。</span>
                  <button
                    onClick={() => updateConfig({ target_beta: config.etf_beta })}
                    className="px-3 py-1.5 text-xs font-semibold bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
                  >
                    套用股災滿倉 β ({config.etf_beta.toFixed(2)})
                  </button>
                </div>

                <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20 text-xs text-amber-500 space-y-1.5">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    股災應對操作提醒：
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-zinc-300 text-[11px] pl-1">
                    <li>防守端立即全數轉進 00631L（已按上方按鈕套用滿倉 β 即完成）</li>
                    <li>交易順序沿用增修K美債優先變現 waterfall（自動）</li>
                    <li>尊重 opt19 資產鎖定設定（若有鎖定，lock_note 會照常顯示）</li>
                    <li>需要的話可用「現金注入模式」補足（cash_injection_needed 照常顯示）</li>
                    <li>停止手動再平衡，抱到 TAIEX 創新高再回到平常的目標 β</li>
                    <li>創新高後依 bond_split 重建防守端（把 target_beta 滑桿改回平常數值即可觸發）</li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 主要控制與分析區：桌面雙欄，手機單欄 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左卡：Beta 儀表 + 滑桿 + 配置條 */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary" />
              PORTFOLIO BETA 儀表
            </h2>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors underline underline-offset-4"
            >
              {showAdvanced ? '隱藏進階設定' : '進階設定'}
            </button>
          </div>

          {/* 進階設定 (標的 Beta / 債券池分配) */}
          {showAdvanced && (
            <div className="p-3 bg-zinc-900/60 rounded-lg border border-zinc-800 text-xs space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-zinc-300 font-medium">00631L 標的槓桿 Beta</label>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="3.0"
                  value={config.etf_beta}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0) updateConfig({ etf_beta: v });
                  }}
                  className="w-20 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-right font-mono text-zinc-100 focus:outline-none focus:border-primary"
                />
              </div>
              <p className="text-[11px] text-zinc-500">預設 2.0 (元大台灣50正2)。一般無須修改。</p>
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/70">
                <label className="text-zinc-300 font-medium">債券池 {BOND_ETFS[0].code} 佔比</label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={Math.round(config.bond_split * 100)}
                    onChange={(e) => updateConfig({ bond_split: parseInt(e.target.value, 10) / 100 })}
                    className="w-24 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                  />
                  <span className="font-mono font-bold text-zinc-100 w-16 text-right">
                    {Math.round(config.bond_split * 100)}:{Math.round((1 - config.bond_split) * 100)}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-zinc-500 border-b border-zinc-800 pb-2">
                防守端扣掉保留現金後的債券池分配：{BOND_ETFS[0].code} {Math.round(config.bond_split * 100)}% / {BOND_ETFS[1].code} {Math.round((1 - config.bond_split) * 100)}%。預設 6:4。
              </p>

              {/* 三層門檻與中繼 Beta */}
              <div className="flex items-center justify-between pt-1">
                <label className="text-zinc-300 font-medium">第一警戒門檻 (黃)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1.0"
                  value={config.tier1_dd}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) updateConfig({ tier1_dd: v });
                  }}
                  className="w-20 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-right font-mono text-zinc-100 focus:outline-none focus:border-primary"
                />
              </div>
              <p className="text-[11px] text-zinc-500">TAIEX自高點回撤門檻。預設 0.10 (10%)。純提醒不操作。</p>

              <div className="flex items-center justify-between pt-1">
                <label className="text-zinc-300 font-medium">小股災門檻 (淡紅)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1.0"
                  value={config.tier2_dd}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) updateConfig({ tier2_dd: v });
                  }}
                  className="w-20 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-right font-mono text-zinc-100 focus:outline-none focus:border-primary"
                />
              </div>
              <p className="text-[11px] text-zinc-500">TAIEX自高點回撤門檻。預設 0.15 (15%)。一鍵加碼至中繼 β。</p>

              <div className="flex items-center justify-between pt-1">
                <label className="text-zinc-300 font-medium">股災確認門檻 (深紅)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1.0"
                  value={config.tier3_dd}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) updateConfig({ tier3_dd: v });
                  }}
                  className="w-20 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-right font-mono text-zinc-100 focus:outline-none focus:border-primary"
                />
              </div>
              <p className="text-[11px] text-zinc-500">TAIEX自高點回撤門檻。預設 0.20 (20%)。一鍵出清防守端滿倉。</p>

              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/70">
                <label className="text-zinc-300 font-medium">小股災中繼目標 β</label>
                <input
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="3.0"
                  value={config.beta_mid}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0) updateConfig({ beta_mid: v });
                  }}
                  className="w-20 px-2 py-1 bg-zinc-950 border border-zinc-800 rounded text-right font-mono text-zinc-100 focus:outline-none focus:border-primary"
                />
              </div>
              <p className="text-[11px] text-zinc-500">小股災觸發時，供一鍵加碼套用的目標投組 β。預設 1.75。</p>
            </div>
          )}

          {/* 半圓儀表 */}
          <BetaGauge
            currentBeta={result.current_beta}
            targetBeta={config.target_beta}
            lowerBand={result.lower_band}
            upperBand={result.upper_band}
            etfBeta={config.etf_beta}
          />

          {/* 目標 Beta 滑桿 */}
          <div className="space-y-2 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300">目標投組 Beta</span>
              <span className="font-mono font-semibold text-primary">
                {config.target_beta.toFixed(2)}X
                <span className="text-zinc-400 font-normal ml-2">
                  (＝ 00631L {targetEtfPctStr}% / 防守端 {targetDefPctStr}%)
                </span>
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="2.0"
              step="0.05"
              value={config.target_beta}
              onChange={(e) => updateConfig({ target_beta: parseFloat(e.target.value) })}
              className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary"
            />
            <div className="flex justify-between text-[10px] text-zinc-500 font-mono px-0.5">
              <span>0.0X (100%防守)</span>
              <span>1.0X (50/50)</span>
              <span>1.3X (預設)</span>
              <span>2.0X (全正2)</span>
            </div>
          </div>

          {/* 配置比例條 */}
          <div className="space-y-3 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-zinc-300">資產配置比例對比</div>
              <div className="text-[10px] font-mono text-zinc-500">總資產 ${Math.round(result.total_value).toLocaleString()}</div>
            </div>

            {/* 目前配比 */}
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-400">目前實況</div>
              <div className="grid grid-cols-4 gap-1.5">
                {currentSegs.map((s) => (
                  <div key={s.label} className="text-center">
                    <div className={`text-[10px] font-medium ${s.txt}`}>{s.label}</div>
                    <div className="font-mono text-xs font-bold text-zinc-100 leading-tight">${Math.round(s.v).toLocaleString()}</div>
                    <div className="text-[10px] text-zinc-500">{(s.w * 100).toFixed(1)}%</div>
                  </div>
                ))}
              </div>
              <div className="h-3 w-full bg-zinc-800 rounded-full overflow-hidden flex">
                {currentSegs.map((s) => (
                  <div
                    key={s.label}
                    className={`${s.cls} h-full transition-all duration-300`}
                    style={{ width: `${s.w * 100}%` }}
                    title={`${s.label}: ${(s.w * 100).toFixed(1)}%（$${Math.round(s.v).toLocaleString()}）`}
                  />
                ))}
              </div>
            </div>

            {/* 目標配比 */}
            <div className="space-y-1.5">
              <div className="text-[11px] text-zinc-400">目標配置</div>
              <div className="grid grid-cols-4 gap-1.5">
                {targetSegs.map((s) => (
                  <div key={s.label} className="text-center">
                    <div className={`text-[10px] font-medium ${s.txt}`}>{s.label}</div>
                    <div className="font-mono text-xs font-bold text-zinc-100 leading-tight">${Math.round(s.v).toLocaleString()}</div>
                    <div className="text-[10px] text-zinc-500">{(s.w * 100).toFixed(1)}%</div>
                  </div>
                ))}
              </div>
              <div className="h-3 w-full bg-zinc-800/80 rounded-full overflow-hidden flex border border-zinc-700/50">
                {targetSegs.map((s) => (
                  <div
                    key={s.label}
                    className={`${s.cls} opacity-50 h-full transition-all duration-300`}
                    style={{ width: `${s.w * 100}%` }}
                    title={`${s.label}: ${(s.w * 100).toFixed(1)}%（$${Math.round(s.v).toLocaleString()}）`}
                  />
                ))}
              </div>
            </div>

            {/* 圖例 */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />00631L</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/80 inline-block" />現金</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-700 inline-block" />{BOND_ETFS[0].code} {BOND_ETFS[0].name}</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-500/80 inline-block" />{BOND_ETFS[1].code} {BOND_ETFS[1].name}</span>
            </div>
          </div>

          {/* 觸發價帶：持倉不動下，β 落在容忍區間對應的 00631L 價格上下界 */}
          <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3">
            <div className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
              <SlidersHorizontal className="w-4 h-4 text-primary" />
              觸發價帶（持倉不動、只看 00631L 價格）
            </div>
            {result.sell_trigger_price === null && result.buy_trigger_price === null ? (
              <p className="text-xs text-zinc-500 leading-relaxed">
                目前持倉無可反解的觸發價
                {result.defensive_value <= 0
                  ? '（防守端為 0，投組 Beta 恆等於滿槓桿，與價格無關）'
                  : config.shares <= 0
                    ? '（尚無 00631L 持股）'
                    : '（容忍區間超出 0～滿槓桿可達範圍）'}
                。
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {/* 買進門檻＝下限 β 對應價（低於它就進買進區） */}
                  <div className="rounded-lg px-3 py-3 bg-bear/10 border border-bear/25 text-center">
                    <div className="text-[11px] text-zinc-400">買進門檻（β&lt;{result.lower_band.toFixed(2)}）</div>
                    {result.buy_trigger_price !== null ? (
                      <>
                        <div className="text-2xl font-extrabold font-mono tracking-tight text-bear mt-0.5">
                          ${result.buy_trigger_price.toFixed(2)}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">價格低於此 → 買進區</div>
                      </>
                    ) : (
                      <div className="text-sm text-zinc-600 mt-2">—<div className="text-[10px] font-normal">下限 β≤0，跌不觸發</div></div>
                    )}
                  </div>
                  {/* 賣出門檻＝上限 β 對應價（高於它就進賣出區） */}
                  <div className="rounded-lg px-3 py-3 bg-bull/10 border border-bull/25 text-center">
                    <div className="text-[11px] text-zinc-400">賣出門檻（β&gt;{result.upper_band.toFixed(2)}）</div>
                    {result.sell_trigger_price !== null ? (
                      <>
                        <div className="text-2xl font-extrabold font-mono tracking-tight text-bull mt-0.5">
                          ${result.sell_trigger_price.toFixed(2)}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">價格高於此 → 賣出區</div>
                      </>
                    ) : (
                      <div className="text-sm text-zinc-600 mt-2">—<div className="text-[10px] font-normal">上限 β≥{config.etf_beta.toFixed(1)}，漲不觸發</div></div>
                    )}
                  </div>
                </div>

                {/* 目前價格落在哪一區 */}
                {config.price > 0 && result.status !== 'empty' && (
                  <div className={`text-[11px] text-center rounded-md py-1.5 border ${priceZone.cls}`}>
                    目前 00631L <span className="font-mono font-semibold">${config.price.toFixed(2)}</span> → 位於 <strong>{priceZone.label}</strong>
                  </div>
                )}

                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  以目前持股 <span className="font-mono text-zinc-400">{config.shares ? Math.round(config.shares).toLocaleString() : 0}</span> 股、防守端（現金＋債券市值）<span className="font-mono text-zinc-400">${Math.round(result.defensive_value).toLocaleString()}</span> <strong className="text-zinc-400">固定不動</strong>推算：只靠 00631L 漲跌，價格落在
                  {result.buy_trigger_price !== null && result.sell_trigger_price !== null ? (
                    <> <span className="font-mono text-zinc-300">${result.buy_trigger_price.toFixed(2)}～${result.sell_trigger_price.toFixed(2)}</span></>
                  ) : ' 門檻之間'} 時 β 才在容忍區間內。
                  {result.status === 'buy' && '目前現價遠低於買進門檻＝部位偏防守、β 太低，已在買進區（見上方建議買進金額）。'}
                  {result.status === 'sell' && '目前現價已高於賣出門檻＝部位偏槓桿、β 太高，已在賣出區（見上方建議賣出金額）。'}
                  <strong className="text-zinc-400"> 注意這是「持倉不動」的假設</strong>——你一旦依建議買/賣，持股與防守端改變，這條價帶會整個重算（債券價格波動也會微調 β，但幅度遠小於正2）。
                </p>
              </>
            )}
          </div>
        </div>

        {/* 右卡：偏離分析 & 再平衡建議面板 */}
        <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-6 flex flex-col justify-between">
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-border/60 pb-3">
              <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                偏離分析 & 再平衡建議
              </h2>
              {/* 狀態 Pill */}
              <div>
                {result.status === 'empty' && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 flex items-center gap-1">
                    <Info className="w-3.5 h-3.5" /> 尚未輸入持倉
                  </span>
                )}
                {result.status === 'normal' && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 正常範圍
                  </span>
                )}
                {result.status === 'sell' && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-bull/10 text-bull border border-bull/20 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 已破上限 (建議賣出)
                  </span>
                )}
                {result.status === 'buy' && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-bear/10 text-bear border border-bear/20 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> 已破下限 (建議買進)
                  </span>
                )}
              </div>
            </div>

            {/* 容忍區間設定 & 區間指標 */}
            <div className="bg-zinc-950/40 p-4 rounded-lg border border-border/50 space-y-3">
              <div className="flex items-center justify-between text-xs gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-zinc-300 font-medium">容忍區間</label>
                  {/* 模式切換：±β / ±% */}
                  <div className="flex rounded-md overflow-hidden border border-zinc-700 text-[11px]">
                    <button
                      onClick={() => updateConfig({ tolerance_mode: 'abs' })}
                      className={`px-2 py-1 font-medium transition-colors ${config.tolerance_mode === 'abs' ? 'bg-primary text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                    >
                      ±β
                    </button>
                    <button
                      onClick={() => updateConfig({ tolerance_mode: 'pct' })}
                      className={`px-2 py-1 font-medium transition-colors ${config.tolerance_mode === 'pct' ? 'bg-primary text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                    >
                      ±%
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {config.tolerance_mode === 'abs' ? (
                    <>
                      <input
                        type="range"
                        min="0.05"
                        max="1"
                        step="0.05"
                        value={config.threshold_abs}
                        onChange={(e) => updateConfig({ threshold_abs: parseFloat(e.target.value) })}
                        className="w-24 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                      />
                      <span className="font-mono font-bold text-zinc-100 w-12 text-right">±{config.threshold_abs.toFixed(2)}</span>
                    </>
                  ) : (
                    <>
                      <input
                        type="range"
                        min="1"
                        max="30"
                        step="1"
                        value={config.threshold_pct}
                        onChange={(e) => updateConfig({ threshold_pct: parseInt(e.target.value, 10) })}
                        className="w-24 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                      />
                      <span className="font-mono font-bold text-zinc-100 w-12 text-right">±{config.threshold_pct}%</span>
                    </>
                  )}
                </div>
              </div>

              {/* 上下限 Beta 數據 */}
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-800/60 text-center font-mono">
                <div className="p-2 rounded bg-zinc-900/80">
                  <div className="text-[10px] text-zinc-500">下限 Beta (買點)</div>
                  <div className="text-sm font-bold text-bear mt-0.5">{result.lower_band.toFixed(2)}X</div>
                </div>
                <div className="p-2 rounded bg-zinc-900/80">
                  <div className="text-[10px] text-zinc-500">目標 Beta</div>
                  <div className="text-sm font-bold text-zinc-200 mt-0.5">{config.target_beta.toFixed(2)}X</div>
                </div>
                <div className="p-2 rounded bg-zinc-900/80">
                  <div className="text-[10px] text-zinc-500">上限 Beta (賣點)</div>
                  <div className="text-sm font-bold text-bull mt-0.5">{result.upper_band.toFixed(2)}X</div>
                </div>
              </div>
            </div>

            {/* 偏離分析指標 */}
            <div className="grid grid-cols-2 gap-3 font-mono">
              <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800">
                <div className="text-xs text-zinc-400">Beta 絕對偏離量</div>
                <div className="text-lg font-bold text-zinc-100 mt-1">
                  {result.deviation_abs !== null
                    ? `${result.deviation_abs >= 0 ? '+' : ''}${result.deviation_abs.toFixed(3)}`
                    : '—'}
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900/40 border border-zinc-800">
                <div className="text-xs text-zinc-400">相對偏離比例</div>
                <div className="text-lg font-bold text-zinc-100 mt-1">
                  {result.deviation_pct !== null
                    ? `${result.deviation_pct >= 0 ? '+' : ''}${(result.deviation_pct * 100).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
            </div>

            {/* 建議區塊 */}
            <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 space-y-3">
              <div className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
                <ArrowRightLeft className="w-4 h-4 text-primary" />
                觸發狀態 & 執行建議
              </div>
              <div className="text-sm font-medium text-zinc-100 leading-relaxed">
                {result.action_label}
              </div>

              {/* 防守端有資產鎖定、既有資金不足以達標時：需先從外部注入新現金，全額用於買進00631L */}
              {result.cash_injection_needed !== null && result.cash_injection_needed >= 1 && (
                <div className="rounded-lg px-4 py-3 text-center bg-primary/10 border border-primary/30">
                  <div className="text-[11px] text-zinc-400 flex items-center justify-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-primary" />
                    步驟① 需先注入新現金（防守端已鎖定資產不足以支應）
                  </div>
                  <div className="text-2xl font-extrabold font-mono tracking-tight mt-0.5 text-primary">
                    ${Math.round(result.cash_injection_needed).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    不動用鎖定資產，這筆錢會全額用於下方步驟② 買進 00631L
                  </div>
                </div>
              )}

              {/* 顯眼行動數字：目前配置要搬多少錢回目標 β */}
              {result.status !== 'empty' && result.etf_value_delta !== null && Math.abs(result.etf_value_delta) >= 1 && (
                <div
                  className={`rounded-lg px-4 py-3 text-center ${
                    result.etf_value_delta > 0
                      ? 'bg-bear/10 border border-bear/25'
                      : 'bg-bull/10 border border-bull/25'
                  }`}
                >
                  <div className="text-[11px] text-zinc-400">
                    {result.cash_injection_needed !== null && result.cash_injection_needed >= 1 && '步驟② '}
                    {result.etf_value_delta > 0 ? '應買進 00631L' : '應賣出 00631L'}
                  </div>
                  <div className={`text-2xl font-extrabold font-mono tracking-tight mt-0.5 ${result.etf_value_delta > 0 ? 'text-bear' : 'text-bull'}`}>
                    ${Math.abs(Math.round(result.etf_value_delta)).toLocaleString()}
                  </div>
                  {result.trade_shares !== null && (
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      約 {Math.abs(result.trade_shares).toLocaleString()} 股
                      {result.etf_value_delta > 0
                        ? '（動用防守端資金）'
                        : '（轉回防守端）'}
                    </div>
                  )}
                  {renderBreakdown('etf')}
                </div>
              )}

              {result.lock_note && (
                <div
                  className={`text-xs font-medium font-mono leading-normal rounded-lg px-3 py-2 mt-2 flex items-start gap-1 ${
                    result.lock_capped
                      ? 'text-amber-400 bg-amber-500/5 border border-amber-500/20'
                      : 'text-primary bg-primary/5 border border-primary/20'
                  }`}
                >
                  <span>{result.lock_capped ? '⚠' : 'ℹ'}</span>
                  <span>{result.lock_note}</span>
                </div>
              )}

              {/* 【增修I】防守端配置：固定現金 + 債券池 6:4 的應買賣 */}
              {hasDefensiveMoves && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {/* 現金調整 */}
                  <div className="rounded-lg px-3 py-2.5 bg-emerald-500/5 border border-emerald-500/20 text-center">
                    <div className="text-[10px] text-zinc-400 flex items-center justify-center gap-1">
                      <span>現金（保留 ${config.cash_reserve.toLocaleString()}）</span>
                      {config.locked?.cash && (
                        <span className="inline-flex items-center gap-0.5 text-zinc-500">
                          <Lock className="w-3 h-3 text-primary" />
                          <span>已鎖定</span>
                        </span>
                      )}
                    </div>
                    <div className="text-base font-extrabold font-mono text-emerald-400 mt-0.5">
                      {result.cash_adjust_delta !== null && Math.abs(result.cash_adjust_delta) >= 1
                        ? `${result.cash_adjust_delta > 0 ? '+' : '−'}$${Math.abs(Math.round(result.cash_adjust_delta)).toLocaleString()}`
                        : '維持'}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      目標 ${result.target_cash_value !== null ? Math.round(result.target_cash_value).toLocaleString() : '—'}
                    </div>
                    {renderBreakdown('cash')}
                  </div>
                  {/* 債券兩檔 */}
                  {result.bond_plans.map((p) => {
                    const isBuy = (p.value_delta ?? 0) > 0;
                    const active = p.value_delta !== null && Math.abs(p.value_delta) >= 1;
                    return (
                      <div
                        key={p.code}
                        className={`rounded-lg px-3 py-2.5 text-center border ${
                          !active
                            ? 'bg-zinc-900/40 border-zinc-800'
                            : isBuy
                              ? 'bg-bear/10 border-bear/25'
                              : 'bg-bull/10 border-bull/25'
                        }`}
                      >
                        <div className="text-[10px] text-zinc-400 flex items-center justify-center gap-1 flex-wrap">
                          <span>{active ? (isBuy ? '應買進 ' : '應賣出 ') : ''}{p.code} {assetName(p.code)}</span>
                          {config.locked?.bonds?.[p.code] && (
                            <span className="inline-flex items-center gap-0.5 text-zinc-500">
                              <Lock className="w-3 h-3 text-primary" />
                              <span>已鎖定</span>
                            </span>
                          )}
                        </div>
                        <div className={`text-base font-extrabold font-mono mt-0.5 ${!active ? 'text-zinc-500' : isBuy ? 'text-bear' : 'text-bull'}`}>
                          {p.value_delta !== null ? (active ? `$${Math.abs(Math.round(p.value_delta)).toLocaleString()}` : '維持') : '—'}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          {p.trade_shares !== null && active
                            ? `約 ${Math.abs(p.trade_shares).toLocaleString()} 股 @ $${p.price.toFixed(2)}`
                            : p.price <= 0
                              ? '填入現價才能換算股數'
                              : `目標 $${p.target_value !== null ? Math.round(p.target_value).toLocaleString() : '—'}`}
                        </div>
                        {renderBreakdown(p.code)}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 精確達標試算 (永遠顯示) */}
              <div className="pt-2 border-t border-zinc-800/80 text-xs space-y-1.5 text-zinc-300">
                <div className="text-zinc-400 font-medium">🎯 若要精確重置至目標 β ({config.target_beta.toFixed(2)}X)＋防守端配置：</div>
                {result.note && result.status !== 'empty' ? (
                  <div className="text-amber-400 font-mono">{result.note}</div>
                ) : result.etf_value_delta !== null ? (
                  <div className="space-y-1 font-mono pl-2 border-l-2 border-primary/40">
                    {result.cash_injection_needed !== null && result.cash_injection_needed >= 1 && (
                      <div>
                        • 注入新現金：
                        <span className="text-primary font-bold">
                          ${Math.round(result.cash_injection_needed).toLocaleString()}
                        </span>
                        <span className="text-zinc-400 font-normal">（防守端鎖定資產不足，需額外注入）</span>
                      </div>
                    )}
                    <div>
                      • 00631L 調整：
                      <span className={result.etf_value_delta > 0 ? 'text-bear font-bold' : result.etf_value_delta < 0 ? 'text-bull font-bold' : 'text-zinc-300'}>
                        {result.etf_value_delta > 0 ? '買進 ' : result.etf_value_delta < 0 ? '賣出 ' : ''}
                        ${Math.abs(Math.round(result.etf_value_delta)).toLocaleString()}
                      </span>
                      {result.trade_shares !== null && (
                        <span className="text-zinc-400 font-normal">
                          （約 {Math.abs(result.trade_shares).toLocaleString()} 股）
                        </span>
                      )}
                    </div>
                    <div>
                      • 現金調整至 ${result.target_cash_value !== null ? Math.round(result.target_cash_value).toLocaleString() : '—'}：
                      <span className={result.cash_adjust_delta !== null && result.cash_adjust_delta > 0 ? 'text-emerald-400 font-bold' : result.cash_adjust_delta !== null && result.cash_adjust_delta < 0 ? 'text-amber-400 font-bold' : 'text-zinc-300'}>
                        {result.cash_adjust_delta !== null && result.cash_adjust_delta > 0 ? '+ $' : result.cash_adjust_delta !== null && result.cash_adjust_delta < 0 ? '- $' : '$'}
                        {result.cash_adjust_delta !== null ? Math.abs(Math.round(result.cash_adjust_delta)).toLocaleString() : '0'}
                      </span>
                    </div>
                    {result.bond_plans.map((p) => (
                      <div key={p.code}>
                        • {p.code} 調整：
                        <span className={p.value_delta !== null && p.value_delta > 0 ? 'text-bear font-bold' : p.value_delta !== null && p.value_delta < 0 ? 'text-bull font-bold' : 'text-zinc-300'}>
                          {p.value_delta !== null && p.value_delta > 0 ? '買進 ' : p.value_delta !== null && p.value_delta < 0 ? '賣出 ' : ''}
                          ${p.value_delta !== null ? Math.abs(Math.round(p.value_delta)).toLocaleString() : '0'}
                        </span>
                        {p.trade_shares !== null ? (
                          <span className="text-zinc-400 font-normal">（約 {Math.abs(p.trade_shares).toLocaleString()} 股）</span>
                        ) : p.price <= 0 && p.value_delta !== null && Math.abs(p.value_delta) >= 1 ? (
                          <span className="text-amber-400 font-normal">（缺現價）</span>
                        ) : null}
                      </div>
                    ))}
                    {result.post_beta !== null && (
                      <div className="text-[11px] text-zinc-500 font-sans mt-1">
                        * 整股成交後實況：持有 00631L {result.post_shares?.toLocaleString()} 股，投組 Beta 將回歸至 <strong className="text-zinc-300 font-mono">{result.post_beta.toFixed(2)}X</strong>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-zinc-500 italic">無可用數值</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 下方：持倉現況面板（股數/均價為報價單累算的衍生值，唯讀） */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center justify-between border-b border-border/60 pb-3">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            持倉現況（00631L ＋ 防守端：現金 + {BOND_ETFS[0].code} + {BOND_ETFS[1].code}）
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void syncToCloud(config)}
              disabled={cloud.status === 'syncing' || cloud.status === 'loading'}
              className="text-[11px] text-primary hover:text-primary/80 disabled:text-zinc-600 flex items-center gap-1 transition-colors font-normal"
              title="把目前設定（目標Beta、容忍度、鎖定狀態等）同步到雲端，之後任何裝置重開都不會跑掉"
            >
              {cloud.status === 'syncing' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <UploadCloud className="w-3 h-3" />
              )}
              狀態同步
            </button>
            <button
              onClick={fetchAllPrices}
              disabled={ASSETS.some((a) => priceFetch[a.code]?.loading)}
              className="text-[11px] text-primary hover:text-primary/80 disabled:text-zinc-600 flex items-center gap-1 transition-colors font-normal"
              title="抓取全部標的現在最新價（即時報價）"
            >
              {ASSETS.some((a) => priceFetch[a.code]?.loading) ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              全部抓最新價
            </button>
          </div>
        </h2>

        {(cloud.status === 'saved' || cloud.status === 'error') && (
          <div className="text-[11px] flex items-center gap-1.5 -mt-2">
            {cloud.status === 'saved' && (
              <span className="text-emerald-400 flex items-center gap-1">
                <Cloud className="w-3.5 h-3.5" />
                {cloud.savedAt
                  ? `已同步雲端 ${new Date(cloud.savedAt).toLocaleTimeString('zh-TW', { hour12: false })}`
                  : cloud.msg || '已同步雲端'}
              </span>
            )}
            {cloud.status === 'error' && (
              <span className="text-amber-400 flex items-center gap-1"><CloudOff className="w-3.5 h-3.5" /> {cloud.msg || '雲端同步失敗（已存本機）'}</span>
            )}
          </div>
        )}

        {/* 各標的持倉列 */}
        <div className="space-y-3">
          {ASSETS.map((a) => {
            const isEtf = a.code === ETF_CODE;
            const shares = isEtf ? config.shares : config.bonds.find((b) => b.code === a.code)?.shares ?? 0;
            const avgCost = isEtf ? config.avg_cost : config.bonds.find((b) => b.code === a.code)?.avg_cost ?? 0;
            const price = assetPrice(config, a.code);
            const fetchSt = priceFetch[a.code] ?? { loading: false, error: null, date: null };
            return (
              <div key={a.code} className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-zinc-200 font-mono">
                    {a.code} <span className="text-zinc-400 font-sans font-normal">{a.name}</span>
                    {!isEtf && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-sans">防守端 β≈0</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    {!isEtf && (
                      <button
                        onClick={() => {
                          const isLocked = config.locked?.bonds?.[a.code] === true;
                          applyConfig({
                            locked: {
                              ...config.locked,
                              bonds: {
                                ...config.locked?.bonds,
                                [a.code]: !isLocked,
                              },
                            },
                          });
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors ${
                          config.locked?.bonds?.[a.code]
                            ? 'bg-bull/15 border-bull text-bull shadow-sm shadow-bull/20'
                            : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                        title={config.locked?.bonds?.[a.code] ? '解鎖資產' : '鎖定資產'}
                      >
                        {config.locked?.bonds?.[a.code] ? (
                          <Lock className="w-4 h-4" />
                        ) : (
                          <Unlock className="w-4 h-4" />
                        )}
                        <span>{config.locked?.bonds?.[a.code] ? '已鎖定' : '未鎖'}</span>
                      </button>
                    )}
                    <button
                      onClick={() => void fetchLatestPrice(a.code)}
                      disabled={fetchSt.loading}
                      className="text-[11px] text-primary hover:text-primary/80 disabled:text-zinc-600 flex items-center gap-1 transition-colors"
                      title="抓取現在最新價（即時報價）"
                    >
                      {fetchSt.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      {fetchSt.loading ? '抓取中' : '抓最新價'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-500">持有股數（衍生）</label>
                    <div className="relative">
                      <input
                        type="text"
                        readOnly
                        value={shares ? Math.round(shares).toLocaleString() : '0'}
                        className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-300 cursor-not-allowed pr-8"
                      />
                      <span className="absolute right-2.5 top-2.5 text-xs text-zinc-500 font-mono">股</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-500">平均成本（衍生）</label>
                    <div className="relative">
                      <input
                        type="text"
                        readOnly
                        value={avgCost ? avgCost.toFixed(2) : '—'}
                        className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-300 cursor-not-allowed pr-8"
                      />
                      <span className="absolute right-2.5 top-2.5 text-xs text-zinc-500 font-mono">元</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-500">現價（可抓取/手動）</label>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder={isEtf ? '例如: 38.8' : '例如: 28.0'}
                        value={priceStrs[a.code] ?? ''}
                        onChange={(e) => handlePriceChange(a.code, e.target.value)}
                        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-8"
                      />
                      <span className="absolute right-2.5 top-2.5 text-xs text-zinc-500 font-mono">元</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-500">市值</label>
                    <div className="px-3 py-2 rounded-lg bg-zinc-900/40 border border-zinc-800/60 font-mono text-sm text-right">
                      <span className={isEtf ? 'text-blue-400 font-bold' : 'text-cyan-400 font-bold'}>
                        ${Math.round(shares * price).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
                <p className="text-[10px] leading-tight mt-1.5 h-3">
                  {fetchSt.error ? (
                    <span className="text-amber-400">抓取失敗：{fetchSt.error}（可手動輸入）</span>
                  ) : fetchSt.date ? (
                    <span className="text-zinc-600">已帶入即時報價（{fetchSt.date}）</span>
                  ) : (
                    <span className="text-zinc-600">&nbsp;</span>
                  )}
                </p>
              </div>
            );
          })}
        </div>

        {/* 現金列：閒置現金（可手動覆寫，底層仍反解回期初現金）＋現金保留額（可調） */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">閒置現金 (TWD)</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="1000"
                value={cashStr}
                onChange={(e) => handleCashChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] leading-tight">
              {agg.cash < 0 ? (
                <span className="text-amber-400">⚠ 買進金額已超過期初現金 ${Math.abs(Math.round(agg.cash)).toLocaleString()}，以 0 計算——可直接在此改回正確金額</span>
              ) : (
                <span className="text-zinc-600">預設由期初現金＋報價單累算（買進扣、賣出加），可直接在此手動覆寫</span>
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <label className="text-xs font-medium text-zinc-300">現金保留額（固定保留、不投入債券）</label>
              <button
                onClick={() => {
                  applyConfig({
                    locked: {
                      ...config.locked,
                      cash: !config.locked?.cash,
                    },
                  });
                }}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors ${
                  config.locked?.cash
                    ? 'bg-bull/15 border-bull text-bull shadow-sm shadow-bull/20'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                }`}
                title={config.locked?.cash ? '解鎖現金' : '鎖定現金'}
              >
                {config.locked?.cash ? (
                  <Lock className="w-4 h-4" />
                ) : (
                  <Unlock className="w-4 h-4" />
                )}
                <span>{config.locked?.cash ? '已鎖定' : '未鎖'}</span>
              </button>
            </div>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="10000"
                placeholder="例如: 100000"
                value={cashReserveStr}
                onChange={(e) => handleCashReserveChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] text-zinc-600 leading-tight">
              防守端先保留這筆現金；加碼 00631L 需要抽錢時優先賣 {BOND_ETFS[0].code}（美債），賣完才動 {BOND_ETFS[1].code}（保留月配息）。
              獲利了結回補時依 {Math.round(config.bond_split * 100)}:{Math.round((1 - config.bond_split) * 100)} 配到 {BOND_ETFS[0].code}/{BOND_ETFS[1].code}。
            </p>
          </div>
        </div>

        {/* 資產試算小結 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3 border-t border-zinc-800/80">
          <div className="flex flex-col justify-between px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60 gap-1">
            <span className="text-xs text-zinc-400">00631L 市值</span>
            <span className="font-mono font-bold text-blue-400 text-base">
              ${Math.round(result.etf_value).toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col justify-between px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60 gap-1">
            <span className="text-xs text-zinc-400">防守端（現金＋債券）</span>
            <span className="font-mono font-bold text-emerald-400 text-base">
              ${Math.round(result.defensive_value).toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col justify-between px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60 gap-1">
            <span className="text-xs text-zinc-400">未實現損益（含債券）</span>
            {hasPnl ? (
              <span className={`font-mono font-bold text-base ${totalPnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {totalPnl >= 0 ? '+' : '−'}${Math.abs(Math.round(totalPnl)).toLocaleString()}
                {totalPnlPct !== null && (
                  <span className="text-xs font-normal ml-1">
                    ({totalPnlPct >= 0 ? '+' : '−'}{Math.abs(totalPnlPct * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            ) : (
              <span className="font-mono text-zinc-600 text-sm">填期初成本或買進</span>
            )}
          </div>
          <div className="flex flex-col justify-between px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60 gap-1">
            <span className="text-xs text-zinc-400">投組總資產現值</span>
            <span className="font-mono font-extrabold text-zinc-100 text-lg">
              ${Math.round(result.total_value).toLocaleString()}
            </span>
          </div>
        </div>

        {/* 送出並同步雲端 */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-zinc-800/80">
          <div className="text-[11px] flex items-center gap-1.5 min-h-[18px]">
            {cloud.status === 'loading' && (
              <span className="text-zinc-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 雲端載入中…</span>
            )}
            {cloud.status === 'syncing' && (
              <span className="text-primary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 同步中…</span>
            )}
            {cloud.status === 'saved' && (
              <span className="text-emerald-400 flex items-center gap-1">
                <Cloud className="w-3.5 h-3.5" />
                {cloud.savedAt
                  ? `已同步雲端 ${new Date(cloud.savedAt).toLocaleTimeString('zh-TW', { hour12: false })}`
                  : cloud.msg || '已同步雲端'}
              </span>
            )}
            {cloud.status === 'error' && (
              <span className="text-amber-400 flex items-center gap-1"><CloudOff className="w-3.5 h-3.5" /> {cloud.msg || '雲端同步失敗（已存本機）'}</span>
            )}
            {cloud.status === 'idle' && cloud.msg && (
              <span className="text-zinc-500 flex items-center gap-1"><Cloud className="w-3.5 h-3.5" /> {cloud.msg}</span>
            )}
          </div>
          <button
            onClick={() => void syncToCloud(config)}
            disabled={cloud.status === 'syncing' || cloud.status === 'loading'}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {cloud.status === 'syncing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            送出並同步雲端
          </button>
        </div>
      </div>

      {/* 買賣報價單（交易紀錄，自動累算回填持倉、送出即同步雲端） */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-5">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center justify-between border-b border-border/60 pb-3">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            買賣報價單
          </span>
          <span className="text-xs text-zinc-500 font-normal">每筆買/賣自動累算各標的股數與加權平均成本，新增即同步雲端</span>
        </h2>

        {/* 期初部位（多資產） */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
            期初／建倉部位
            <span className="text-[10px] text-zinc-600 font-normal">（開始記帳前已持有的部位與現金，之後的買賣疊在其上）</span>
          </div>
          <div className="space-y-2">
            {ASSETS.map((a) => (
              <div key={a.code} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div className="text-xs font-mono text-zinc-300 sm:pb-2">
                  {a.code} <span className="text-zinc-500 font-sans">{a.name}</span>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-zinc-500">期初股數</label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder={a.code === ETF_CODE ? '例如: 19000' : '0'}
                      value={openStrs[a.code]?.shares ?? ''}
                      onChange={(e) => handleOpenChange(a.code, 'shares', e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-12"
                    />
                    <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">股</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-zinc-500">期初平均成本</label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={a.code === ETF_CODE ? '例如: 35.37' : '0'}
                      value={openStrs[a.code]?.avg ?? ''}
                      onChange={(e) => handleOpenChange(a.code, 'avg', e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
                    />
                    <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
                  </div>
                </div>
              </div>
            ))}
            {/* 期初現金【增修H】：閒置現金改由此累算（任一標的買進扣、賣出加） */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end pt-1 border-t border-zinc-800/50">
              <div className="text-xs text-zinc-300 sm:pb-2">期初現金 <span className="text-zinc-500">（記帳起點的閒置資金）</span></div>
              <div className="space-y-1 sm:col-span-2">
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    placeholder="例如: 1000000"
                    value={openCashStr}
                    onChange={(e) => handleOpenCashChange(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
                  />
                  <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
                </div>
              </div>
            </div>
          </div>

          {/* 建倉完成後一鍵儲存並同步雲端（期初部位輸入時已即時存本機，此鈕用來確保雲端拿到最新版） */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
            <div className="text-[11px] flex items-center gap-1.5 min-h-[16px] order-2 sm:order-1">
              {cloud.status === 'syncing' && (
                <span className="text-primary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 同步中…</span>
              )}
              {cloud.status === 'saved' && (
                <span className="text-emerald-400 flex items-center gap-1">
                  <Cloud className="w-3.5 h-3.5" />
                  {cloud.savedAt
                    ? `已同步雲端 ${new Date(cloud.savedAt).toLocaleTimeString('zh-TW', { hour12: false })}`
                    : cloud.msg || '已同步雲端'}
                </span>
              )}
              {cloud.status === 'error' && (
                <span className="text-amber-400 flex items-center gap-1"><CloudOff className="w-3.5 h-3.5" /> {cloud.msg || '雲端同步失敗（已存本機）'}</span>
              )}
            </div>
            <button
              onClick={() => void syncToCloud(config)}
              disabled={cloud.status === 'syncing' || cloud.status === 'loading'}
              className="order-1 sm:order-2 inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cloud.status === 'syncing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
              建倉完成，儲存並同步
            </button>
          </div>

          {/* 真實同步（玉山證券）：桌面/手機皆可點，實際執行在家中電腦（self-hosted runner） */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-3 mt-1 border-t border-zinc-800/50">
            <div className="text-[11px] text-zinc-500">
              從玉山證券真實帳戶抓庫存/現金，覆蓋上面期初部位（本機電腦需開機並登入）
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[11px] flex items-center gap-1.5 min-h-[16px]">
                {(realSync.status === 'triggering' || realSync.status === 'waiting') && (
                  <span className="text-primary flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {realSync.status === 'triggering' ? '觸發中…' : '本機執行中…'}
                  </span>
                )}
                {realSync.status === 'done' && (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <Cloud className="w-3.5 h-3.5" />
                    已更新真實持倉{realSync.msg ? ` ${new Date(realSync.msg).toLocaleTimeString('zh-TW', { hour12: false })}` : ''}
                  </span>
                )}
                {(realSync.status === 'timeout' || realSync.status === 'error') && (
                  <span className="text-amber-400 flex items-center gap-1">
                    <CloudOff className="w-3.5 h-3.5" /> {realSync.msg || '同步失敗'}
                  </span>
                )}
              </div>
              <button
                onClick={() => void syncRealHoldings()}
                disabled={realSync.status === 'triggering' || realSync.status === 'waiting'}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-700 text-white text-xs font-semibold hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {realSync.status === 'triggering' || realSync.status === 'waiting' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                真實同步
              </button>
            </div>
          </div>
        </div>

        {/* 新增交易表單 */}
        <div className="p-3 bg-zinc-950/40 rounded-lg border border-zinc-800 space-y-3">
          <div className="text-xs font-medium text-zinc-300">新增一筆交易</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
            {/* 標的【增修I】 */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">標的</label>
              <select
                value={tradeCode}
                onChange={(e) => setTradeCode(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded font-mono text-xs text-zinc-100 focus:outline-none focus:border-primary"
              >
                {ASSETS.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            {/* 方向 */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">方向</label>
              <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
                <button
                  onClick={() => setTradeSide('buy')}
                  className={`flex-1 px-2 py-1.5 font-medium transition-colors ${tradeSide === 'buy' ? 'bg-bear text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                >
                  買進
                </button>
                <button
                  onClick={() => setTradeSide('sell')}
                  className={`flex-1 px-2 py-1.5 font-medium transition-colors ${tradeSide === 'sell' ? 'bg-bull text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
                >
                  賣出
                </button>
              </div>
            </div>
            {/* 日期 */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">日期</label>
              <input
                type="date"
                value={tradeDateStr}
                onChange={(e) => setTradeDateStr(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded font-mono text-xs text-zinc-100 focus:outline-none focus:border-primary"
              />
            </div>
            {/* 股數 */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">股數</label>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="1000"
                value={tradeSharesStr}
                onChange={(e) => setTradeSharesStr(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded font-mono text-xs text-zinc-100 focus:outline-none focus:border-primary"
              />
            </div>
            {/* 價格 */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">成交價</label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="38.8"
                value={tradePriceStr}
                onChange={(e) => setTradePriceStr(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded font-mono text-xs text-zinc-100 focus:outline-none focus:border-primary"
              />
            </div>
          </div>
          <button
            onClick={addTrade}
            disabled={!(parseFloat(tradeSharesStr) > 0) || !(parseFloat(tradePriceStr) >= 0)}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-800 text-zinc-100 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-4 h-4" />
            新增一筆並同步
          </button>
        </div>

        {/* 交易紀錄列表 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-300">交易紀錄（{config.trades.length} 筆）</span>
            {agg.realized_pnl !== 0 && (
              <span className="text-zinc-400">
                已實現損益：
                <strong className={`font-mono ml-1 ${agg.realized_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {agg.realized_pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(agg.realized_pnl)).toLocaleString()}
                </strong>
              </span>
            )}
          </div>
          {agg.invalid_sells > 0 && (
            <p className="text-[11px] text-amber-400">⚠ 有 {agg.invalid_sells} 筆賣出超過當時持有股數，已自動 clamp 到可賣上限。</p>
          )}
          {tradesSorted.length === 0 ? (
            <p className="text-xs text-zinc-600 italic py-3 text-center">尚無交易紀錄。上方新增買/賣，會自動累算回持倉並同步雲端。</p>
          ) : (
            <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800/70 overflow-hidden">
              {tradesSorted.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 text-xs bg-zinc-950/30">
                  <span
                    className={`px-2 py-0.5 rounded font-semibold shrink-0 ${t.side === 'buy' ? 'bg-bear/15 text-bear' : 'bg-bull/15 text-bull'}`}
                  >
                    {t.side === 'buy' ? '買進' : '賣出'}
                  </span>
                  <span className="font-mono text-zinc-300 shrink-0 w-16">{t.code ?? ETF_CODE}</span>
                  <span className="font-mono text-zinc-400 shrink-0">{t.date || '—'}</span>
                  <span className="font-mono text-zinc-200 flex-1 text-right">
                    {Math.round(t.shares).toLocaleString()} 股 <span className="text-zinc-500">×</span> ${t.price.toFixed(2)}
                  </span>
                  <span className="font-mono text-zinc-400 shrink-0 w-24 text-right">
                    ${Math.round(t.shares * t.price).toLocaleString()}
                  </span>
                  <button
                    onClick={() => deleteTrade(t.id)}
                    className="text-zinc-600 hover:text-bull transition-colors shrink-0"
                    title="刪除此筆"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 免責聲明卡 */}
      <div className="p-4 rounded-xl border border-zinc-800/60 bg-zinc-950/40 text-xs text-zinc-500 space-y-1 flex items-start gap-3">
        <ShieldAlert className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
        <div>
          <strong className="text-zinc-400 font-medium">系統聲明與警語：</strong>
          <p className="mt-0.5 leading-relaxed">
            本工具為個人資產配置輔助試算。各標的持有股數、平均成本與閒置現金由「期初部位＋買賣報價單」自動累算（均價採加權平均法、賣出只減股數不改均價；現金＝期初現金 − 全部買進金額 ＋ 全部賣出金額，未計手續費/交易稅）；各標的現價可「抓最新價」自動帶入<strong className="text-zinc-400">現在最新成交價（即時報價）</strong>（TWSE MIS 官方報價，經 <span className="font-mono">/api</span> 讀取，盤中約數秒～數十秒延遲、非交易時段回最近一筆成交，可手動覆寫）；未實現損益依累算均價計算，僅供參考、不影響再平衡；投組 Beta 以 00631L β=2.0、防守端（現金＋{BOND_ETFS[0].code}＋{BOND_ETFS[1].code}）β=0 計算——債券 ETF 實際仍有利率/信用風險，β=0 為簡化假設。防守端配置＝固定保留現金 ${config.cash_reserve.toLocaleString()}，剩餘依 {Math.round(config.bond_split * 100)}:{Math.round((1 - config.bond_split) * 100)} 分配 {BOND_ETFS[0].code}/{BOND_ETFS[1].code}。按「送出並同步雲端」或新增/刪除交易時，持倉會存到伺服器（<span className="font-mono">data/rebalance_holdings.json</span>，與每日再平衡 Email 告警同一份），僅供個人內網自用。非投資建議。
          </p>
        </div>
      </div>
    </div>
  );
}
