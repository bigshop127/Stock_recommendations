# 優化專案 22 — 族群（題材）熱力圖：細分族群 treemap ＋成交值前 30 ＋族群鑽取

> 互動模式（沿用全案）：Claude 給規格＋驗收標準；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt22-group-heatmap.md`，然後根據裡面的說明進行」。
> **相依**：無（opt6 已完工）。
> **範圍**：🟢 **純前端、零新後端、零新請求、零新資料源、免重啟 engine/gateway**。
> **資料表已備妥**：`review-web/src/lib/stockGroups.ts`（Claude 已寫好並驗證，見 §3）。

---

## 0. 立場先講清楚（別踩到已定調的線）

參考畫面＝ aistockmap `?activeTab=heatmap` 的 treemap。本案**只仿版面與互動，族群對照表 100% 自建、資料 100% 走自家 TWSE**。

不是新立場，是延續既有決議：
- ROADMAP §8 **增修 G（2026-07-05）**：「婉拒系統性爬取 aistockmap 之題材策展清單（他站編輯 IP／ToS 風險）；改為視覺仿其 finviz 式 treemap、資料一律走自家 TWSE、**題材對照表若要做則以公開常識自建**」。
- **opt15**：「不抄 aistockmap 題材 basket，改用官方 TWSE 產業別」。

**本案就是去兌現增修 G 那句「題材對照表若要做則以公開常識自建」。** `stockGroups.ts` 由 Claude 依公開常識編寫，**不得從參考畫面謄抄其族群名或成分股**。

> 順帶一提：opt5 本來就是「仿 aistockmap.com」做的，所以現有 `SectorHeatmap.tsx:286` 的說明文字與參考畫面幾乎逐字相同（「依產業平均漲跌幅度(絕對值)顯示區塊大小，顏色深淺代表漲跌方向與強度」）。這是既成事實，本案不動它。

---

## 1. 現況與「凌亂」的根因

使用者原話：「產業熱力圖太凌亂」。**根因不是畫法，是分類粒度。**

- `engine/app/api/market.py:392` `get_sector_by_code()` 取 FinMind `TaiwanStockInfo.industry_category`＝**TWSE 官方產業別**。
- 1082 檔上市股擠進 **36 個分類**，粒度不一——ROADMAP opt6 完工紀錄早記過：「部分大型股落粗分類**「電子工業」（233 檔大傘，含台積電）**而非細分類「半導體業」」。
- 結果：**被動元件／功率元件／記憶體全部埋在「半導體業」「電子零組件業」底下看不見**。

**好消息**：現有「產業聚合」檢視（`sectorTiles` useMemo，`SectorHeatmap.tsx:161–174`）**已經就是參考畫面的版面**——`value: Math.max(Math.abs(s.change_pct!), FLOOR)` 就是「區塊面積＝絕對漲跌幅」。缺的只有三件事：**外層 key 換族群、砍到前 30、點進去鑽取**。

---

## 2. 本案目標

1. 新增族群對照表（已備妥）＋前端聚合，`/heatmap` 加**第三個檢視「族群」並設為預設**。
2. 族群 treemap：**面積＝|族群平均漲跌%|**、**顏色＝漲跌方向與強度**（同參考畫面、同現有 `getChangeColor`）。
3. 只顯示 **依成交值排序的前 30 個族群**（見 §4，這是使用者定調的選取規則）。
4. 點族群 → `/heatmap/group/:name` 族群總覽（複用既有 `SectorDetail.tsx` 樣式）。
5. **明確不做**（使用者本輪已砍）：❌ 卡片牆 ❌ 熱度分數 ❌ 法人買超／T86 ❌ 規則式敘述句 ❌ 任何 engine/gateway 改動。

---

## 3. 資料層：`review-web/src/lib/stockGroups.ts`（已備妥，勿重寫）

Claude 已寫好並以 2026-07-14 universe 驗證。**現況數字（驗收基準）**：

| 項目 | 數字 |
|---|---|
| 大類（category） | 11 |
| 族群（group） | 75 |
| 收錄代號 | 523 |
| 重複代號 | **0** |
| 不在 universe 的幽靈代號 | **0** |
| **成交值覆蓋** | **98.2%** |

匯出三個東西：`GROUPS_VERSION`、`STOCK_GROUPS`（大類→族群→代號陣列）、`CODE_TO_GROUP`（代號→`{group, category}` 的 `ReadonlyMap`，模組載入時建一次，O(1) 查）。

### 3.1 為什麼是 `.ts` 不是 `.json`（**別改回 JSON**）

`tsconfig.app.json` **沒開 `resolveJsonModule`**，且開了 `noUnusedLocals`/`noUnusedParameters`。用 `.ts` 匯出常數＝零 tsconfig 改動、有型別檢查、不碰 VM build 嚴格性地雷（見記憶 [[stock-review-web-project]]：VM `npm run build`＝`tsc -b` 比本機 `tsc --noEmit` 嚴格）。

### 3.2 未收錄的個股＝**不進熱力圖**（使用者定調）

使用者本輪定調「長時間冷門或是成交量低的先放棄」。故：

- `CODE_TO_GROUP.get(code)` 回 `undefined` 者**直接跳過**，不聚合、不顯示。
- **不做** `官方產業:{sector}` fallback、**不做** `provenance` 欄位（前一版規格有，本輪砍掉）。
- 523 檔已涵蓋 **98.2% 成交值**，選前 30 個族群後實測涵蓋 **88.7% 成交值**——夠用。
- 未收錄的 top300 有 11 檔（`4916 事欣科 / 7788 松川精密 / 6278 台表科 / 6834 天二科技 / 6831 邁科 / 2312 金寶 / 6944 兆聯實業 / 2495 普安 / 7795 長廣 / 7822 倍利科 / 9105 泰金寶-DR`，多為 EMS 代工廠與一檔 DR）——主營歸屬需查證才敢寫，故留白。**這是刻意的，不是漏做。**

### 3.3 ⚠️ universe 只有上市（TWSE），沒有上櫃（TPEx）

`/api/market/stock-heatmap` 走 `MI_INDEX ALLBUT0999`，**只涵蓋上市**。實測 `5347 世界先進`、`3324 雙鴻`、`6182 合晶`、`4979 華星光` **皆不在 1082 檔內**。

後果：**部分族群天生缺角**——「晶圓代工」只有 3 檔（缺世界先進）、「光通訊」缺華星光。**UI 必須標注「僅上市（TWSE）」**（§6.4），否則使用者會質疑族群檔數。這是資料源邊界，**不要為此接上櫃資料源**（超出本案範圍；使用者本輪明示「上櫃不用」）。

### 3.4 維護

新股上市／族群調整＝直接改 `stockGroups.ts`，同步更新 `GROUPS_VERSION`。無需動任何邏輯。

---

## 4. 選取規則：**成交值前 30**（面積仍＝|漲跌%|）

### 4.1 規則

```
候選 = 75 個 curated 族群中，avg_change_pct 非 null 者
排序 = 族群成交值合計（turnover）降序
取   = 前 30
面積 = Math.max(Math.abs(avg_change_pct), 0.05)   ← 沿用現有 FLOOR，別讓 0% 族群消失
顏色 = getChangeColor(avg_change_pct)             ← 現有函式，別另寫
```

### 4.2 為什麼是「成交值前 30」而不是「漲跌幅前 30」（**這是使用者拍板的，別自作主張改回去**）

使用者原話有兩句互相打架：「**先金融**、電子族群、熱門族群」＋「只要**漲跌幅前三十大**的族群」。

**Claude 實測三個交易日證明兩者不可兼得——依 |漲跌幅| 取前 30，金融入選數恆為 0**：

| 日期 | 金控平均漲跌 | 前 30 名裡的金融 | 前 30 紅綠比 |
|---|---|---|---|
| 2026-07-14 | −0.84% | **0 個** | 全綠 30 |
| 2026-07-02 | −0.93% | **0 個** | 紅 27 / 綠 3 |
| 2026-06-26 | −1.64% | **0 個** | 全綠 30 |

金控是低波動股（動 0.8% 就了不起），同日封測／被動元件在跌 5.35%。**依絕對漲跌幅排序，金融結構性永遠排不進去**，且前 30 有 11–13 個都是半導體、趨勢日整片單色。

改用**成交值前 30**後（使用者已選定）：

```
=== 2026-07-14｜成交值前30（實測）===
 1 晶圓代工        佔市11.67% |  -0.72% | 3檔
 2 被動元件        佔市 9.41% |  -5.35% |13檔
 3 記憶體         佔市 8.00% |  +0.22% | 4檔
 4 PCB印刷電路板    佔市 5.49% |  -3.61% |16檔
 5 塑化          佔市 5.23% |  +0.67% |27檔
 6 ABF載板       佔市 5.12% |  -1.12% | 3檔
 7 IC設計·運算與網通  佔市 4.78% |  -1.93% | 9檔
 8 封測          佔市 4.46% |  -5.35% |12檔
 9 面板          佔市 3.64% |  -4.31% | 5檔
