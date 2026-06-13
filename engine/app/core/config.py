"""引擎共用設定（階段 1 佔位；階段 2 接數據源後擴充金鑰與快取路徑）。

金鑰一律走環境變數，不寫進 repo。階段 2 會啟用：
    FINMIND_TOKEN   FinMind 歷史 OHLCV / 三大法人 / 融資券
    FUGLE_API_KEY   富果 Fugle 即時報價 / 五檔盤口（live-only）
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("ENGINE_HOST", "127.0.0.1")
    port: int = int(os.getenv("ENGINE_PORT", "8000"))
    # 階段 2 啟用：
    # finmind_token: str | None = os.getenv("FINMIND_TOKEN")
    # fugle_api_key: str | None = os.getenv("FUGLE_API_KEY")
    # cache_dir: str = os.getenv("ENGINE_CACHE_DIR", "data/engine_cache")


settings = Settings()
