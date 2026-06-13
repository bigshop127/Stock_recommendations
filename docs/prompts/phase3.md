# 階段 3：多因子量化引擎 + 回測核心

> **使用方式**：開新對話貼「請幫我閱讀 docs/prompts/phase3.md 然後按照裡面的說明進行。」
> 執行者請先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、階段 2 的數據 API，再依本檔執行；完成後務必做「完成收尾清單」。

## 你的角色
資深量化策略工程師。這是整個專案最硬核的一階段——產出「能回測的策略」這個核心資產。

## 專案背景（共用）
- 路徑：`C:\CC AI Agent`。階段 1（契約、多因子定案）、階段 2（engine 台股數據層）已完成。
- 既有量化雛形（描述於 `scripts/puhui_synthesize.js`）：RSI+MA+三陽開泰，6 條件：
  1.趨勢 Close>MA5>MA10>MA20>MA60 2.動能 RSI14>=50 3.量能 Vol>1.2×VolMA20
  4.型態 三陽開泰回檔≤3天 5.乖離 (Close/MA10-1)<8% 6.大盤 0050>MA60
- 多因子模型見 `docs/scoring-model.md`（階段 1 定案）。終局見 `docs/ROADMAP.md`。

## 本階段目標（重點：本層「確定性、可回測」，禁用 LLM）
1. 實作確定性訊號引擎，支援**兩種模式**：
   - **波段（swing）**：上面 6 條件 + 多因子加權分數 → `StockSignal`（BUY/SELL/WATCH/HOLD、score、各因子分、理由）。
   - **短線當沖（daytrade）**：吃富果盤中資料（量能爆發、內外盤、開盤強弱、五檔），產當沖候選分數。**盤口因子標 live-only，回測時排除或近似**。
2. 各因子逐一實作可計算公式（依 `docs/scoring-model.md`）；數據缺口用規格裡的近似法，輸出標注信心度。
3. 實作**向量化回測器**（純 pandas，**不呼叫任何 LLM**）：給定股票清單 + 區間 + 進出場規則 → `BacktestResult`（累積報酬、年化、Sharpe、最大回撤、勝率、交易次數、權益曲線）。**避免未來函數**（指標只能用當日及之前資料）。
4. 加「權重調整」掛勾：可掃不同因子權重看回測績效（簡單 grid 即可，先別上重型最佳化）。
5. engine API：
   - `GET /signal?code=2330&date=&mode=swing|daytrade`
   - `POST /backtest`（body: codes[], start, end, rules）→ 績效 + 權益曲線

## 限制與原則
- **回測層禁用 LLM**（成本/速度）；LLM 是階段 5 的疊加層。
- 不要動 `puhui_daily.cjs`。
- 當沖模式回測受富果歷史限制 → 明確標示能回測到哪、哪些只能 forward 驗證。

## 驗收標準
- 對 2330 產出當日波段訊號 + 各因子拆解與解釋。
- 對一籃子台股跑 1-2 年波段回測，輸出完整績效 + 權益曲線。
- 有簡短報告示範回測結果，並標明哪些因子因數據缺口被近似/排除。

## 完成收尾清單（DoD）
1. 更新 `docs/ROADMAP.md`：階段 3 標 ✅，記錄因子實作狀態與回測結果摘要。
2. 更新 Obsidian：`...\財經APP開發\階段3-完成紀錄.md` + `開發進度.md`（附回測績效）。
3. 更新記憶 + `MEMORY.md`。
4. 程式放 `engine/`，回測報告放 `docs/` 或 `engine/reports/`。
5. git commit（`phase3: 多因子引擎與回測`），先別 push 等我確認。

## 開始方式
先讀 `docs/ROADMAP.md`、`docs/scoring-model.md`、階段 2 數據 API，提出引擎與回測的模組設計（含當沖模式如何處理盤口 live-only）讓我確認，再動手。