10 AI伺服器與代工    佔市 3.31% |  -0.68% |10檔
…
14 金控          佔市 2.25% |  -0.84% |13檔   ← 金融進得去了
…
30 通信服務        佔市 0.69% |  -0.62% | 3檔

大類分布: 半導體10 / 電子零組件7 / 電腦與週邊5 / 傳產2 / 光電2 / 能源2 / 金融1 / 服務1
前30涵蓋成交值 88.7% | 面積最大/最小＝24倍（treemap 有層次不會糊）
三日金融入選: 07-14 金控 / 07-02 金控 / 06-26 金控（每天都在）
```

**你實作完拿 2026-07-14 重跑，前 30 名單與順序應該對得上這張表**（§7 驗收 #4）。

### 4.3 兩個已知且**可接受**的副作用（別當 bug 修）

1. **高成交值但沒動的族群會是一小條**。例：記憶體佔成交值 8%（第 3 大）但只漲 +0.22% → 面積約為被動元件（−5.35%）的 1/24。**這正是參考畫面的規則（面積＝漲跌幅、非成交值）**，aistockmap 亦然。`FLOOR=0.05` 保證它不會完全消失。
2. **趨勢日整片單色**。實測 07-14 紅3/綠27、06-26 紅1/綠29——因為當天大盤真的在跌。這是誠實反映，非 bug。**單週/單月**檢視離散度較大，紅綠會混雜（參考畫面就是單週）。

---

## 5. 前端聚合（純前端、零新請求）

`/api/market/stock-heatmap` 已回全市場 1082 檔含 `code/name/sector/close/change_pct/turnover`（契約 §2.12）。**前端自己 map code→group 即可，不需要任何後端改動。**

新增純函式檔 `review-web/src/lib/groupHeatmap.ts` ＋ `groupHeatmap.test.ts`（vitest，比照 `marketSummary.ts` / `treemap.ts` 慣例）：

```ts
export interface GroupAgg {
  group: string;
  category: string;
  avg_change_pct: number;   // 成分股簡單平均（沿用 opt6 口徑）
  turnover: number;         // 族群成交值合計
  turnover_share: number;   // 佔全市場成交值 %
  count: number;            // 成分股檔數（有出現在 universe 者）
  valid_count: number;      // change_pct 非 null 檔數
  up_count: number;
}

