"""財經 APP 量化引擎 — FastAPI 入口（階段 1 骨架）。

啟動（從 engine/ 目錄）：
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

設計原則：
- 與既有 Node 內容線（scripts/puhui_daily.cjs）完全解耦，只透過 HTTP 溝通。
- 本階段不接真實數據、不算因子；只定骨架與契約。
"""
from fastapi import FastAPI

from app import __version__
from app.api.health import router as health_router

app = FastAPI(
    title="Finance Engine",
    description="台股多因子量化 + 回測 + 多 agent 引擎（階段 1 骨架）",
    version=__version__,
)

app.include_router(health_router)


@app.get("/", tags=["root"])
def root():
    """服務根節點，方便人工確認引擎已起。"""
    return {
        "service": "finance-engine",
        "version": __version__,
        "health": "/health",
        "docs": "/docs",
    }
