# 優化專案 8 — 個股研究摘要卡（規則式五力雷達，仿 Danny Quant）

> 互動模式（沿用全案）：本檔由 Claude 給「希望看到的內容＋驗收標準＋規格」並解答疑問；**你寫 code**，寫完 Claude review。
> 開工方式：開新對話「請你幫我去閱讀 `review-web\docs\prompts\opt8-research-brief.md`，然後根據裡面的說明進行」。
> 參考範本：`C:\Users\bigsh\Downloads\概念圖\IMG_20260601_140423_560.jpg`（Danny Quant 五力雷達洞察卡）＋ `IMG_20260601_140439_691.jpg`（研究摘要卡：加分/扣分因素＋觀察點/失效訊號）。**2026-07-02 依實際截圖定稿**。
> **相依：無**——本案只吃 `StockDetail` 頁面**既有六個資料 state**（blended 訊號、日K、籌碼、基本面、新聞、報價），**零新後端、零新請求、零 LLM**。

## 1. 本案目標

`StockDetail` 報價 header 正下方新增一張「研究摘要卡」，把散落全頁的訊號濃縮成一眼可讀的收盤後摘要（範本兩張卡合體）：

1. **綜合分數＋狀態 pill**：大字 `blended.score`（0–100）＋ action 徽章（BUY 紅／SELL 綠／HOLD·WATCH 灰，全站慣例）＋規則式狀態標籤（「多項利多訊號並存」等，§2.3）。
2. **五力雷達（手刻 SVG）**：五軸＝**動能／技術／籌碼／基本面／情緒**，每軸 0–100、軸標籤附分數（範本樣式）。三軸直接取 `blended.factors` 因子分（technical／chips／sentiment），動能與基本面由前端純函式合成（§2.1）。**範本的「估值」軸留給 opt9**（屆時有同業 PE 資料再評估換軸）。
3. **規則式 headline**：一句話點出最強面向＋關鍵真數字（範本句式，§2.4）。
4. **加分因素／扣分因素 兩欄**：每條＝敘述（引用真數字）＋灰色小字出處行（範本樣式：`籌碼 · 近5日法人買賣超合計`）。加分紅、扣分綠（範本恰同台股慣例，直接照做）。扣分空時顯示範本原句「暫無主要拖累。」
5. **觀察點／失效訊號**：4 條 checklist（60MA／20MA／量比／法人5日），每條 ✓/✗＋現況值＋**具體門檻價/目標值**；底部一行失效訊號（§2.6）。
6. **誠實聲明**：卡頂小字「本摘要為當日收盤後計算，數值不會隨盤中即時行情變動」；卡底小字「五軸與因素為規則式合成，可在下方各卡回溯原始資料；非投資建議」。

**本案不做（backlog）**：個股強度／產業連動軸（需同業 universe，opt9 之後）、戰情卡分享海報（backlog②，依賴本案輸出）、估值軸。

## 2. 五力分數與規則式文案（本案核心，要可測）

新增純函式模組 `review-web/src/lib/stockBrief.ts`（**不碰 DOM、不發請求**）＋vitest：

```ts
export interface StockBriefInput {
  blended: StockSignal | null;            // signalState.data?.blended
  dailyOhlcv: OhlcvRow[] | null;          // 日K還原價快照（見 §5 坑：與分K切換隔離）
  chips: StockChips | null;               // 既有 20 日籌碼
  fundamentals: StockFundamentals | null; // 既有基本面
  news: StockNews | null;                 // 既有新聞輿情
}
export interface ForceScore { key: 'momentum'|'technical'|'chips'|'fundamental'|'sentiment';
  label: string; score: number | null; source: 'factor'|'derived'; }   // score null=資料不足
export interface BriefBullet { text: string; provenance: string; tone: 'plus'|'minus'; }
export interface Checkpoint { label: string; pass: boolean; current: string; target: string; }
export interface StockBrief {
  overall: number | null; action: string | null; stateLabel: string; headline: string;
  forces: ForceScore[];        // 固定 5 筆、順序固定：動能/技術/籌碼/基本面/情緒
  plus: BriefBullet[]; minus: BriefBullet[];   // 每側最多 4 條
  checkpoints: Checkpoint[]; invalidation: string[];
  asOf: string | null; degraded: boolean;      // blended 整包缺 → true（整卡灰態）
}
export function buildStockBrief(input: StockBriefInput): StockBrief;
```

### 2.1 五軸來源（定案）

| 軸 | 來源 | 說明 |
|---|---|---|
| 技術 | `blended.factors` key=`technical` 的 score | 後端因子分直接用 |
| 籌碼 | 同上 key=`chips` | 同上 |
| 情緒 | 同上 key=`sentiment` | 同上（引擎名「消息情緒面」，含老王子訊號） |
| 動能 | 前端合成（§2.2），輸入＝日K還原價 | 均線排列＋20日報酬＋量比 |
| 基本面 | 前端合成（§2.2），輸入＝fundamentals | 月營收 YoY＋EPS 季變動 |

