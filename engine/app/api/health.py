"""/health 端點 — 供雲端探活與 Node gateway 串接驗證。"""
from datetime import datetime, timezone

from fastapi import APIRouter

from app import __version__

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    """回 200 + 服務基本資訊。Node↔Python 串接 demo 以此為探測點。"""
    return {
        "status": "ok",
        "service": "finance-engine",
        "version": __version__,
        "time": datetime.now(timezone.utc).isoformat(),
    }
