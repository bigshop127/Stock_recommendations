"""多 agent LLM 決策層（階段 5 實作）。

沿用 TradingAgents 架構：分析師 → 多空辯論 → 交易員 → 風控。
僅每日盤後對 watchlist（≤10 檔）跑，不進回測。
LLM：Gemini CLI 主 → 額度用完切 Claude CLI；需可在無頭雲端 VM 跑。
"""
