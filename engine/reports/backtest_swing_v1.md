# 回測報告：波段引擎 swing_v1（階段 3）

> 產出 2026-06-13。程式：`engine/app/factors/`（因子）、`engine/app/backtest/`（回測）、
> `engine/app/api/`（/signal、/backtest）。原始結果 JSON：`backtest_swing_v1.json`（同目錄）。
> 對齊契約 `docs/contracts/BacktestResult.md`、模型 `docs/scoring-model.md`、數據層 `docs/data-layer.md`。

## 1. 一句話結論

在 **0050 兩年狂飆 +150%** 的大多頭裡，加了大盤環境閘門的波段策略 swing_v1 取得
**+63.2% 累積（年化 +28.6%、Sharpe 2.12、最大回撤僅 −7.6%）**——
**絕對報酬大幅落後 buy&hold，但回撤與波動遠低、風險調整後報酬佳**。這是策略「偏保守、躲波動」
的真實樣貌；趨勢盤吃不滿是已知弱點，留待後續多期/樣本外校準。

## 2. 設定（params）

| 項目 | 值 | 來源 |
|---|---|---|
| 標的池 | 2330,2317,2454,2308,2412,2882,3008,2603（8 檔大型權值股） | 人工挑流動性足 |
| 期間 | 2024-06-03 ~ 2026-06-12（≈2 年，492 交易日） | — |
| 因子權重（live v1） | technical 0.48 / chips 0.32 / sentiment 0.20 | 2026-06-13 網格回填 |
| 回測實際權重 | technical 0.6 / chips 0.4（**sentiment 排除**，重正規化） | 見 §5 |
| 進場 / 出場分數 | 70 / 40 | 網格最佳回填 |
| 環境閘門 gate | 0.5 ~ 1.1（非對稱分段線性） | scoring-model §1.2 |
| 交易成本 | 買 0.1425%＋賣 0.1425%＋證交稅 0.3% = **round-trip 0.585%**（不打折） | phase3 §4.4 |
| 執行時點 | **T 收盤計分 → T+1 開盤成交**（出場同規則） | 無未來函數 |
| 部位 | long-only、等權一籃子（每檔 1/N 獨立進出） | — |

## 3. 績效（metrics）

| 指標 | swing_v1 | 0050 buy&hold |
|---|---|---|
| 累積報酬 | **+63.2%** | **+150.3%** |
| 年化報酬 | +28.6% | — |
| Sharpe | **2.12** | — |
| 最大回撤 | **−7.6%** | 較大 |
| 勝率 | 53.3% | — |
| 交易筆數 | 60 | — |
| 平均持有天數 | 31.9 | — |

權益曲線（1.0 起）：2024-06-03 = 1.000 → 2026-06-12 = **1.632**。完整逐日曲線見 JSON。

## 4. 大盤環境閘門（regime gate）實況

- **實際可用子訊號（3 / 5）**：0050 趨勢（站上 MA60）、**TAIFEX 外資期貨淨未平倉方向**、Put/Call ratio。
- **缺**：FRED 殖利率倒掛 / VIX（本機未填 `FRED_API_KEY`）→ 兩子訊號退出、regime 信心降至 **0.75**。
- 兩年標籤分布：neutral 241、risk_on 192、**risk_off 59** 天。
- **A/D 漲跌家數 = proxy**（外資期貨方向＋P/C＋VIX），非乾淨單一 dataset（data-layer §10），輸出已標註。
- 價值展示：期末 0050 站上 MA60（index_trend +1.0）但外資期貨大空（foreign_fut −0.96）、P/C 偏高
  → regime 被拉回 neutral（gate≈0.95），體現「指數多頭但法人偏空時不全力做多」。

## 5. 因子近似 / 排除說明（誠實標註）

| 因子 | 回測處理 | 原因 |
|---|---|---|
| **F_sentiment** | **整個排除**，technical/chips 重正規化為 0.6/0.4 | 新聞/老王皆無乾淨歷史語料；老王分析 JSON 本 repo 亦不存在（階段4 整合）。情緒只在 live `/signal` 計入 |
| **F_orderbook / 內外盤** | 不進回測 | 盤口 live-only、富果歷史拿不到（既定）。MIS 預設亦無內外盤 |
| **A/D 漲跌家數** | 用 proxy | 無乾淨單一 dataset |
| **FRED 殖利率/VIX** | regime 退出該子訊號、降信心 | 本機未填 FRED key |

