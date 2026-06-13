"""多因子引擎（階段 3 實作）— 採「方案 C 雙引擎分離」。

- swing_engine：技術 + 籌碼 + 情緒，× 大盤環境閘門 → 波段分（可回測）。
- daytrade_engine：盤口 + 當日技術 + 大盤當日強弱 → 當沖機率（live-only，不回測）。
因子定義、數據源、公式、初始權重見 docs/scoring-model.md；輸出型別見 docs/contracts/。
權重不寫死，由 backtest 調整。
"""
