/**
 * ScreenshotImport.tsx — 券商 App 截圖 → 自動更新部位與平倉紀錄（opt30）。
 *
 * 使用者流程刻意是**三段**，不是一鍵：
 *   ① 選截圖（可多張：未平倉查詢／平倉查詢／成交回報）
 *   ② 掃描 → 畫面上先列出「認出了什麼」與「打算做什麼」，並跟截圖自己的合計對帳
 *   ③ 確認無誤才套用
 * 中間那段不能省：辨識錯一個數字就會動到保證金專戶現金餘額，而那是這頁最不該說謊的
 * 數字（opt25 期交所保證金同步也是同一套兩段確認）。
 *
 * 圖片在瀏覽器先縮圖轉 JPEG 再上傳，理由有二：手機原圖動輒 3–5MB，以及 gateway 那頭
 * 有大小上限。縮太多會讓密集表格的小字糊掉，所以只限制最長邊 2400、品質 0.9。
 */
import React, { useMemo, useRef, useState } from 'react';
import { ScanLine, ImagePlus, X, CheckCircle2, AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import {
  buildImportPlanForAccount, fillSide, matchProduct,
  type ScanScreen, type AccountImportPlan, type AccountImportState, type ProductLookup,
} from '../../lib/futuresImport';

type Picked = { id: string; name: string; mime: string; data: string; url: string; kb: number };

const KIND_LABEL: Record<string, string> = {
  open: '未平倉查詢',
  closed: '平倉查詢',
  fills: '成交回報',
  account: '帳戶總覽',
  unknown: '無法辨識',
};

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`;
const mLabel = (m: string) => (/^\d{6}$/.test(m) ? `${m.slice(0, 4)}/${m.slice(4)}` : m || '—');

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
    // 截圖是白底表格，透明像素轉 JPEG 會變黑；先鋪白底
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

export const ScreenshotImport: React.FC<{
  state: AccountImportState;
  products: Record<string, ProductLookup>;
  today: string;
  onApply: (plan: AccountImportPlan) => void;
}> = ({ state, products, today, onApply }) => {
  const productName = (code: string) => products[code]?.name || code;
  const [picked, setPicked] = useState<Picked[]>([]);
  const [scan, setScan] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; msg: string | null; screens: ScanScreen[]; model: string }>(
    { status: 'idle', msg: null, screens: [], model: '' },
  );
  const [adoptSnapshot, setAdoptSnapshot] = useState(true);
  const [applyPrices, setApplyPrices] = useState(false);
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
      const resp = await api.scanFuturesScreens(picked.map((p) => ({ mime: p.mime, data: p.data })));
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
    return buildImportPlanForAccount(state, scan.screens, products, { today, adoptSnapshot, applyPrices });
  }, [state, scan.screens, products, today, adoptSnapshot, applyPrices]);

  const reset = () => {
    setPicked([]);
    setScan({ status: 'idle', msg: null, screens: [], model: '' });
    setApplied(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const badCheck = plan ? plan.checks.some((c) => !c.ok) : false;

  return (
    <div className="bg-card/70 border border-border rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-cyan-400/10 border border-cyan-400/30 grid place-items-center shrink-0">
          <ScanLine className="w-4 h-4 text-cyan-400" />
        </span>
        <h2 className="text-sm font-bold text-zinc-100 tracking-wide">截圖匯入（券商 App 對帳）</h2>
      </div>

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        把券商 App 的 <strong className="text-zinc-400">未平倉查詢</strong>、
        <strong className="text-zinc-400">平倉查詢</strong>、
        <strong className="text-zinc-400">成交回報</strong>，
        或「<strong className="text-zinc-400">個人資產總覽</strong>」「<strong className="text-zinc-400">期權-權益數查詢</strong>」
        這類<strong className="text-zinc-400">帳戶總覽</strong>截圖丟進來（可一次多張），
        辨識後會列出打算做的異動讓你確認再套用；帳戶總覽截圖沒有個別部位，只會拿權益總值來對帳、校正保證金專戶現金餘額。
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

      {/* ── 辨識結果：先讓人看得到「機器看到什麼」，數字錯了才抓得出來 ── */}
      {scan.screens.map((s, i) => (
        <div key={i} className="border border-border/70 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-full bg-zinc-800 border border-border text-zinc-300 font-semibold">
              第 {i + 1} 張 · {KIND_LABEL[s.kind] ?? s.kind}
            </span>
            {s.title && <span className="text-zinc-600">{s.title}</span>}
            {s.totals.count !== null && <span className="text-zinc-600">筆數 {s.totals.count}</span>}
            {s.totals.pnl !== null && <span className="text-zinc-600">合計 {money(s.totals.pnl)}</span>}
          </div>

          {s.open_rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11px]">
                <thead>
                  <tr className="text-zinc-500 border-b border-border">
                    <th className="text-left font-medium py-1 pr-2">商品</th>
                    <th className="text-left font-medium py-1 pr-2">月份</th>
                    <th className="text-left font-medium py-1 pr-2">方向</th>
                    <th className="text-right font-medium py-1 pr-2">口數</th>
                    <th className="text-right font-medium py-1 pr-2">均價</th>
                    <th className="text-right font-medium py-1 pr-2">市價</th>
                    <th className="text-right font-medium py-1">未平倉損益</th>
                  </tr>
                </thead>
                <tbody>
                  {s.open_rows.map((r, j) => {
                    const matched = matchProduct(r.product, products);
                    return (
                    <tr key={j} className="border-b border-border/40 last:border-0">
                      <td className={`py-1 pr-2 ${matched ? 'text-zinc-400' : 'text-amber-400'}`}>{matched ? productName(matched) : `⚠ ${r.product}`}</td>
                      <td className="py-1 pr-2 font-mono text-zinc-300">{mLabel(r.month)}</td>
                      <td className={`py-1 pr-2 ${r.side === 'long' ? 'text-bull' : 'text-bear'}`}>{r.side === 'long' ? '多' : '空'}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-300">{r.lots}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-400">{r.avg_price.toFixed(4)}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-400">{r.market_price?.toFixed(2) ?? '—'}</td>
                      <td className="py-1 text-right font-mono text-zinc-400">{r.pnl !== null ? money(r.pnl) : '—'}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {s.closed_rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[11px]">
                <thead>
                  <tr className="text-zinc-500 border-b border-border">
                    <th className="text-left font-medium py-1 pr-2">商品</th>
                    <th className="text-left font-medium py-1 pr-2">平倉日</th>
                    <th className="text-left font-medium py-1 pr-2">月份</th>
                    <th className="text-left font-medium py-1 pr-2">方向</th>
                    <th className="text-right font-medium py-1 pr-2">口數</th>
                    <th className="text-right font-medium py-1 pr-2">進場</th>
                    <th className="text-right font-medium py-1 pr-2">出場</th>
                    <th className="text-right font-medium py-1 pr-2">費用</th>
                    <th className="text-right font-medium py-1">淨損益</th>
                  </tr>
                </thead>
                <tbody>
                  {s.closed_rows.map((r, j) => {
                    const matched = matchProduct(r.product, products);
                    return (
                    <tr key={j} className="border-b border-border/40 last:border-0">
                      <td className={`py-1 pr-2 ${matched ? 'text-zinc-400' : 'text-amber-400'}`}>{matched ? productName(matched) : `⚠ ${r.product}`}</td>
                      <td className="py-1 pr-2 font-mono text-zinc-400">{r.exit_date}</td>
                      <td className="py-1 pr-2 font-mono text-zinc-300">{mLabel(r.month)}</td>
                      <td className={`py-1 pr-2 ${r.side === 'long' ? 'text-bull' : 'text-bear'}`}>{r.side === 'long' ? '多' : '空'}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-300">{r.lots}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-400">{r.entry_price.toFixed(2)}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-400">{r.exit_price.toFixed(2)}</td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-500">
                        {r.fee !== null ? money((r.fee ?? 0) + (r.tax ?? 0)) : '—'}
                      </td>
                      <td className="py-1 text-right font-mono text-zinc-300">{r.net_pnl !== null ? money(r.net_pnl) : '—'}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {s.fill_rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[11px]">
                <thead>
                  <tr className="text-zinc-500 border-b border-border">
                    <th className="text-left font-medium py-1 pr-2">商品</th>
                    <th className="text-left font-medium py-1 pr-2">成交時間</th>
                    <th className="text-left font-medium py-1 pr-2">月份</th>
                    <th className="text-left font-medium py-1 pr-2">買賣</th>
                    <th className="text-left font-medium py-1 pr-2">倉別</th>
                    <th className="text-right font-medium py-1 pr-2">口數</th>
                    <th className="text-right font-medium py-1">價格</th>
                  </tr>
                </thead>
                <tbody>
                  {s.fill_rows.map((r, j) => {
                    const matched = matchProduct(r.product, products);
                    return (
                    <tr key={j} className="border-b border-border/40 last:border-0">
                      <td className={`py-1 pr-2 ${matched ? 'text-zinc-400' : 'text-amber-400'}`}>{matched ? productName(matched) : `⚠ ${r.product}`}</td>
                      <td className="py-1 pr-2 font-mono text-zinc-400">{r.date} {r.time}</td>
                      <td className="py-1 pr-2 font-mono text-zinc-300">{mLabel(r.month)}</td>
                      <td className={`py-1 pr-2 ${r.direction === 'buy' ? 'text-bull' : 'text-bear'}`}>{r.direction === 'buy' ? '買進' : '賣出'}</td>
                      <td className="py-1 pr-2 text-zinc-400">
                        {r.action === 'open' ? '新倉' : '平倉'}
                        <span className="text-zinc-600">（{fillSide(r) === 'long' ? '多單' : '空單'}）</span>
                      </td>
                      <td className="py-1 pr-2 text-right font-mono text-zinc-300">{r.lots}</td>
                      <td className="py-1 text-right font-mono text-zinc-400">{r.price.toFixed(2)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {s.kind === 'account' && s.account && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <div className="text-zinc-500">權益總值</div>
              <div className="text-right font-mono text-zinc-300">{s.account.equity !== null ? money(s.account.equity) : '—'}</div>
              <div className="text-zinc-500">未平倉損益</div>
              <div className="text-right font-mono text-zinc-300">{s.account.unrealized_pnl !== null ? money(s.account.unrealized_pnl) : '—'}</div>
              <div className="text-zinc-500">原始保證金</div>
              <div className="text-right font-mono text-zinc-300">{s.account.initial_margin !== null ? money(s.account.initial_margin) : '—'}</div>
              <div className="text-zinc-500">維持（率）保證金</div>
              <div className="text-right font-mono text-zinc-300">{s.account.maintenance_margin !== null ? money(s.account.maintenance_margin) : '—'}</div>
              <div className="text-zinc-500">可動用保證金</div>
              <div className="text-right font-mono text-zinc-300">{s.account.available_margin !== null ? money(s.account.available_margin) : '—'}</div>
              <div className="text-zinc-500">風險指標</div>
              <div className="text-right font-mono text-zinc-300">{s.account.risk_ratio !== null ? `${s.account.risk_ratio.toFixed(2)}%` : '—'}</div>
            </dl>
          )}
        </div>
      ))}

      {/* ── 異動計畫 ── */}
      {plan && (
        <div className="space-y-3 pt-1">
          {plan.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
              {plan.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}

          {plan.checks.length > 0 && (
            <div className="rounded-xl border border-border bg-zinc-900/40 p-3">
              <div className="text-[11px] font-semibold text-zinc-300 mb-2">套用後與截圖的對帳</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[380px] text-[11px]">
                  <thead>
                    <tr className="text-zinc-500 border-b border-border">
                      <th className="text-left font-medium py-1 pr-2">項目</th>
                      <th className="text-right font-medium py-1 pr-2">截圖</th>
                      <th className="text-right font-medium py-1 pr-2">套用後</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {plan.checks.map((c, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-2 text-zinc-400">{c.label}</td>
                        <td className="py-1 pr-2 text-right font-mono text-zinc-300">{c.screen}</td>
                        <td className="py-1 pr-2 text-right font-mono text-zinc-300">{c.computed}</td>
                        <td className="py-1 text-right">
                          {c.ok
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 inline" />
                            : <AlertTriangle className="w-3.5 h-3.5 text-amber-400 inline" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-zinc-900/40 p-3 space-y-1.5">
            <div className="text-[11px] font-semibold text-zinc-300">會做的異動（{plan.ops.filter((o) => o.kind !== 'closed_skip').length}）</div>
            {plan.ops.length === 0 && <p className="text-[11px] text-zinc-500">沒有可套用的異動。</p>}
            {plan.ops.map((o, i) => (
              <p
                key={i}
                className={`text-[11px] flex items-start gap-1.5 ${
                  o.kind === 'closed_skip' ? 'text-zinc-600' : o.warn ? 'text-amber-400' : 'text-zinc-300'
                }`}
              >
                <span className="mt-1 w-1 h-1 rounded-full bg-current shrink-0" />
                <span>
                  {o.text}
                  {typeof o.amount === 'number' && o.amount !== 0 && (
                    <span className={o.amount >= 0 ? 'text-bull' : 'text-bear'}>{'　'}現金 {money(o.amount)}</span>
                  )}
                </span>
              </p>
            ))}
            {plan.cash_delta !== 0 && (
              <p className="text-[11px] text-zinc-400 pt-1 border-t border-border/50">
                保證金專戶現金餘額合計變動{' '}
                <span className={`font-mono font-semibold ${plan.cash_delta >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {money(plan.cash_delta)}
                </span>
                （{money(state.cash)} → {money(plan.next.cash)}）
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-zinc-400">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={adoptSnapshot} onChange={(e) => { setAdoptSnapshot(e.target.checked); setApplied(false); }} className="accent-cyan-500" />
              對不起來時以未平倉截圖為準覆寫
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={applyPrices} onChange={(e) => { setApplyPrices(e.target.checked); setApplied(false); }} className="accent-cyan-500" />
              同時把截圖上的市價當現價
            </label>
          </div>
          <p className="text-[10px] text-zinc-600 -mt-1">
            現價預設不吃截圖——期交所報價通常比截圖新，覆蓋過去會讓風險指標倒退回截圖那一刻。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => { onApply(plan); setApplied(true); }}
              disabled={!plan.changed || applied}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-500/90 text-white text-xs font-semibold rounded-lg hover:bg-emerald-500 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {applied ? '已套用' : plan.changed ? '套用這些異動' : '沒有需要更新的內容'}
            </button>
            {badCheck && !applied && (
              <span className="text-[11px] text-amber-400">有對不起來的項目，確認過再套用</span>
            )}
            {applied && <span className="text-[11px] text-emerald-400">已寫入並同步雲端</span>}
          </div>
        </div>
      )}
    </div>
  );
};
