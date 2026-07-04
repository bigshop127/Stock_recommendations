import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SlidersHorizontal, AlertTriangle, CheckCircle2, Info, ArrowRightLeft, ShieldAlert, RefreshCw, Loader2 } from 'lucide-react';
import { getRebalanceConfig, saveRebalanceConfig, subscribeRebalance, type RebalanceConfig } from '../lib/rebalanceStore';
import { computeRebalance, type RebalanceResult } from '../lib/rebalance';
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

export function Rebalance() {
  const [config, setConfig] = useState<RebalanceConfig>(() => getRebalanceConfig());

  // 本地表單輸入暫存 (允許使用者打字未完，如 "12.")
  const [sharesStr, setSharesStr] = useState<string>(() => String(config.shares || ''));
  const [priceStr, setPriceStr] = useState<string>(() => String(config.price || ''));
  const [avgCostStr, setAvgCostStr] = useState<string>(() => String(config.avg_cost || ''));
  const [cashStr, setCashStr] = useState<string>(() => String(config.cash || ''));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 自動抓取最新收盤價的狀態
  const [priceFetch, setPriceFetch] = useState<{ loading: boolean; error: string | null; date: string | null }>({
    loading: false,
    error: null,
    date: null,
  });

  useEffect(() => {
    const unsub = subscribeRebalance(() => {
      const updated = getRebalanceConfig();
      setConfig(updated);
    });
    return unsub;
  }, []);

  // 同步 input 欄位，若外部 store 改變
  useEffect(() => {
    setSharesStr(config.shares ? String(config.shares) : '');
    setPriceStr(config.price ? String(config.price) : '');
    setAvgCostStr(config.avg_cost ? String(config.avg_cost) : '');
    setCashStr(config.cash ? String(config.cash) : '');
  }, [config.shares, config.price, config.avg_cost, config.cash]);

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
      const next = { ...getRebalanceConfig(), price: close };
      setConfig(next);
      saveRebalanceConfig(next);
      setPriceFetch({ loading: false, error: null, date: latest.date });
    } catch (e) {
      setPriceFetch({ loading: false, error: e instanceof Error ? e.message : '抓取失敗', date: null });
    }
  };

  // 首次載入若尚未有現價，自動抓一次最新收盤價
  const didAutoFetch = useRef(false);
  useEffect(() => {
    if (didAutoFetch.current) return;
    didAutoFetch.current = true;
    if (getRebalanceConfig().price <= 0) {
      fetchLatestPrice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 即時計算結果
  const result: RebalanceResult = useMemo(() => {
    return computeRebalance(config);
  }, [config]);

  // 儲存變更至 localStorage
  const updateConfig = (newCfgPartial: Partial<RebalanceConfig>) => {
    const next = { ...config, ...newCfgPartial };
    setConfig(next);
    saveRebalanceConfig(next);
  };

  const handleSharesChange = (val: string) => {
    setSharesStr(val);
    const parsed = parseFloat(val);
    updateConfig({ shares: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
  };

  const handlePriceChange = (val: string) => {
    setPriceStr(val);
    const parsed = parseFloat(val);
    updateConfig({ price: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
    // 手動改價 → 清掉「自動收盤」標記，避免誤導日期
    setPriceFetch((s) => ({ ...s, date: null, error: null }));
  };

  const handleAvgCostChange = (val: string) => {
    setAvgCostStr(val);
    const parsed = parseFloat(val);
    updateConfig({ avg_cost: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
  };

  const handleCashChange = (val: string) => {
    setCashStr(val);
    const parsed = parseFloat(val);
    updateConfig({ cash: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 });
  };

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
          </div>
        </div>
      </div>

      {/* 下方：持倉輸入面板 */}
      <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-zinc-200 flex items-center justify-between border-b border-border/60 pb-3">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            持倉數據輸入（00631L ＋ 現金）
          </span>
          <span className="text-xs text-zinc-500 font-normal">現價可自動抓取或手動覆寫，零後端安全儲存</span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* 00631L 股數 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">00631L 持有股數</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="1"
                placeholder="例如: 6000"
                value={sharesStr}
                onChange={(e) => handleSharesChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-12"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">股</span>
            </div>
          </div>

          {/* 00631L 平均成本 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">00631L 平均成本 (TWD)</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="例如: 150.0"
                value={avgCostStr}
                onChange={(e) => handleAvgCostChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
            <p className="text-[10px] text-zinc-600 leading-tight">選填，用來算未實現損益，不影響再平衡</p>
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

          {/* 現金 TWD */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">閒置現金 (TWD)</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="1000"
                placeholder="例如: 400000"
                value={cashStr}
                onChange={(e) => handleCashChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-100 focus:outline-none focus:border-primary pr-10"
              />
              <span className="absolute right-3 top-2.5 text-xs text-zinc-500 font-mono">元</span>
            </div>
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
              <span className="font-mono text-zinc-600 text-sm">填平均成本</span>
            )}
          </div>
          <div className="flex justify-between items-center px-4 py-2.5 bg-zinc-950/60 rounded-lg border border-zinc-800/60">
            <span className="text-xs text-zinc-400">投組總資產現值</span>
            <span className="font-mono font-extrabold text-zinc-100 text-lg">
              ${Math.round(result.total_value).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* 免責聲明卡 */}
      <div className="p-4 rounded-xl border border-zinc-800/60 bg-zinc-950/40 text-xs text-zinc-500 space-y-1 flex items-start gap-3">
        <ShieldAlert className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
        <div>
          <strong className="text-zinc-400 font-medium">系統聲明與警語：</strong>
          <p className="mt-0.5 leading-relaxed">
            本工具為個人資產配置輔助試算。00631L 現價可「抓最新價」自動帶入<strong className="text-zinc-400">最新收盤價</strong>（非盤中即時報價，經 <span className="font-mono">/api</span> 讀取，可手動覆寫）；未實現損益依你填的平均成本計算，僅供參考、不影響再平衡；投組 Beta 以 00631L β=2.0、現金 β=0 計算；持倉資料僅存本機瀏覽器，不上傳。非投資建議。
          </p>
        </div>
      </div>
    </div>
  );
}
