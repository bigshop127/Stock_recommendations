import React, { useEffect, useState } from 'react';
import { Smartphone, Monitor, ShieldAlert } from 'lucide-react';

export const RwdVerify: React.FC = () => {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isBelowMd = windowWidth < 768;

  return (
    <div className="space-y-6">
      {/* 頂部標題 */}
      <div>
        <h2 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
          RWD 策略與響應式規格驗證
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          本網頁說明台股籌碼審查網站的 RWD 設計系統策略，並提供即時的視窗尺寸監測。
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* RWD 規則與規格說明 */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-card border border-border rounded-xl p-6 space-y-4">
            <h3 className="font-semibold text-sm text-zinc-200 border-b border-border/60 pb-3">
              1. 專案 RWD 設計策略 (Desktop-First)
            </h3>
            <div className="space-y-3 text-xs leading-relaxed text-zinc-400">
              <p>
                本網站為專業交易員提供大量圖表與籌碼分析數據，極度依賴大螢幕的可視範圍。經需求盤點後，本網站在 **Phase 0** 定義了以下響應式限制：
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong className="text-zinc-200">桌上型電腦與平板優先 (Width &gt;= 768px, 即 Tailwind `md` 及以上)</strong>：
                  此為主要渲染與操作目標。左側提供常駐導覽欄，右側提供多欄的資訊格線系統（大盤多欄、個股三欄式分析圖表等）。
                </li>
                <li>
                  <strong className="text-zinc-200">不支援行動端 (Width &lt; 768px, 即小於 `md`)</strong>：
                  當螢幕寬度小於 768px 時，網站將主動遮罩，並提供清晰的警告看板引導使用者切换至桌機。此策略可大幅縮短初期前端开发時程，專注於大螢幕數據渲染效率。
                </li>
              </ul>
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-6 space-y-4">
            <h3 className="font-semibold text-sm text-zinc-200 border-b border-border/60 pb-3">
              2. 斷點與佈局 Token 說明
            </h3>
            <div className="space-y-3 text-xs text-zinc-400">
              <p>我們的格線與寬度系統使用以下 Tailwind 斷點定義：</p>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-zinc-500 border-b border-border/40">
                      <th className="pb-2 font-semibold">斷點</th>
                      <th className="pb-2 font-semibold">寬度門檻</th>
                      <th className="pb-2 font-semibold">佈局策略</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/20">
                      <td className="py-2 font-mono text-zinc-300">xs / sm</td>
                      <td className="py-2 font-mono">&lt; 768px</td>
                      <td className="py-2 text-bull font-semibold">不支援。啟動防呆遮罩警告。</td>
                    </tr>
                    <tr className="border-b border-border/20">
                      <td className="py-2 font-mono text-zinc-300">md</td>
                      <td className="py-2 font-mono">&gt;= 768px</td>
                      <td className="py-2">平板/小筆電佈局。側邊欄收折或置頂，網格調整為雙欄。</td>
                    </tr>
                    <tr>
                      <td className="py-2 font-mono text-zinc-300">lg / xl</td>
                      <td className="py-2 font-mono">&gt;= 1024px</td>
                      <td className="py-2 text-bear font-semibold">完整桌機版。側邊欄常駐，全功能儀表板多欄展開。</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* 實體監測與狀態驗證 */}
        <div className="bg-card border border-border rounded-xl p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-semibold text-sm text-zinc-200 border-b border-border/60 pb-3 mb-4">
              即時視窗狀態監控
            </h3>
            <div className="space-y-6">
              {/* 即時寬度顯示 */}
              <div className="bg-zinc-950/60 border border-border/80 rounded-lg p-4 text-center">
                <div className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">Current Width</div>
                <div className="text-2xl font-bold font-mono text-primary mt-1">{windowWidth}px</div>
              </div>

              {/* 裝置對應判定 */}
              <div className="space-y-3">
                <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                  !isBelowMd ? 'bg-bear/10 border-bear/20 text-bear' : 'bg-zinc-900/40 border-border text-zinc-500'
                }`}>
                  <Monitor className="w-5 h-5 shrink-0" />
                  <div className="text-xs">
                    <div className="font-bold">桌機與平板模式 (Enabled)</div>
                    <div className="text-[10px] opacity-80 mt-0.5">寬度大於或等於 768px。功能全部解鎖。</div>
                  </div>
                </div>

                <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                  isBelowMd ? 'bg-bull/10 border-bull/20 text-bull font-semibold' : 'bg-zinc-900/40 border-border text-zinc-500'
                }`}>
                  <Smartphone className="w-5 h-5 shrink-0" />
                  <div className="text-xs">
                    <div className="font-bold">行動裝置模式 (Blocked)</div>
                    <div className="text-[10px] opacity-80 mt-0.5">寬度小於 768px。將遮罩主內容並呈現防呆畫面。</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="text-[10px] text-zinc-500 leading-relaxed pt-6 border-t border-border/40 mt-6">
            請嘗試拉動瀏覽器視窗寬度，並觀察右側檢測器之動態切換與遮蔽警告效果。
          </div>
        </div>
      </div>

      {/* RWD 遮罩警告 DEMO (當小於 md 時，全螢幕或內容會顯示遮罩看板) */}
      {isBelowMd && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-md flex items-center justify-center p-6 text-center">
          <div className="max-w-md bg-card border border-border rounded-xl p-8 space-y-6 shadow-2xl">
            <div className="w-16 h-16 bg-bull/10 border border-bull/20 rounded-full flex items-center justify-center mx-auto animate-bounce">
              <ShieldAlert className="w-8 h-8 text-bull" />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-bold text-zinc-100">檢視限制：不支援此解析度</h3>
              <p className="text-xs text-zinc-500 leading-relaxed">
                偵測到您的螢幕寬度小於 **768px** (當前: <strong className="text-primary font-mono">{windowWidth}px</strong>)。根據專案 Phase 0 規範，本網站不提供桌機以外的行動端畫面支援。
              </p>
            </div>
            <div className="bg-zinc-950/60 p-3 rounded-lg border border-border/60 text-[11px] text-zinc-400">
              請放大瀏覽器視窗，或在桌上型電腦/大螢幕平板上開啟以利審查籌碼圖表。
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
