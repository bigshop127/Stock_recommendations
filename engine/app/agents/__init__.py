"""多 agent LLM 決策層（階段 5 實作）。

沿用 TradingAgents 架構：分析師 → 多空辯論 → 交易員 → 風控。
僅每日盤後對 watchlist（≤10 檔）跑，不進回測。
LLM：Claude CLI 主 → 失敗/額度用完切 Gemini CLI（2026-09-26 由 Gemini 主調換）；需可在無頭雲端 VM 跑。
"""
