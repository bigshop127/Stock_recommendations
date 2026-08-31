/**
 * HoldingsScreenshotImport.tsx — 券商 App「庫存查詢」截圖 → 自動帶入再平衡計算機期初部位。
 *
 * 流程比照個股頁的 StockScreenshotImport.tsx：選截圖 → 掃描比對 → 確認才套用。這裡更單純
 * ——沒有帳務判斷，掃描結果只跟目前期初部位（00631L／00687B／00953B／現金）比對出差異，
 * 套用即直接覆蓋 opening，跟「真實同步」按鈕殊途同歸，差別是不需要券商 API 憑證。
 */
import React, { useMemo, useRef, useState } from 'react';
import { ScanLine, ImagePlus, X, CheckCircle2, AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { buildHoldingsImportPlan, type HoldingsScanScreen, type HoldingsImportPlan } from '../../lib/rebalanceHoldingsImport';
import type { RebalanceConfig } from '../../lib/rebalanceStore';

type Picked = { id: string; name: string; mime: string; data: string; url: string; kb: number };

/** 縮圖 + 轉 JPEG。回 base64 本體（不含 data URL 前綴），順便給預覽用的 object URL。 */
async function shrink(file: File, maxDim = 2400, quality = 0.9): Promise<Omit<Picked, 'id'>> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`讀不到圖片：${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('這個瀏覽器不支援 canvas，無法縮圖');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { name: file.name, mime: 'image/jpeg', data, url: dataUrl, kb: Math.round((data.length * 3) / 4 / 1024) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const HoldingsScreenshotImport: React.FC<{
  config: RebalanceConfig;
  onApply: (plan: HoldingsImportPlan) => void;
}> = ({ config, onApply }) => {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [scan, setScan] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; msg: string | null; screens: HoldingsScanScreen[]; model: string }>(
    { status: 'idle', msg: null, screens: [], model: '' },
  );
  const [applied, setApplied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 4);
    if (list.length === 0) return;
    setScan({ status: 'idle', msg: null, screens: [], model: '' });
    setApplied(false);
    const out: Picked[] = [];
    for (const f of list) {
      try {
        const s = await shrink(f);
        out.push({ ...s, id: `${f.name}_${f.size}_${Math.random().toString(36).slice(2, 7)}` });
      } catch (e) {
        setScan({ status: 'error', msg: e instanceof Error ? e.message : '圖片讀取失敗', screens: [], model: '' });
      }
    }
    setPicked((p) => [...p, ...out].slice(0, 4));
  };

  const runScan = async () => {
    if (picked.length === 0) return;
    setScan({ status: 'loading', msg: null, screens: [], model: '' });
    setApplied(false);
    try {
      const resp = await api.scanRebalanceHoldingsScreens(picked.map((p) => ({ mime: p.mime, data: p.data })));
      setScan({
        status: 'done',
        msg: resp.warnings.length > 0 ? resp.warnings.join('；') : null,
        screens: resp.screens,
        model: resp.model,
      });
    } catch (e) {
      setScan({ status: 'error', msg: e instanceof Error ? e.message : '辨識失敗', screens: [], model: '' });
    }
  };

  const plan = useMemo(() => {
    if (scan.screens.length === 0) return null;
    return buildHoldingsImportPlan(config, scan.screens);
  }, [config, scan.screens]);

  const reset = () => {
    setPicked([]);
    setScan({ status: 'idle', msg: null, screens: [], model: '' });
    setApplied(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-cyan-400/10 border border-cyan-400/30 grid place-items-center shrink-0">
          <ScanLine className="w-4 h-4 text-cyan-400" />
        </span>
        <h2 className="text-sm font-bold text-zinc-100 tracking-wide">截圖匯入（券商 App 庫存查詢）</h2>
      </div>

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        把券商 App 的<strong className="text-zinc-400">庫存查詢／持股明細</strong>截圖丟進來（可一次多張），
        辨識後會列出 {config.opening.bonds.map((b) => b.code).join('／')} 這幾檔的<strong className="text-zinc-400">期初股數與成本</strong>打算怎麼帶入，確認再套用；
        跟「真實同步」殊途同歸，差別是不需要券商 API 憑證，隨時能用手機截圖更新。
        <br />
        截圖會送到 gateway 再轉給 Google Gemini 辨識，<strong className="text-zinc-400">不會存檔、不寫入 log</strong>；
        帳號與姓名不會被寫進任何資料。
      </p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}
        onPaste={(e) => { void addFiles([...e.clipboardData.files]); }}
        className="border border-dashed border-border rounded-xl p-4 text-center"
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { void addFiles(e.target.files); }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition"
        >
          <ImagePlus className="w-3.5 h-3.5" /> 選擇截圖
        </button>
        <p className="text-[10px] text-zinc-600 mt-2">也可以直接拖曳或貼上（最多 4 張）；辨識一張約需 20–40 秒（多張是並行的）</p>
      </div>

      {picked.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {picked.map((p) => (
            <div key={p.id} className="relative">
              <img src={p.url} alt={p.name} className="w-20 h-32 object-cover object-top rounded-lg border border-border" />
              <span className="absolute bottom-0 inset-x-0 bg-zinc-950/80 text-[9px] text-zinc-400 text-center rounded-b-lg">{p.kb} KB</span>
              <button
                onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-border grid place-items-center text-zinc-400 hover:text-rose-400"
                title="移除"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void runScan()}
          disabled={picked.length === 0 || scan.status === 'loading'}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-cyan-500/90 text-white text-xs font-semibold rounded-lg hover:bg-cyan-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {scan.status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {scan.status === 'loading' ? '辨識中…' : '掃描並比對'}
        </button>
        {(picked.length > 0 || scan.screens.length > 0) && (
          <button onClick={reset} className="text-[11px] text-zinc-500 hover:text-zinc-300">清除</button>
        )}
        {scan.status === 'done' && scan.model && (
          <span className="text-[10px] text-zinc-600">辨識模型：{scan.model}</span>
        )}
      </div>

      {scan.status === 'error' && (
        <p className="text-xs text-rose-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {scan.msg}
        </p>
      )}
      {scan.status === 'done' && scan.msg && (
        <p className="text-xs text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {scan.msg}
        </p>
      )}

      {scan.screens.map((s, i) => (
        <div key={i} className="border border-border/70 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-border text-zinc-300 font-semibold">
              第 {i + 1} 張
            </span>
            {s.title && <span className="text-zinc-600">{s.title}</span>}
            {s.cash !== null && <span className="text-zinc-600">現金 ${Math.round(s.cash).toLocaleString()}</span>}
          </div>

          {s.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] text-[11px]">
                <thead>
                  <tr className="text-zinc-500 border-b border-border">
                    <th className="text-left font-medium py-1 pr-2">標的</th>
                    <th className="text-right font-medium py-1 pr-2">股數</th>
                    <th className="text-right font-medium py-1 pr-2">成本</th>
                    <th className="text-right font-medium py-1">現價</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r, j) => (
                    <tr key={j} className="border-b border-border/40 last:border-0">
                      <td className="py-1 pr-2 text-zinc-300">{r.name}（{r.symbol}）</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-300">{r.shares.toLocaleString()}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-400">{r.avg_cost !== null ? r.avg_cost.toFixed(2) : '—'}</td>
                      <td className="py-1 text-right font-mono text-zinc-400">{r.market_price !== null ? r.market_price.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {plan && (
        <div className="space-y-3 pt-1">
          {plan.unmatched.length > 0 && (
            <p className="text-[11px] text-zinc-500">
              截圖裡還認到這些持股，但不在這台計算機追蹤的標的內，已略過：{plan.unmatched.join('、')}
            </p>
          )}

          <div className="rounded-xl border border-border bg-zinc-900/40 p-3 space-y-1.5">
            <div className="text-[11px] font-semibold text-zinc-300">會做的異動（{plan.ops.length} 項）</div>
            {plan.ops.length === 0 && <p className="text-[11px] text-zinc-500">跟現在的期初部位相比沒有差異，不用套用。</p>}
            {plan.ops.map((o, i) => (
              <p key={i} className="text-[11px] flex items-start gap-1.5 text-zinc-300">
                <span className="mt-1 w-1 h-1 rounded-full bg-current shrink-0" />
                <span>{o.text}</span>
              </p>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => { onApply(plan); setApplied(true); }}
              disabled={!plan.changed || applied}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-500/90 text-white text-xs font-semibold rounded-lg hover:bg-emerald-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {applied ? '已套用' : plan.changed ? '套用這些異動' : '沒有需要更新的內容'}
            </button>
            {applied && <span className="text-[11px] text-emerald-400">已寫入並同步雲端</span>}
          </div>
        </div>
      )}
    </div>
  );
};