/** 聚合全部 curated 族群 */
export function aggregateGroups(stocks: HeatmapStock[]): GroupAgg[];

/** 依成交值取前 N（預設 30） */
export function selectTopGroups(groups: GroupAgg[], n = 30): GroupAgg[];
```

**口徑（沿用 opt6，別自創）**：
- `avg_change_pct`＝成分股**簡單平均**，**只計 `change_pct` 非 null 者**（除權息 X 的不計）。
- `valid_count === 0` 的族群 → **整組排除**（不可算 `0/0`＝NaN 進 treemap，會讓 squarify 爆版）。
- `turnover` 照加全部成分股（含 `change_pct` 為 null 者）。

---

## 6. 前端 UI：`pages/SectorHeatmap.tsx`

### 6.1 三檢視 toggle

`viewMode: 'group' | 'stock' | 'sector'`，**預設 `'group'`**（這是使用者要的新主畫面）。
`?view=` 同步 URL，比照既有 `?period=` 的 `useSearchParams` 寫法。

**⚠️ `'stock'`（個股巢狀 treemap）與 `'sector'`（產業聚合）兩個既有檢視逐位元不動**——它們仍吃官方產業別、仍涵蓋全部 1082 檔。本案只**加**一個檢視。（理由：族群表只收 523 檔，若把 `'stock'` 外層也換成族群，會憑空少掉 559 檔＝功能倒退。）

### 6.2 族群 treemap（新）

**直接複製 `sectorTiles` 那段的形狀改寫**，別重寫 squarify：

```ts
const groupTiles = useMemo(() => {
  if (!data?.stocks) return [];
  const tops = selectTopGroups(aggregateGroups(data.stocks), 30);
  const inputs: TreemapInput<GroupAgg>[] = tops.map((g) => ({
    key: g.group,
    value: Math.max(Math.abs(g.avg_change_pct), 0.05),   // 同現有 FLOOR
    datum: g,
  }));
  return squarify(inputs, CANVAS_W, CANVAS_H);
}, [data]);
```

- 顏色：`getChangeColor(g.avg_change_pct)`（現有函式）。
- 文字分級：沿用現有 `tile.w > 70 && tile.h > 40` / `tile.w >= 32 && tile.h >= 22` 兩段式與 `getTruncatedName`，別讓小格溢出。
- hover tooltip：族群名／大類／平均漲跌%／成交值／佔成交值%／成分股檔數。沿用現有 tooltip DOM 與 `handleMouseMove`。
- 點擊 → `navigate('/heatmap/group/' + encodeURIComponent(g.group) + '?period=' + period)`。

### 6.3 族群鑽取頁 `/heatmap/group/:name`（新）

- 新檔 `pages/GroupDetail.tsx`，**照 `SectorDetail.tsx` 的骨架改**（關鍵指標卡×4 ＋ 個股層級 treemap ＋ 時間切換 ＋ hover tooltip ＋ 點個股跳 `/stock/:code`）。
- 資料同樣復用 `api.marketStockHeatmap()`（跨頁共用 5 分鐘快取，**不重抓**），依 `CODE_TO_GROUP` 過濾出該族群成分股。
- `App.tsx` 加 lazy 路由；`Layout.tsx` header 標題分支比照 `/heatmap/sector/:name`。
- `decodeURIComponent` 要包 `try/catch`（opt6 review 踩過）。
- 查無此族群 → 友善空態＋回熱力圖連結，**不要白畫面**。

> 🚨 **opt15 的教訓（別重踩）**：過濾清單的 key 必須與清單資料同源。本頁的族群成員一律以 `CODE_TO_GROUP` 判定，**不要混用 `sector` 欄位**。

### 6.4 口徑標注（**必做，別省**）

族群檢視的頁尾／說明列必須寫明：
- 「族群分類為**本站自建**（公開常識），非官方分類；官方產業別另見『產業聚合』檢視」
- 「**僅上市（TWSE），不含上櫃**」← §3.3 的坑
- 「僅顯示**成交值前 30** 大族群；區塊面積＝族群平均漲跌幅絕對值」
- 沿用既有「歷史漲跌幅（週/月）採未還原收盤價計算」警語

### 6.5 台股色慣例（鐵律 §3）

漲＝**紅**（`text-bull` `#ef4444`）、跌＝**綠**（`text-bear` `#22c55e`）。`getChangeColor` 已是這個慣例，直接用。

