import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SlidersHorizontal, AlertTriangle, CheckCircle2, Info, ArrowRightLeft, ShieldAlert, RefreshCw, Loader2, Plus, Trash2, UploadCloud, Cloud, CloudOff } from 'lucide-react';
import { getRebalanceConfig, saveRebalanceConfig, subscribeRebalance, type RebalanceConfig } from '../lib/rebalanceStore';
import { computeRebalance, aggregatePosition, type RebalanceResult, type Trade } from '../lib/rebalance';
import { api } from '../lib/api';

const ETF_CODE = '00631L';

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

export function Rebalance() {
  const [config, setConfig] = useState<RebalanceConfig>(() => getRebalanceConfig());

  // 直接編輯欄位的本地暫存（允許打字未完，如 "12."）
  const [priceStr, setPriceStr] = useState<string>(() => String(config.price || ''));
  const [openSharesStr, setOpenSharesStr] = useState<string>(() => String(config.opening.shares || ''));
  const [openAvgStr, setOpenAvgStr] = useState<string>(() => String(config.opening.avg_cost || ''));
  const [openCashStr, setOpenCashStr] = useState<string>(() => String(config.opening.cash || ''));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 報價單：新增一筆交易的表單
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy');
  const [tradeDateStr, setTradeDateStr] = useState<string>(() => localToday());
  const [tradeSharesStr, setTradeSharesStr] = useState<string>('');
  const [tradePriceStr, setTradePriceStr] = useState<string>('');

  // 自動抓取最新收盤價的狀態
  const [priceFetch, setPriceFetch] = useState<{ loading: boolean; error: string | null; date: string | null }>({
    loading: false,
    error: null,
    date: null,
  });

  // 雲端同步狀態
  const [cloud, setCloud] = useState<CloudState>({ status: 'idle', savedAt: null, msg: null });

  useEffect(() => {
    const unsub = subscribeRebalance(() => {
      const updated = getRebalanceConfig();
      setConfig(updated);
    });
    return unsub;
  }, []);

  // 同步 input 欄位，若外部 store 改變
  useEffect(() => {
    setPriceStr(config.price ? String(config.price) : '');
    setOpenSharesStr(config.opening.shares ? String(config.opening.shares) : '');
    setOpenAvgStr(config.opening.avg_cost ? String(config.opening.avg_cost) : '');
    setOpenCashStr(config.opening.cash ? String(config.opening.cash) : '');
  }, [config.price, config.opening.shares, config.opening.avg_cost, config.opening.cash]);

  // 套用設定：合併 partial → 重算衍生 shares/avg_cost/cash（＝aggregatePosition）→ 存 localStorage
  const applyConfig = (partial: Partial<RebalanceConfig>): RebalanceConfig => {
    const merged = { ...config, ...partial };
    const agg = aggregatePosition(merged.opening, merged.trades);
    const next: RebalanceConfig = {
      ...merged,
      shares: agg.shares,
      avg_cost: agg.avg_cost,
      cash: Math.max(0, agg.cash), // 【增修H】現金亦為衍生（買扣賣加），負值 clamp 0
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

  // 掛載：先從雲端載入（雲端為主）；本機為離線快取。載入後若無現價再自動抓一次收盤價。
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
        if (getRebalanceConfig().price <= 0) fetchLatestPrice();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 抓取 00631L 最新收盤價（未還原原始價；市值＝股數×實際成交價，故不用還原）
  const fetchLatestPrice = async () => {
    setPriceFetch((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await api.ohlcv(ETF_CODE);
      const rows = res?.data ?? [];
      if (rows.length === 0) throw new Error('查無報價資料');
      const latest = rows.reduce((a, b) => (b.date > a.date ? b : a));
      const close = latest.close;
      if (!Number.isFinite(close) || close <= 0) throw new Error('收盤價無效');
      setPriceStr(String(close));
      applyConfig({ price: close });
      setPriceFetch({ loading: false, error: null, date: latest.date });
    } catch (e) {
      setPriceFetch({ loading: false, error: e instanceof Error ? e.message : '抓取失敗', date: null });
    }
  };

  // 即時計算結果
  const result: RebalanceResult = useMemo(() => {
    return computeRebalance(config);
  }, [config]);

  // 報價單累算（已實現損益 / 超賣提示）
  const agg = useMemo(() => aggregatePosition(config.opening, config.trades), [config.opening, config.trades]);

  // 目前價格所處價帶（供觸發價帶面板標示；由 status 導出）
  const priceZone =
    result.status === 'buy'
      ? { label: '買進區（β 偏低、偏現金）', cls: 'bg-bear/10 border-bear/25 text-bear' }
      : result.status === 'sell'
        ? { label: '賣出區（β 偏高、偏槓桿）', cls: 'bg-bull/10 border-bull/25 text-bull' }
        : result.status === 'normal'
          ? { label: '容忍區間內（無須動作）', cls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' }
          : { label: '—', cls: 'bg-zinc-800/40 border-zinc-700 text-zinc-400' };

  const handlePriceChange = (val: string) => {
    setPriceStr(val);
    const parsed = parseFloat(val);
    applyConfig({ price: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
    // 手動改價 → 清掉「自動收盤」標記，避免誤導日期
    setPriceFetch((s) => ({ ...s, date: null, error: null }));
  };

  const handleOpenCashChange = (val: string) => {
    setOpenCashStr(val);
    const parsed = parseFloat(val);
    applyConfig({ opening: { ...config.opening, cash: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 } });
  };

  const handleOpenSharesChange = (val: string) => {
    setOpenSharesStr(val);
    const parsed = parseFloat(val);
    applyConfig({ opening: { ...config.opening, shares: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 } });
  };

  const handleOpenAvgChange = (val: string) => {
    setOpenAvgStr(val);
    const parsed = parseFloat(val);
    applyConfig({ opening: { ...config.opening, avg_cost: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 } });
  };

  // updateConfig：供上方兩張卡（目標β/容忍/etf_beta）沿用
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

  // 目標 Beta (00631L % / 現金 %)
  const targetEtfPctStr = result.target_etf_weight !== null ? (result.target_etf_weight * 100).toFixed(0) : '—';
  const targetCashPctStr = result.target_cash_weight !== null ? (result.target_cash_weight * 100).toFixed(0) : '—';

  // 目前配比 %
  const currentEtfPctStr = result.etf_weight !== null ? (result.etf_weight * 100).toFixed(1) : '—';
  const currentCashPctStr = result.cash_weight !== null ? (result.cash_weight * 100).toFixed(1) : '—';

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 標題與簡介 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <SlidersHorizontal className="w-6 h-6 text-primary" />
            00631L「正2 + 現金」再平衡計算機
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            透過 00631L（β≈2.0）與現金（β=0）組合控管投組風險。不擇時，僅於 Beta 偏離過大時進行高賣低買再平衡。
          </p>
        </div>
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

          {/* 進階設定 (標的 Beta) */}
          {showAdvanced && (
            <div className="p-3 bg-zinc-900/60 rounded-lg border border-zinc-800 text-xs space-y-2">
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
                  (＝ 00631L {targetEtfPctStr}% / 現金 {targetCashPctStr}%)
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
              <span>0.0X (100%現金)</span>
              <span>1.0X (50/50)</span>
              <span>1.3X (預設)</span>
              <span>2.0X (全正2)</span>
            </div>
          </div>

          {/* 配置比例條 */}
          <div className="space-y-3 pt-2 border-t border-border/50">
            <div className="text-xs font-semibold text-zinc-300">資產配置比例對比</div>

            {/* 目前配比 */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-400">目前實況</span>
                <span className="font-mono text-zinc-300">
                  00631L: <strong className="text-blue-400">{currentEtfPctStr}%</strong> | 現金: <strong className="text-emerald-400">{currentCashPctStr}%</strong>
                </span>
              </div>
              <div className="h-3 w-full bg-zinc-800 rounded-full overflow-hidden flex">
                <div
                  className="bg-blue-500 h-full transition-all duration-300"
                  style={{ width: `${result.etf_weight !== null ? result.etf_weight * 100 : 0}%` }}
                  title={`00631L: ${currentEtfPctStr}%`}
                />
                <div
                  className="bg-emerald-500/80 h-full transition-all duration-300"
                  style={{ width: `${result.cash_weight !== null ? result.cash_weight * 100 : 0}%` }}
                  title={`現金: ${currentCashPctStr}%`}
                />
              </div>
            </div>

            {/* 目標配比 */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-400">目標配置</span>
                <span className="font-mono text-zinc-300">
                  00631L: <strong className="text-blue-400/80">{targetEtfPctStr}%</strong> | 現金: <strong className="text-emerald-400/80">{targetCashPctStr}%</strong>
                </span>
              </div>
              <div className="h-3 w-full bg-zinc-800/80 rounded-full overflow-hidden flex border border-zinc-700/50">
                <div
                  className="bg-blue-500/40 border-r border-zinc-900 h-full transition-all duration-300"
                  style={{ width: `${result.target_etf_weight !== null ? result.target_etf_weight * 100 : 0}%` }}
                />
                <div
                  className="bg-emerald-500/30 h-full transition-all duration-300"
                  style={{ width: `${result.target_cash_weight !== null ? result.target_cash_weight * 100 : 0}%` }}
                />
              </div>
            </div>
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
                    {result.etf_value_delta > 0 ? '應買進 00631L' : '應賣出 00631L'}
                  </div>
                  <div className={`text-2xl font-extrabold font-mono tracking-tight mt-0.5 ${result.etf_value_delta > 0 ? 'text-bear' : 'text-bull'}`}>
                    ${Math.abs(Math.round(result.etf_value_delta)).toLocaleString()}
                  </div>
                  {result.trade_shares !== null && (
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      約 {Math.abs(result.trade_shares).toLocaleString()} 股
                      {result.etf_value_delta > 0
                        ? '（動用閒置現金）'
                        : '（轉回現金）'}
                    </div>
                  )}
                </div>
              )}

              {/* 精確達標試算 (永遠顯示) */}
              <div className="pt-2 border-t border-zinc-800/80 text-xs space-y-1.5 text-zinc-300">
                <div className="text-zinc-400 font-medium">🎯 若要精確重置至目標 β ({config.target_beta.toFixed(2)}X)：</div>
                {result.note && result.status !== 'empty' ? (
                  <div className="text-amber-400 font-mono">{result.note}</div>
                ) : result.etf_value_delta !== null ? (
                  <div className="space-y-1 font-mono pl-2 border-l-2 border-primary/40">
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
                      • 現金調整：
                      <span className={result.cash_delta !== null && result.cash_delta > 0 ? 'text-emerald-400 font-bold' : result.cash_delta !== null && result.cash_delta < 0 ? 'text-amber-400 font-bold' : 'text-zinc-300'}>
                        {result.cash_delta !== null && result.cash_delta > 0 ? '+ $' : result.cash_delta !== null && result.cash_delta < 0 ? '- $' : '$'}
                        {result.cash_delta !== null ? Math.abs(Math.round(result.cash_delta)).toLocaleString() : '0'}
                      </span>
                    </div>
                    {result.post_beta !== null && (
                      <div className="text-[11px] text-zinc-500 font-sans mt-1">
                        * 整股成交後實況：持有 {result.post_shares?.toLocaleString()} 股，投組 Beta 將回歸至 <strong className="text-zinc-300 font-mono">{result.post_beta.toFixed(2)}X</strong>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-zinc-500 italic">無可用數值</div>
                )}
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
                  {config.cash <= 0
                    ? '（現金為 0，投組 Beta 恆等於滿槓桿，與價格無關）'
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
                    以目前持股 <span className="font-mono text-zinc-400">{config.shares ? Math.round(config.shares).toLocaleString() : 0}</span> 股、現金 <span className="font-mono text-zinc-400">${Math.round(config.cash).toLocaleString()}</span> <strong className="text-zinc-400">固定不動</strong>推算：只靠 00631L 漲跌，價格落在
                    {result.buy_trigger_price !== null && result.sell_trigger_price !== null ? (
                      <> <span className="font-mono text-zinc-300">${result.buy_trigger_price.toFixed(2)}～${result.sell_trigger_price.toFixed(2)}</span></>
                    ) : ' 門檻之間'} 時 β 才在容忍區間內。
                    {result.status === 'buy' && '目前現價遠低於買進門檻＝部位偏現金、β 太低，已在買進區（見上方建議買進金額）。'}
                    {result.status === 'sell' && '目前現價已高於賣出門檻＝部位偏槓桿、β 太高，已在賣出區（見上方建議賣出金額）。'}
                    <strong className="text-zinc-400"> 注意這是「持倉不動」的假設</strong>——你一旦依建議買/賣，持股與現金改變，這條價帶會整個重算。
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 下方：持倉現況面板（股數/均價為報價單累算的衍生值，唯讀） */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center justify-between border-b border-border/60 pb-3">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            持倉現況（00631L ＋ 現金）
          </span>
          <span className="text-xs text-zinc-500 font-normal">股數／均價由下方報價單自動累算，現價可抓取，可一鍵同步雲端</span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 00631L 股數（衍生唯讀） */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">00631L 持有股數</label>
            <div className="relative">
              <input
                type="text"
                readOnly
                value={config.shares ? Math.round(config.shares).toLocaleString() : '0'}
                className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-300 cursor-not-allowed pr-12"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">股</span>
            </div>
            <p className="text-[10px] text-zinc-600 leading-tight">由期初部位＋報價單累算</p>
          </div>

          {/* 00631L 平均成本（衍生唯讀） */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">00631L 平均成本 (TWD)</label>
            <div className="relative">
              <input
                type="text"
                readOnly
                value={config.avg_cost ? config.avg_cost.toFixed(2) : '—'}
                className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-300 cursor-not-allowed pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] text-zinc-600 leading-tight">加權平均，用來算未實現損益</p>
          </div>

          {/* 00631L 現價（可自動抓取） */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-300">00631L 現價 (TWD)</label>
              <button
                onClick={fetchLatestPrice}
                disabled={priceFetch.loading}
                className="text-[11px] text-primary hover:text-primary/80 disabled:text-zinc-600 flex items-center gap-1 transition-colors"
                title="抓取最新收盤價"
              >
                {priceFetch.loading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                {priceFetch.loading ? '抓取中' : '抓最新價'}
              </button>
            </div>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="例如: 185.5"
                value={priceStr}
                onChange={(e) => handlePriceChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] leading-tight h-3">
              {priceFetch.error ? (
                <span className="text-amber-400">抓取失敗：{priceFetch.error}（可手動輸入）</span>
              ) : priceFetch.date ? (
                <span className="text-zinc-600">自動帶入 {priceFetch.date} 收盤價</span>
              ) : (
                <span className="text-zinc-600">&nbsp;</span>
              )}
            </p>
          </div>

          {/* 閒置現金（衍生唯讀：期初現金 − 買進 ＋ 賣出）【增修H】 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">閒置現金 (TWD)</label>
            <div className="relative">
              <input
                type="text"
                readOnly
                value={`$${Math.round(config.cash).toLocaleString()}`}
                className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-300 cursor-not-allowed pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] leading-tight">
              {agg.cash < 0 ? (
                <span className="text-amber-400">⚠ 買進金額已超過期初現金 ${Math.abs(Math.round(agg.cash)).toLocaleString()}，以 0 計算——請到下方報價單校正「期初現金」</span>
              ) : (
                <span className="text-zinc-600">由期初現金＋報價單累算（買進扣、賣出加）</span>
              )}
            </p>
          </div>
        </div>

        {/* 資產試算小結 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3 border-t border-zinc-800/80">
          <div className="flex justify-between items-center px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60">
            <span className="text-xs text-zinc-400">00631L 估計總市值</span>
            <span className="font-mono font-bold text-blue-400 text-base">
              ${Math.round(result.etf_value).toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between items-center px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60">
            <span className="text-xs text-zinc-400">未實現損益</span>
            {result.unrealized_pnl !== null ? (
              <span className={`font-mono font-bold text-base ${result.unrealized_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {result.unrealized_pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(result.unrealized_pnl)).toLocaleString()}
                {result.unrealized_pnl_pct !== null && (
                  <span className="text-xs font-normal ml-1">
                    ({result.unrealized_pnl_pct >= 0 ? '+' : '−'}{Math.abs(result.unrealized_pnl_pct * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            ) : (
              <span className="font-mono text-zinc-600 text-sm">填期初成本或買進</span>
            )}
          </div>
          <div className="flex justify-between items-center px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60">
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
          <span className="text-xs text-zinc-500 font-normal">每筆買/賣自動累算總股數與加權平均成本，新增即同步雲端</span>
        </h2>

        {/* 期初部位 */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
            期初／建倉部位
            <span className="text-[10px] text-zinc-600 font-normal">（開始記帳前已持有的部位與現金，之後的買賣疊在其上）</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">期初股數</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="例如: 19000"
                  value={openSharesStr}
                  onChange={(e) => handleOpenSharesChange(e.target.value)}
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
                  placeholder="例如: 35.37"
                  value={openAvgStr}
                  onChange={(e) => handleOpenAvgChange(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
                />
                <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
              </div>
            </div>
            {/* 期初現金【增修H】：閒置現金改由此累算（買進扣、賣出加） */}
            <div className="space-y-1">
              <label className="text-[10px] text-zinc-500">期初現金（記帳起點的閒置資金）</label>
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

        {/* 新增交易表單 */}
        <div className="p-3 bg-zinc-950/40 rounded-lg border border-zinc-800 space-y-3">
          <div className="text-xs font-medium text-zinc-300">新增一筆交易</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
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
            本工具為個人資產配置輔助試算。持有股數、平均成本與閒置現金由「期初部位＋買賣報價單」自動累算（均價採加權平均法、賣出只減股數不改均價；現金＝期初現金 − 買進金額 ＋ 賣出金額，未計手續費/交易稅）；00631L 現價可「抓最新價」自動帶入<strong className="text-zinc-400">最新收盤價</strong>（非盤中即時報價，經 <span className="font-mono">/api</span> 讀取，可手動覆寫）；未實現損益依累算均價計算，僅供參考、不影響再平衡；投組 Beta 以 00631L β=2.0、現金 β=0 計算。按「送出並同步雲端」或新增/刪除交易時，持倉會存到伺服器（<span className="font-mono">data/rebalance_holdings.json</span>，與每日再平衡 Email 告警同一份），僅供個人內網自用。非投資建議。
          </p>
        </div>
      </div>
    </div>
  );
}
