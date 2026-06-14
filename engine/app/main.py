"""財經 APP 量化引擎 — FastAPI 入口（階段 1 骨架）。

啟動（從 engine/ 目錄）：
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

設計原則：
- 與既有 Node 內容線（scripts/puhui_daily.cjs）完全解耦，只透過 HTTP 溝通。
- 階段 2：接台股數據層（FinMind/富果/yfinance + parquet 快取），尚未算因子。
"""
from fastapi import FastAPI

from app import __version__
from app.api.backtest import router as backtest_router
from app.api.data import router as data_router
from app.api.health import router as health_router
from app.api.puhui import router as puhui_router
from app.api.signal import router as signal_router

app = FastAPI(
    title="Finance Engine",
    description="台股多因子量化 + 回測 + 老王整合 + 多 agent 引擎（階段 4：老王融合訊號 + 自動觀察清單）",
    version=__version__,
)

app.include_router(health_router)
app.include_router(data_router)
app.include_router(signal_router)
app.include_router(backtest_router)
app.include_router(puhui_router)


@app.get("/", tags=["root"])
def root():
    """服務根節點，方便人工確認引擎已起。"""
    return {
        "service": "finance-engine",
        "version": __version__,
        "health": "/health",
        "docs": "/docs",
    }