任一軸輸入缺 → 該軸 `score: null`、雷達頂點畫在中心、軸標籤灰字「—」；**不得用 50 假裝中性**。

### 2.2 動能／基本面公式（定案，權重寫死一處可微調）

先把日K依 `date` 升冪排序，取尾端算：MA5/MA20/MA60（收盤簡單均）、`ret20` ＝近20根漲跌%、量比 `volr` ＝ 5日均量／20日均量。

```
動能（<20 根 → null；<60 根 → ma_part 略過 MA60 相關兩項、其餘照算）：
  ma_part  = (close>MA5?25:0)+(MA5>MA20?25:0)+(MA20>MA60?25:0)+(close>MA60?25:0)   // 0~100
  ret_part = clamp(50 + ret20 * 2.5, 0, 100)        // ±20% 飽和
  vol_part = clamp(50 + (volr − 1) * 50, 0, 100)    // 0~2× 映射；vol20=0 → 該項略過並重正規化
  momentum = round(0.4*ma_part + 0.4*ret_part + 0.2*vol_part)

基本面（兩部分皆缺 → null；缺一取另一）：
  rev_part = clamp(50 + 最新月營收YoY * 1.25, 0, 100)   // ±40% 飽和
  eps_part = clamp(50 + EPS季變動% * 1.25, 0, 100)      // 最新季 vs 前一季；前一季 EPS ≤ 0 → 該項不出
  fundamental = round(可用部分平均)
```

### 2.3 狀態標籤（依加分/扣分條數，定案）

```
plus≥3 且 minus=0 → 「多項利多訊號並存」    minus≥3 且 plus=0 → 「多項利空訊號並存」
plus≥1 且 minus≥1 → 「多空訊號並存」        其餘 → 「訊號中性」
degraded → 「資料不足」
```

### 2.4 headline 模板（範本句式，禁預測性字眼）

「{name}（{code}）目前資料訊號為「{狀態標籤}」，五力綜合分數 {overall}。當下{最強軸 label}面向最突出（{該軸分} 分），關鍵觀察點：{該軸對應的首要加分/扣分句}。」最強軸無對應 bullet → 句尾改「詳見下方因素列表」。degraded → 「訊號資料不足，僅顯示可用區塊」。

### 2.5 加分／扣分規則池（門檻定案；每側取強度排序前 4，同類別最多 2 條）

| 類別 | 加分（tone=plus） | 扣分（tone=minus） | 出處行 |
|---|---|---|---|
| 籌碼 | 法人5日累積買超 ≥ +500 張 →「法人 5 日累積買超 +X 張」 | ≤ −500 張 | `籌碼 · 近5日 total_net_buy_qty 合計` |
| 籌碼 | 外資／投信連買 ≥3 日 →「外資 N 日連買」 | 連賣 ≥3 日 | `籌碼 · /stocks/:code/chips 逐日` |
| 基本面 | 月營收 YoY ≥ +20% →「月營收年增 +X%」 | ≤ −10% | `基本面 · monthly_revenue {月份}` |
| 基本面 | EPS 季變動 ≥ +15%（前季>0） | ≤ −15% | `基本面 · 季報 EPS {季別}` |
| 動能 | 均線多頭排列（MA5>MA20>MA60） | 空頭排列 | `動能 · 日K還原價 MA5/20/60` |
| 動能 | 近20日漲幅 ≥ +10%／量比 ≥ 1.5× | ≤ −10%／量比 ≤ 0.5× | `動能 · 日K還原價` |
| 情緒 | 新聞情緒分 ≥ 70 且樣本 ≥3 則 | ≤ 30 且樣本 ≥3 則 | `情緒 · /stocks/:code/news 近N則` |
| 情緒 | 老王同向（`agreement==='aligned'`）→「老王 {signal} 與量化同向」 | `conflict===true` →「量化與老王方向背離」 | `情緒 · 老王 {as_of_date}` |

數字格式：張數千分位、% 一位小數；**任何情況不得**出現 `NaN`／`undefined`／`null` 字樣。

### 2.6 觀察點／失效訊號（定案，範本四條照搬）

現價＝日K最後收盤（還原口徑，與 K 線卡一致；**不用** live book 價，卡片是收盤後口徑）：

1. 守住 60 日均線：`close ≥ MA60`，現況＝距離%（`(close−MA60)/MA60`）、目標＝`≥ {MA60 價}`。
2. 維持 20 日均線上方：同式、目標 `≥ {MA20 價}`。
3. 5 日均量維持 1× 以上：現況＝`{volr}×`、目標 `≥ 1.0×`。
4. 法人 5 日累積保持淨買進：現況＝`{X} 張`、目標 `≥ 0`。

失效訊號（固定兩句，帶入真門檻價）：「跌破 60 日均線（收盤 < {MA60}）」「法人轉為連續賣超（5 日累積轉為負值）」。輸入缺的條目直接不出（不顯示假 ✓）。

## 3. 架構鐵律（沿用全案）

