"""引擎共用設定（階段 2：接數據源後啟用金鑰與快取路徑）。

金鑰一律走環境變數 / `engine/.env`，不寫進 repo（.env 已 gitignored）。
讀取優先序：環境變數 > engine/.env > 預設值。

啟用的設定：
    FINMIND_TOKEN     FinMind 歷史 OHLCV / 三大法人 / 融資券（免費，需註冊 token）
    FUGLE_API_KEY     富果 Fugle 即時報價 / 五檔盤口（live-only，玉山；可選）
    FRED_API_KEY      美國總經（FRED，免費註冊即得；可選）
    BOOK_SOURCE       即時五檔來源：auto（有富果 key 才用富果，否則 TWSE MIS）/ mis / fugle
    ENGINE_HOST/PORT  服務位址
    ENGINE_CACHE_DIR  本地 parquet 快取目錄（預設 engine/data_cache）
    HTTP_TIMEOUT      對外 API 逾時秒數
    HTTP_MAX_RETRY    對外 API 重試次數（頻率限制 / 暫時性錯誤）

說明：TWSE MIS（基本市況報導）為官方公開即時源，免金鑰即可取最佳五檔，
故 FUGLE_API_KEY 改為可選；不設時 /data/book 自動走 MIS。
"""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# engine/ 目錄（本檔在 engine/app/core/config.py → parents[2] = engine/）
ENGINE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """全域設定。pydantic-settings 自動從環境變數與 engine/.env 載入。"""

    model_config = SettingsConfigDict(
        env_file=ENGINE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 服務
    engine_host: str = "127.0.0.1"
    engine_port: int = 8000

    # 金鑰（缺省 None → client 會在被呼叫時報明確錯誤，不靜默）
    finmind_token: str | None = None
    fugle_api_key: str | None = None   # 可選；不設則 /data/book 走 TWSE MIS
    fred_api_key: str | None = None    # 可選；/data/macro 需要

    # 即時五檔來源：auto=有富果 key 才用富果，否則 MIS；亦可強制 mis / fugle
    book_source: str = "auto"

    # 快取（依 phase2.md 放 engine/data_cache/；可用 ENGINE_CACHE_DIR 覆寫）
    engine_cache_dir: str = str(ENGINE_DIR / "data_cache")

    # 對外 HTTP
    http_timeout: float = 15.0
    http_max_retry: int = 3

    @property
    def cache_path(self) -> Path:
        p = Path(self.engine_cache_dir)
        if not p.is_absolute():
            p = ENGINE_DIR / p
        return p


settings = Settings()
