"""階段 2 驗收：/data/* 端點（mock 數據源，不打網路）。

- /data/ohlcv、/data/chips：mock FinMind client → 驗證乾淨輸出 + 快取 meta。
- /data/book：mock 富果 quote → 驗證 live_only。
- /data/market：mock yfinance 快照。
- 無 token 時 → 502 明確錯誤（不靜默回空）。
"""
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.data import (
    finmind_client,
    fred_client,
    fugle_client,
    news_client,
    taifex_client,
    twse_mis_client,
    yfinance_client,
)
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "engine_cache_dir", str(tmp_path))
    monkeypatch.setattr(finmind_client, "get_stock_name", lambda code: "台積電")


def test_ohlcv_clean_output(monkeypatch):
    def fake(code, start, end):
        return pd.DataFrame(
            {
                "date": ["2026-01-02", "2026-01-05"],
                "open": [600.0, 610.0],
                "high": [615.0, 620.0],
                "low": [598.0, 605.0],
                "close": [610.0, 618.0],
                "volume": [30000000, 28000000],
                "turnover": [1.8e10, 1.7e10],
            }
        )

    monkeypatch.setattr(finmind_client, "fetch_ohlcv", fake)
    r = client.get("/data/ohlcv", params={"code": "2330", "start": "2026-01-01", "end": "2026-01-10"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "2330"
    assert body["name"] == "台積電"
    assert body["live_only"] is False
    assert body["rows"] == 2
    assert {"date", "open", "high", "low", "close", "volume", "turnover"} <= set(body["data"][0])
    assert body["cache"]["cache_hit"] is False


def test_chips_merge(monkeypatch):
    monkeypatch.setattr(
        finmind_client, "fetch_institutional",
        lambda c, s, e: pd.DataFrame(
            {"date": ["2026-01-02"], "foreign_net": [1.2e6], "trust_net": [3.0e5], "dealer_net": [-1.0e4]}
        ),
    )
    monkeypatch.setattr(
        finmind_client, "fetch_margin",
        lambda c, s, e: pd.DataFrame(
            {"date": ["2026-01-02"], "margin_balance": [50000.0], "margin_change": [-1200.0],
             "short_balance": [8000.0], "short_change": [300.0]}
        ),
    )
    r = client.get("/data/chips", params={"code": "2330"})
    assert r.status_code == 200
    body = r.json()
    row = body["data"][0]
    assert "foreign_net" in row and "margin_balance" in row  # 兩來源已合併同一日
    assert body["live_only"] is False


def test_book_defaults_to_mis(monkeypatch):
    # 無富果 key（auto）→ /data/book 走 TWSE MIS
    monkeypatch.setattr(settings, "fugle_api_key", None)
    monkeypatch.setattr(settings, "book_source", "auto")
    monkeypatch.setattr(
        twse_mis_client, "get_quote",
        lambda code: {"code": code, "last_price": 2305.0, "bids": [{"price": 2305, "size": 100}],
                      "asks": [{"price": 2310, "size": 80}], "live_only": True},
    )
    r = client.get("/data/book", params={"code": "2330"})
    assert r.status_code == 200
    body = r.json()
    assert body["live_only"] is True
    assert "MIS" in body["source"]
    assert body["book"]["bids"][0]["price"] == 2305


def test_book_uses_fugle_when_forced(monkeypatch):
    # 強制 book_source=fugle 且有 key → 走富果
    monkeypatch.setattr(settings, "book_source", "fugle")
    monkeypatch.setattr(settings, "fugle_api_key", "dummy")
    monkeypatch.setattr(
        fugle_client, "get_quote",
        lambda code: {"code": code, "last_price": 612.0, "bids": [{"price": 611, "size": 100}],
                      "asks": [{"price": 612, "size": 80}], "live_only": True},
    )
    r = client.get("/data/book", params={"code": "2330"})
    assert r.status_code == 200
    body = r.json()
    assert "富果" in body["source"]
    assert body["book"]["bids"][0]["price"] == 611


def test_market_snapshot(monkeypatch):
    monkeypatch.setattr(
        yfinance_client, "get_market_snapshot",
        lambda on_date=None: {"date": "2026-06-12", "indices": {"sox": {"symbol": "^SOX", "change_pct": 1.2}}},
    )
    r = client.get("/data/market")
    assert r.status_code == 200
    assert r.json()["indices"]["sox"]["change_pct"] == 1.2


def test_ohlcv_missing_token_is_502(monkeypatch):
    # 不 mock fetch、清掉 token → _require_token 應拋 DataSourceError → 502
    monkeypatch.setattr(settings, "finmind_token", None)
    r = client.get("/data/ohlcv", params={"code": "2330", "start": "2026-01-01", "end": "2026-01-10"})
    assert r.status_code == 502
    assert "FINMIND_TOKEN" in r.json()["detail"]


def test_futures_merge(monkeypatch):
    monkeypatch.setattr(
        taifex_client, "fetch_institutional_futures",
        lambda c, s, e, product="TX": pd.DataFrame(
            {"date": ["2026-06-12"], "foreign_oi_net": [-12000.0],
             "trust_oi_net": [800.0], "dealer_oi_net": [1500.0]}
        ),
    )
    monkeypatch.setattr(
        taifex_client, "fetch_pc_ratio",
        lambda c, s, e: pd.DataFrame(
            {"date": ["2026-06-12"], "pc_volume_ratio": [0.92], "pc_oi_ratio": [1.35]}
        ),
    )
    r = client.get("/data/futures", params={"product": "TX"})
    assert r.status_code == 200
    row = r.json()["data"][0]
    assert "foreign_oi_net" in row and "pc_oi_ratio" in row  # 兩來源已合併同一日
    assert r.json()["live_only"] is False


def test_news_keyword_uses_rss(monkeypatch):
    monkeypatch.setattr(
        news_client, "get_news",
        lambda keyword=None, limit=30: [
            {"title": f"{keyword} 新聞", "summary": None, "published": None,
             "url": "http://x", "source_feed": "google_news"}
        ],
    )
    r = client.get("/data/news", params={"keyword": "台積電"})
    assert r.status_code == 200
    body = r.json()
    assert body["live_only"] is True
    assert body["count"] == 1
    assert body["items"][0]["title"] == "台積電 新聞"


def test_macro_series(monkeypatch):
    monkeypatch.setattr(
        fred_client, "fetch_series",
        lambda series_id, start, end: pd.DataFrame(
            {"date": ["2026-06-10", "2026-06-11"], "value": [4.25, 4.27]}
        ),
    )
    r = client.get("/data/macro", params={"series": "us10y", "start": "2026-06-01", "end": "2026-06-12"})
    assert r.status_code == 200
    body = r.json()
    assert body["series_id"] == "DGS10"
    assert body["rows"] == 2
    assert body["live_only"] is False


def test_macro_missing_key_is_502(monkeypatch):
    monkeypatch.setattr(settings, "fred_api_key", None)
    r = client.get("/data/macro", params={"series": "us10y", "start": "2026-06-01", "end": "2026-06-12"})
    assert r.status_code == 502
    assert "FRED_API_KEY" in r.json()["detail"]