- **零後端、零新請求**：只消費 StockDetail 既有六個 state；network 面板請求數與現況完全相同。**嚴禁**在本卡自動打 `/api/agents/decide`。
- 台股色慣例：加分/多＝紅、扣分/空＝綠、中性灰；BUY 紅。雷達填色用中性 primary 色（雷達非多空方向）。
- 不動 `web/`、不動 engine/gateway；`snake_case` 資料欄位照舊；`tsc -b && vite build` 乾淨；vitest 通過。
- 頁面其餘卡片（K線/籌碼/基本面/新聞/AI 審視）**零改動**（除 §5 的日K快照 state）。

## 4. 版面規格

- 位置：報價 header 下、K線列上，12-col 全寬一張卡。
- 桌面（≥1024）：左欄（約 7 col）＝狀態 pill＋headline＋加分/扣分兩欄；右欄（約 5 col）＝綜合分數大字＋五力雷達；觀察點/失效訊號橫貫卡底。
- 手機（<768）：單欄順序＝分數＋pill → 雷達 → headline → 加分/扣分 → 觀察點。
- 雷達手刻 SVG：五邊形 3 圈網格＋軸線＋資料多邊形（半透明填色）＋軸標籤（label＋分數）；別引圖表套件。
- 卡片可整張折疊（右上 chevron，預設展開）——**可選**，非驗收必要。

## 5. 工作清單

- `lib/stockBrief.ts`＋`lib/stockBrief.test.ts`（§2 全部公式與模板）。
- `components/StockBriefCard.tsx`（雷達 SVG＋版面＋灰態；只吃 `StockBrief`＋loading/error props，不 fetch）。
- `pages/StockDetail.tsx`：新增 `dailyRows` 快照 state（日K fetch 成功且 `type==='daily'` 時存一份，**切分K不清掉**）；組 `StockBriefInput` → `useMemo(buildStockBrief)` → 插卡。
- 文件：零新端點 → `contracts.md` 不動；完工後 ROADMAP §8 補紀錄。

## 6. 驗收標準

- [ ] 雷達五軸順序、分數與來源正確：抽 2 檔（1 檔資料齊全如 2330、1 檔近期除權息或新股）手算動能/基本面公式吻合；技術/籌碼/情緒軸＝`blended.factors` 原分。
- [ ] **回溯一致性**（範本核心承諾）：法人5日張數與下方籌碼卡逐日加總一致；營收 YoY 與基本面卡月營收 tab 一致；MA 門檻價與 K 線卡 MA 線尾值一致（同一份還原序列）。
- [ ] 加分/扣分每條都有真數字＋出處行；門檻邊界值行為與 §2.5 一致；扣分空顯示「暫無主要拖累。」
- [ ] 觀察點 ✓/✗、距離%、門檻價正確；失效訊號帶真門檻價。
- [ ] 降級矩陣：blended 缺→整卡灰態＋重試；單一輸入缺→對應軸「—」＋對應條目不出，其餘正常；全程無 NaN/undefined 字樣。
- [ ] K線卡切「分K」再切回，摘要卡數值不變不閃錯（吃快照非共用 state）。
- [ ] network 請求數與改動前相同（零新請求）；三斷點（375/768/1280）不破版；既有卡片零回歸。
- [ ] `tsc -b && vite build` 乾淨、vitest（stockBrief）全綠；未動後端、未動 `web/`。

## 7. 坑（帶進 review）

- 🚨 **`blended.factors` 只有三個因子**（technical/chips/sentiment）——動能與基本面**必須**前端合成，別去 factors 裡找不存在的 key；factors 也可能整包缺（`unavailable`／降級），全路徑防 null。
- 🚨 **`klineState` 是日K/分K共用 state**：使用者切分K後 `data` 變 intraday rows，直接拿去算 MA 會整卡爆掉 → 必須用獨立日K快照（§5）。
- 日K是**還原價**（`ohlcv?adjust=1`）：近期除權息個股的 MA 門檻價會與市價有落差——口徑與 K 線卡一致即可，卡底聲明已涵蓋；別混用 live book 價當現價。
- 日K依 `date` **升冪排序後再算**（別假設 API 回序）；chips `data[]` 同理（mock 是新到舊，別硬編順序），取「最近 5 筆」要先排序。
- 法人張數欄位可能 null：加總當 0，但**全 null → 該條/該觀察點不出**；連買天數遇 null 中斷（保守）。
- EPS 季變動：前一季 EPS ≤ 0 時百分比無意義 → 該項直接不出，別算出 −300% 嚇人。
- 量比分母 `vol20=0`（新股/長停牌）→ 略過 vol_part 並重正規化權重，別除以零。
- 六個 state 各自 async 到位：卡片以 blended 為主體（沒到→骨架屏），其餘輸入後到時 `useMemo` 自然重算漸進補齊，別等全到才渲染。
- `blended.score` **已含 regime×water gate**（是 gated 後分數）——headline/分數口徑照用即可，別自己把 gate 再乘一次。
- 文案禁預測性字眼（「將上漲」禁用；只描述現況）；範本紅=利多恰同台股慣例，但雷達填色保持中性色。
- PWA SW 快取：上版後看不到新卡先強制重整（已知坑）。
