"""回測核心（階段 3 實作）。

- 純 pandas 向量化，嚴禁未來函數（look-ahead）。
- 只回測 swing 引擎（富果盤口無歷史，daytrade 不進回測）。
- 用回測對因子初始權重做網格 / 最佳化調整。
- 輸出 BacktestResult（見 docs/contracts/BacktestResult.md）。
"""