---

## 7. 驗收標準

**資料表**
1. `stockGroups.ts`：`CODE_TO_GROUP.size === 523`；`get('2327')` → `{group:'被動元件', category:'電子零組件'}`；`get('2891')` → `{group:'金控', category:'金融'}`；`get('4916')` → `undefined`。
2. 大類 11 / 族群 75 / 重複代號 0 / 幽靈代號 0（以 2026-07-14 universe 驗）。

**純函式**
3. `aggregateGroups` vitest：`valid_count===0` 的族群被排除、`avg_change_pct` 永不為 NaN、未收錄代號被跳過。
4. **`selectTopGroups` 以 2026-07-14 真實快照跑，前 30 名單與順序對得上 §4.2 那張表**（前 10：晶圓代工／被動元件／記憶體／PCB印刷電路板／塑化／ABF載板／IC設計·運算與網通／封測／面板／AI伺服器與代工；第 14＝金控）。
5. 前 30 涵蓋成交值 ≈ 88.7%。

**UI**
6. `/heatmap` 預設落在「族群」檢視；`?view=stock` / `?view=sector` 可切且 URL 同步。
7. **`'stock'` 與 `'sector'` 兩檢視行為與改版前逐位元一致**（回歸：仍 36 產業、仍 1082 檔）。
8. 族群 treemap 30 格、面積比最大/最小 ≈ 24 倍（2026-07-14）、紅綠符合當日方向（07-14 應為紅3/綠27）。
9. 點族群 → `/heatmap/group/:name` 正確、成分股數與 tooltip 一致；點個股 → `/stock/:code`。
10. `/heatmap/group/不存在的族群` → 空態卡，不白畫面。
11. §6.4 四條口徑標注都在。
12. 重新整理鈕仍傳 `force=true`。

