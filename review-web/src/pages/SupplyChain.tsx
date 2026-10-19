import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { addToFolder, getFolderList, getFolders, subscribeFolders } from '../lib/userStore';
import { SUPPLY_CHAIN_CODES } from '../lib/supplyChain';

/**
 * AI 產業鏈 3D 拆解（使用者自己做的單檔 3D 頁，放在 public/teardown/index.html，用 iframe 嵌進來）。
 *
 * 兩邊用 postMessage 溝通（同源，雙方都檢查 origin 與來源視窗）：
 *   3D 頁 → 這裡：teardown:ready（載入好了，把資料送過來）、teardown:open-stock（開個股頁）、
 *                 teardown:add（把沒存過的台股加進某個資料夾）
 *   這裡 → 3D 頁：teardown:folders（資料夾清單＋內容，資料夾一變就重送）、teardown:quotes（收盤價／本益比）
 */

type FromTeardown =
  | { type: 'teardown:ready' }
  | { type: 'teardown:open-stock'; code: string }
  | { type: 'teardown:add'; code: string; name: string; folder: string };

type Quotes = Record<string, { close: number; pe: number | null }>;

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

/**
 * 收盤價／本益比：證交所估值表一次抓齊上市；上櫃（台燿、環球晶、雙鴻…）不在表上，
 * 收盤價改用日 K 最後一根補、本益比留空。估值表整個抓不到就不補，免得 38 檔全部各打一次日 K。
 */
async function loadQuotes(onUpdate: (quotes: Quotes, names: Record<string, string>) => void): Promise<void> {
  const quotes: Quotes = {};
  const names: Record<string, string> = {};
  const metrics = await api.getStockMetrics(SUPPLY_CHAIN_CODES);
  for (const m of metrics.items) {
    if (m.name) names[m.code] = m.name;
    if (m.close != null) quotes[m.code] = { close: m.close, pe: m.pe };
  }
  onUpdate({ ...quotes }, { ...names });
  const missing = SUPPLY_CHAIN_CODES.filter((c) => !quotes[c]);
  if (!missing.length) return;
  await Promise.all(missing.map(async (code) => {
    try {
      const o = await api.ohlcv(code, { start: isoDaysAgo(14) });
      const last = o.data[o.data.length - 1];
      if (last) quotes[code] = { close: last.close, pe: null };
      if (o.name && !names[code]) names[code] = o.name;
    } catch {
      // 上櫃補價只是加註，抓不到就不顯示
    }
  }));
  onUpdate({ ...quotes }, { ...names });
}

export function SupplyChain() {
  const [params] = useSearchParams();
  const co = params.get('co');
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const quotesRef = useRef<Quotes | null>(null);
  const namesRef = useRef<Record<string, string>>({});
  const [height, setHeight] = useState<number | null>(null);

  const post = useCallback((msg: object) => {
    frameRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);
  const postFolders = useCallback(() => {
    post({ type: 'teardown:folders', folders: getFolderList(), stocks: getFolders() });
  }, [post]);
  // 3D 頁載入好（teardown:ready 或 iframe onLoad，哪個先到都行）就把手上的資料整包送過去；
  // 在那之前送的訊息會打到 iframe 還沒換掉的 about:blank 而遺失
  const postAll = useCallback(() => {
    postFolders();
    if (quotesRef.current) post({ type: 'teardown:quotes', quotes: quotesRef.current });
  }, [post, postFolders]);

  // 從 iframe 頂端填到視窗底：手機側邊欄收起時、桌機頁首下方都剛好滿版
  useLayoutEffect(() => {
    const fit = () => {
      const el = boxRef.current;
      if (el) setHeight(Math.max(360, Math.floor(window.innerHeight - el.getBoundingClientRect().top)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => subscribeFolders(postFolders), [postFolders]);

  useEffect(() => {
    let cancelled = false;
    loadQuotes((quotes, names) => {
      if (cancelled) return;
      quotesRef.current = quotes;
      namesRef.current = names;
      post({ type: 'teardown:quotes', quotes });
    }).catch((e) => console.error('AI 產業鏈收盤價抓取失敗（只影響價格標註）', e));
    return () => { cancelled = true; };
  }, [post]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frameRef.current?.contentWindow) return;
      const msg = e.data as FromTeardown | null;
      if (msg?.type === 'teardown:ready') {
        postAll();
      } else if (msg?.type === 'teardown:open-stock' && /^\d{4,6}[A-Z]?$/.test(msg.code)) {
        navigate(`/stock/${msg.code}`);
      } else if (msg?.type === 'teardown:add' && /^\d{4,6}[A-Z]?$/.test(msg.code)
        && getFolderList().some((f) => f.id === msg.folder)) {
        addToFolder(msg.folder, {
          code: msg.code,
          name: namesRef.current[msg.code] || String(msg.name || ''),
          added_at: new Date().toISOString(),
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate, postAll]);

  const src = `${import.meta.env.BASE_URL}teardown/index.html${co ? `?co=${encodeURIComponent(co)}` : ''}`;
  return (
    // -m-6 抵掉版面內容區的 p-6，3D 畫面貼齊左右與底邊
    <div ref={boxRef} className="-m-6" style={height ? { height } : undefined}>
      {/* key＝src：換公司時整個 iframe 重建，不在瀏覽器上一頁堆一筆 iframe 內部紀錄 */}
      <iframe
        key={src}
        ref={frameRef}
        src={src}
        title="AI 產業鏈 3D 拆解"
        onLoad={postAll}
        className="block w-full h-full border-0 bg-[#070b0c]"
      />
    </div>
  );
}