## 6. 重大數據品質修正：還原股價（影響回測可信度）

回測初版用 FinMind `TaiwanStockPrice`（**未還原**原始股價）時，**0050 因 2025 年分割出現價格斷點**
（173→52），使 benchmark 假性 −40%、regime 0050 趨勢出現假崩盤。FinMind 免費級的還原資料集
`TaiwanStockPriceAdj` 需付費等級。**解法**：回測價源、benchmark、regime 0050 趨勢改用
**yfinance `auto_adjust` 還原日線**（含除權息＋分割），免費且乾淨（0050 還原後為真實 +150%）。
新增 `service.get_ohlcv_adj`（走 parquet 快取）。**籌碼（FinMind）不受影響**，仍用原 `/data/chips`。

> 連帶修正 TAIFEX：`pcRatioDown`/`futContractsDateDown` 下載端點對查詢窗有上限（跨數月回 HTML），
> 已在 `taifex_client` 內部**分段查詢串接**（期貨 100 日窗、P/C 20 日窗），regime 才能取得整段期貨史。

## 7. 權重網格（phase3 §5 掛勾）

`POST /backtest/grid` 掃 technical:chips 比 × 進出場門檻。本期最佳：
**technical 0.6 / chips 0.4、entry 70 / exit 40 → Sharpe 2.12、累積 +63.2%、MaxDD −7.6%**。
已回填 `engine/app/factors/config.py`（標 v1，註明單期可能過擬合，待多期/樣本外再驗證）。

## 8. 重現

```powershell
cd "C:\CC AI Agent\engine"
.\.venv\Scripts\python.exe -m pytest -q            # 28 passed（含無未來函數/成本測試）
# 真實回測（需 engine/.env 的 FINMIND_TOKEN；regime 需網路取 yfinance/TAIFEX）
.\.venv\Scripts\python.exe -c "from app.backtest.engine import run_backtest; import json; print(json.dumps(run_backtest(['2330','2317','2454'],'2024-06-01','2026-06-12')['metrics'],ensure_ascii=False))"
```

## 8.5 當沖引擎 daytrade 示範（live-only，不回測）

`GET /signal?code=2330&mode=daytrade`（盤後實測，MIS 預設）輸出範例：

- `mode=daytrade`、`live_only=true`、`regime_gate=null`、`book_source=TWSE MIS`。
- **F_orderbook**：五檔委買/賣量力道可算；**內外盤比子訊號退出、重正規化、confidence 降、note 標註**
  （MIS `inner_outer=None`，不可硬填）。
- **F_intraday_tech**：無 `FUGLE_API_KEY` → 分K 不可得 → **退出（weight 0）**。
- **F_market_today**：`^TWII` 當日強弱可得（A/D 用 proxy）。
- **籌碼過濾 gate**：近 20 日均量門檻通過才出當沖候選（處置股/券源過濾待補）。
- 結論：**當沖只能 forward 驗證**；要完整盤口（內外盤/大單）與分K 需富果 key（`BOOK_SOURCE=fugle`）。

## 9. 已知限制 / 待續（階段 4+）

- **趨勢盤吃不滿**：regime gate + 出場門檻偏保守，大多頭絕對報酬輸 buy&hold；需多期/樣本外調參，
  或加入「順勢加碼 / 趨勢過濾」降低空手成本。
- **單期過擬合風險**：v1 權重來自單一 2 年期、8 檔；需擴大樣本與滾動樣本外驗證。
- **情緒輕量、無歷史**：回測未納情緒；live 情緒缺老王資料（階段4 接）。
- **FRED 未填 key**：regime 少殖利率/VIX，信心打折；填 key 可補強。
- **當沖引擎 live-only**：盤口/分K 無歷史，只能 forward 驗證、不進回測（本報告僅波段）。