**建置**
13. **`npm run build`（＝`tsc -b && vite build`，不是 `tsc --noEmit`）乾淨 exit 0。**
    > ⚠️ 記憶 [[stock-review-web-project]]：VM `npm run build` 比本機 `tsc --noEmit` 嚴格（`noUnusedLocals`/`noUnusedParameters`），**測試要跑 `npm run build` 本身**，否則本機過、VM 爆、線上還是舊版。
14. 既有 vitest 全綠（不得因本案回歸）。

**部署**
15. **純前端** → 依 `deploy.md`：pull + `npm run build`，**免重啟 engine/gateway**。
16. curl `/review/` 200＋新 chunk 上架。
17. PWA 清快取（`deploy.md §4.4`）。

---

## 8. 坑總表

| # | 坑 | 對策 |
|---|---|---|
| 1 | universe 只有上市、無上櫃 | UI 標注（§6.4），別接上櫃源 |
| 2 | `valid_count===0` → `0/0`＝NaN → squarify 爆版 | 整組排除（§5） |
| 3 | 高成交值低波動族群變小條（記憶體 8% 佔比只得 1/24 面積） | **這是規則不是 bug**（§4.3） |
| 4 | 趨勢日整片單色 | 誠實反映，單週/單月會混色（§4.3） |
| 5 | 本機 `tsc --noEmit` 過、VM `tsc -b` 爆 | 測試跑 `npm run build` |
| 6 | `resolveJsonModule` 沒開 | 表用 `.ts` 不用 `.json`（§3.1） |
| 7 | 混用 `sector` 與 `group` 兩套詞彙過濾（opt15 踩過） | 一律走 `CODE_TO_GROUP` |
| 8 | 把 `'stock'` 檢視外層也換成族群 → 憑空少 559 檔 | **只加檢視、不改既有兩個**（§6.1） |
| 9 | 台股色慣例買紅賣綠 | 用現有 `getChangeColor` |
| 10 | 誘惑：改回「漲跌幅前 30」 | 金融會永遠消失（§4.2 實測），使用者已拍板成交值 |

---

## 9. 完工後要更新的 SSOT

- `review-web/docs/ROADMAP.md`：§8 opt22 列改 ✅＋完工紀錄段落。
- `review-web/docs/contracts.md`：**無需改動**（零後端、零契約變更）。
- Obsidian `C:\obsidian\儲存庫\個股全面審視網`。
- 記憶 `stock-review-web-project.md`。
