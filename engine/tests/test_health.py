"""階段 1 驗收：/health 必須回 200 且 status=ok。"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "finance-engine"
    assert "version" in body
    assert "time" in body


def test_root_ok():
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["service"] == "finance-engine"
