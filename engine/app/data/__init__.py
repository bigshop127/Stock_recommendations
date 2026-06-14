"""數據源層（階段 2 實作）。

規劃 client：
- finmind_client：歷史 OHLCV + 三大法人 + 融資融券 → 回測主力。
- fugle_client：即時報價 + 五檔盤口 + 分K/tick → live 訊號 + 當沖（歷史拿不到）。
- yfinance_client：美股四大指數 / 費半 → 大盤環境。
- cache：parquet / sqlite 快取。

老王情報不在本層：階段4 由 `app.puhui`（確定性解析 `reports/**/*.md`）供應。
（舊規劃寫的 `data/puhui_analysis/*.json` 從未存在、且 gitignored，已廢，見 app/puhui。）
"""
