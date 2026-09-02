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


def test_chips(monkeypatch):
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
    monkeypatch.setattr(
        finmind_client, "fetch_shareholding",
        lambda c, s, e: pd.DataFrame(
            {"date": ["2026-01-02"], "foreign_holding_ratio": [74.2]}
        ),
    )
    r = client.get("/data/chips", params={"code": "2330", "start": "2026-01-01", "end": "2026-01-03", "days": 20})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "2330"
    assert body["name"] == "台積電"
    assert body["as_of"] == "2026-01-02"
    assert body["unit"]["net_buy_qty"] == "張"
    row = body["data"][0]
    assert row["foreign_net_buy_qty"] == 1200.0  # 1.2e6 / 1000
    assert row["investment_trust_net_buy_qty"] == 300.0  # 3.0e5 / 1000
    assert row["dealer_net_buy_qty"] == -10.0  # -1.0e4 / 1000
    assert row["total_net_buy_qty"] == 1490.0  # 1200 + 300 - 10
    assert row["margin_balance"] == 50000.0
    assert row["margin_change"] == -1200.0
    assert row["short_balance"] == 8000.0
    assert row["short_change"] == 300.0
    assert row["foreign_holding_ratio"] == 74.2

    # 測試缺欄 null / 補 0 邏輯
    monkeypatch.setattr(finmind_client, "fetch_shareholding", lambda c, s, e: pd.DataFrame())
    r = client.get("/data/chips", params={"code": "2331", "start": "2026-01-01", "end": "2026-01-03", "days": 20})
    assert r.status_code == 200
    body = r.json()
    row = body["data"][0]
    assert row["foreign_holding_ratio"] is None





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


def test_book_auto_falls_back_to_mis_when_fugle_fails(monkeypatch):
    # auto 模式下富果失敗（如 429 限流）→ 自動退回 MIS，不整頁 502
    from app.data.http import DataSourceError

    monkeypatch.setattr(settings, "book_source", "auto")
    monkeypatch.setattr(settings, "fugle_api_key", "dummy")

    def _boom(code):
        raise DataSourceError("429 from https://api.fugle.tw/...")
    monkeypatch.setattr(fugle_client, "get_quote", _boom)
    monkeypatch.setattr(
        twse_mis_client, "get_quote",
        lambda code: {"code": code, "last_price": 973.0, "bids": [{"price": 972, "size": 5}],
                      "asks": [{"price": 973, "size": 3}], "live_only": True},
    )
    r = client.get("/data/book", params={"code": "3037"})
    assert r.status_code == 200
    body = r.json()
    assert "MIS" in body["source"]
    assert body["book"]["last_price"] == 973.0


def test_market_snapshot(monkeypatch):
    monkeypatch.setattr(
        yfinance_client, "get_market_snapshot",
        lambda on_date=None: {"date": "2026-06-12", "indices": {"sox": {"symbol": "^SOX", "change_pct": 1.2}}},
    )
    r = client.get("/data/market")
    assert r.status_code == 200
    assert r.json()["indices"]["sox"]["change_pct"] == 1.2


def test_ohlcv_missing_token_is_502(monkeypatch):
    # 不 mock fetch、清掉所有 token → _tokens() 應拋 DataSourceError → 502
    monkeypatch.setattr(settings, "finmind_token", None)
    monkeypatch.setattr(settings, "finmind_tokens", None)
    r = client.get("/data/ohlcv", params={"code": "2330", "start": "2026-01-01", "end": "2026-01-10"})
    assert r.status_code == 502
    assert "FINMIND_TOKEN" in r.json()["detail"]


def test_finmind_rotates_on_quota(monkeypatch):
    # 第一顆 token 撞額度上限（HTTP 402）→ 自動換第二顆並成功。
    from app.data.http import DataSourceError

    monkeypatch.setattr(settings, "finmind_token", None)
    monkeypatch.setattr(settings, "finmind_tokens", "TOK_A,TOK_B")
    monkeypatch.setattr(finmind_client, "_token_idx", 0)
    used: list[str] = []

    def fake_get_json(url, *, params=None, headers=None):
        used.append(params["token"])
        if params["token"] == "TOK_A":
            raise DataSourceError(
                'HTTP 402 from .../api/v4/data: {"msg":"Requests reach the upper limit","status":402}'
            )
        return {"status": 200, "data": [{"date": "2026-06-25", "close": 600.0}]}

    monkeypatch.setattr(finmind_client, "get_json", fake_get_json)
    df = finmind_client._finmind_get("TaiwanStockPrice", "2330", "2026-01-01", "2026-01-10")
    assert used == ["TOK_A", "TOK_B"]  # A 爆 → 換 B
    assert not df.empty


def test_finmind_all_tokens_exhausted_is_502(monkeypatch):
    # 全部 token 都撞額度上限 → DataSourceError → /data/ohlcv 端點 502。
    from app.data.http import DataSourceError

    monkeypatch.setattr(settings, "finmind_token", None)
    monkeypatch.setattr(settings, "finmind_tokens", "TOK_A,TOK_B")
    monkeypatch.setattr(finmind_client, "_token_idx", 0)

    def fake_get_json(url, *, params=None, headers=None):
        raise DataSourceError('HTTP 402 from ...: {"msg":"Requests reach the upper limit","status":402}')

    monkeypatch.setattr(finmind_client, "get_json", fake_get_json)
    r = client.get("/data/ohlcv", params={"code": "2330", "start": "2026-01-01", "end": "2026-01-10"})
    assert r.status_code == 502
    assert "額度上限" in r.json()["detail"]


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


def test_stock_news_endpoint(monkeypatch):
    from app.data import finmind_client
    monkeypatch.setattr(finmind_client, "get_stock_name", lambda code: "台積電")
    monkeypatch.setattr(
        news_client, "get_news",
        lambda keyword=None, limit=30: [
            {"title": f"{keyword} 帶來訂單大增利多 - 自由時報", "summary": "這是一個利多消息，看好未來成長", "published": "Mon, 23 Jun 2026 12:00:00 +0800",
             "url": "http://example.com/1", "source_feed": "google_news:自由時報"},
            {"title": f"{keyword} 遭逢利空重挫", "summary": "出現衰退弱勢，面臨虧損", "published": "1782302400",
             "url": "http://example.com/2", "source_feed": "cnyes"}
        ]
    )
    r = client.get("/data/stock_news", params={"code": "2330"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "2330"
    assert body["name"] == "台積電"
    assert "as_of" in body
    summary = body["summary"]
    assert summary["positive"] == 1
    assert summary["negative"] == 1
    assert summary["total"] == 2
    assert summary["overall_score"] == 50.0
    assert summary["overall_label"] == "neutral"
    items = body["items"]
    assert len(items) == 2
    assert items[0]["title"] == "台積電 帶來訂單大增利多"
    assert items[0]["source"] == "自由時報"
    assert items[0]["sentiment"]["label"] == "positive"
    assert "利多" in items[0]["sentiment"]["hits"]
    assert "2026-06-23T12:00:00+08:00" in items[0]["published"]
    assert items[1]["title"] == "台積電 遭逢利空重挫"
    assert items[1]["source"] == "鉅亨網"
    assert items[1]["sentiment"]["label"] == "negative"
    assert "2026-" in items[1]["published"]



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


def test_fundamentals(monkeypatch):
    # Mock all the finmind_client fetch functions used by service.get_fundamentals
    monkeypatch.setattr(
        finmind_client, "fetch_valuation",
        lambda code, start, end: pd.DataFrame(
            {"date": ["2026-06-18", "2026-06-19"], "pe_ratio": [24.0, 24.5], "pb_ratio": [6.7, 6.8], "dividend_yield": [2.5, 2.45]}
        )
    )
    monkeypatch.setattr(
        finmind_client, "fetch_month_revenue",
        lambda code, start, end: pd.DataFrame(
            {
                "date": ["2025-05-10", "2026-04-10", "2026-05-10"],
                "revenue": [2.0e11, 2.4e11, 2.5e11]
            }
        )
    )
    monkeypatch.setattr(
        finmind_client, "fetch_financials",
        lambda code, start, end: pd.DataFrame(
            {"date": ["2025-12-31", "2026-03-31"], "eps": [9.5, 8.7], "gross_margin": [55.0, 56.2], "operating_margin": [41.0, 42.1], "net_margin": [37.0, 38.5]}
        )
    )
    monkeypatch.setattr(
        finmind_client, "fetch_dividend",
        lambda code, start, end: pd.DataFrame(
            {
                "date": ["2024-04-15", "2025-04-15", "2025-09-15"],
                "cash_dividend": [12.0, 10.0, 3.5],
                "stock_dividend": [0.0, 0.0, 0.0]
            }
        )
    )
    monkeypatch.setattr(
        finmind_client, "fetch_shares_issued",
        lambda code, start, end: pd.DataFrame(
            {"date": ["2026-06-19"], "shares": [2.59e10]}
        )
    )
    monkeypatch.setattr(
        finmind_client, "fetch_ohlcv",
        lambda code, start, end: pd.DataFrame(
            {"date": ["2026-06-19"], "open": [900.0], "high": [910.0], "low": [890.0], "close": [905.0], "volume": [1000], "turnover": [905000]}
        )
    )

    r = client.get("/data/fundamentals", params={"code": "2330"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "2330"
    assert body["name"] == "台積電"
    assert body["as_of"] == "2026-06-19"
    
    # Check summary
    summary = body["summary"]
    assert summary["pe_ratio"] == 24.5
    assert summary["pb_ratio"] == 6.8
    assert summary["dividend_yield"] == 2.45
    assert summary["market_cap"] == int(2.59e10 * 905.0)
    assert summary["eps_ttm"] is None

    # Let's check sub-arrays
    assert len(body["valuation"]) == 2
    assert body["valuation"][0]["pe_ratio"] == 24.0
    
    assert len(body["revenue"]) == 3
    assert body["revenue"][2]["month"] == "2026-05"
    assert body["revenue"][2]["yoy"] == 25.0  # (2.5e11 - 2.0e11) / 2.0e11 * 100
    assert body["revenue"][2]["mom"] == 4.1667  # (2.5e11 - 2.4e11) / 2.4e11 * 100
    
    assert len(body["financials"]) == 2
    assert body["financials"][0]["quarter"] == "2025-Q4"
    assert body["financials"][1]["quarter"] == "2026-Q1"
    assert body["financials"][1]["eps"] == 8.7
    assert body["financials"][1]["net_margin"] == 38.5
    
    assert len(body["dividend"]) == 2
    assert body["dividend"][1]["year"] == "2025"
    assert body["dividend"][1]["cash_dividend"] == 13.5
    assert body["dividend"][1]["stock_dividend"] == 0.0

    # If any datasource is empty, it should fall back to empty list/null
    monkeypatch.setattr(finmind_client, "fetch_valuation", lambda code, start, end: pd.DataFrame())
    r = client.get("/data/fundamentals", params={"code": "2331"})
    assert r.status_code == 200
    body = r.json()
    assert body["valuation"] == []
    assert body["summary"]["pe_ratio"] is None


def test_fundamentals_calculation_details(monkeypatch):
    # 1. Test financials pivot logic
    raw_fin_data = pd.DataFrame([
        {"date": "2026-03-31", "type": "EPS", "value": 8.7},
        {"date": "2026-03-31", "type": "Revenue", "value": 1000.0},
        {"date": "2026-03-31", "type": "GrossProfit", "value": 560.0},
        {"date": "2026-03-31", "type": "OperatingIncome", "value": 420.0},
        {"date": "2026-03-31", "type": "IncomeAfterTaxes", "value": 380.0},
    ])
    monkeypatch.setattr(finmind_client, "_finmind_get", lambda dataset, code, start, end: raw_fin_data)
    
    df_fin = finmind_client.fetch_financials("2330", "2026-01-01", "2026-04-01")
    assert not df_fin.empty
    assert df_fin.iloc[0]["eps"] == 8.7
    assert df_fin.iloc[0]["gross_margin"] == 56.0  # (560/1000)*100
    assert df_fin.iloc[0]["operating_margin"] == 42.0
    assert df_fin.iloc[0]["net_margin"] == 38.0

    # 2. Test get_fundamentals logic with specific sequence of revenue and dividend
    # To test actual calculations inside get_fundamentals, we mock the fetch functions:
    monkeypatch.setattr(finmind_client, "fetch_valuation", lambda code, start, end: pd.DataFrame())
    monkeypatch.setattr(finmind_client, "fetch_financials", lambda code, start, end: pd.DataFrame())
    monkeypatch.setattr(finmind_client, "fetch_shares_issued", lambda code, start, end: pd.DataFrame())
    monkeypatch.setattr(finmind_client, "fetch_ohlcv", lambda code, start, end: pd.DataFrame())
    
    # Revenue sequence with gaps or exactly 13 months apart for YoY and 1 month for MoM
    revenue_data = pd.DataFrame([
        {"date": "2025-01-01", "revenue": 100.0},
        {"date": "2025-02-01", "revenue": 110.0},
        {"date": "2025-12-01", "revenue": 110.0},
        {"date": "2026-01-01", "revenue": 120.0},
        {"date": "2026-02-01", "revenue": 143.0},
    ])
    monkeypatch.setattr(finmind_client, "fetch_month_revenue", lambda code, start, end: revenue_data)
    
    # Dividend sequence with multiple payouts in the same year
    dividend_data = pd.DataFrame([
        {"date": "2025-03-15", "cash_dividend": 2.5, "stock_dividend": 0.0},
        {"date": "2025-06-15", "cash_dividend": 2.5, "stock_dividend": 0.0},
        {"date": "2025-09-15", "cash_dividend": 3.0, "stock_dividend": 1.0},
        {"date": "2025-12-15", "cash_dividend": 3.0, "stock_dividend": 0.0},
    ])
    monkeypatch.setattr(finmind_client, "fetch_dividend", lambda code, start, end: dividend_data)
    
    from app.data.service import get_fundamentals
    res = get_fundamentals("2330")
    
    # Verify MoM and YoY calculation for revenue
    rev_list = res["revenue"]
    assert len(rev_list) == 5
    # 2025-01: no prev month, no prev year
    assert rev_list[0]["month"] == "2025-01"
    assert rev_list[0]["mom"] is None
    assert rev_list[0]["yoy"] is None
    
    # 2025-02: MoM = (110 - 100) / 100 * 100 = 10.0%
    assert rev_list[1]["month"] == "2025-02"
    assert rev_list[1]["mom"] == 10.0
    assert rev_list[1]["yoy"] is None
    
    # 2025-12: MoM = None (no 2025-11)
    assert rev_list[2]["month"] == "2025-12"
    assert rev_list[2]["mom"] is None
    assert rev_list[2]["yoy"] is None
    
    # 2026-01: YoY = (120 - 100) / 100 * 100 = 20.0%
    # MoM: (120 - 110) / 110 * 100 = 9.0909%
    assert rev_list[3]["month"] == "2026-01"
    assert rev_list[3]["yoy"] == 20.0
    assert abs(rev_list[3]["mom"] - 9.0909) < 1e-3
    
    # 2026-02: YoY = (143 - 110) / 110 * 100 = 30.0%
    # MoM: (143 - 120) / 120 * 100 = 19.1667%
    assert rev_list[4]["month"] == "2026-02"
    assert rev_list[4]["yoy"] == 30.0
    assert abs(rev_list[4]["mom"] - 19.1667) < 1e-3

    # Verify dividend year aggregation
    div_list = res["dividend"]
    assert len(div_list) == 1
    assert div_list[0]["year"] == "2025"
    assert div_list[0]["cash_dividend"] == 11.0  # 2.5 + 2.5 + 3.0 + 3.0
    assert div_list[0]["stock_dividend"] == 1.0


def test_symbols_search(monkeypatch):
    mock_symbols = [
        {"stock_id": "2330", "stock_name": "\u53f0\u7a4d\u96fb"},
        {"stock_id": "2454", "stock_name": "\u806f\u767c\u79d1"},
        {"stock_id": "2317", "stock_name": "\u9d3b\u6d77"},
        {"stock_id": "2301", "stock_name": "\u5149\u5bf6\u79d1"},
        {"stock_id": "23300", "stock_name": "\u53f0\u7a4d\u6b0a\u8b4901"},
    ]
    monkeypatch.setattr(finmind_client, "list_symbols", lambda: mock_symbols)

    # 1. 測試前綴代號匹配與排序
    r = client.get("/data/symbols/search", params={"q": "23"})
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "23"
    assert body["count"] == 4
    codes = [item["code"] for item in body["results"]]
    assert codes == ["2301", "2317", "2330", "23300"]

    # 2. 測試完全匹配代號優先
    r = client.get("/data/symbols/search", params={"q": "2330"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert body["results"][0]["code"] == "2330"

    # 3. 測試股名子字串匹配
    r = client.get("/data/symbols/search", params={"q": "\u79d1"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    codes_with_ke = [item["code"] for item in body["results"]]
    assert "2454" in codes_with_ke
    assert "2301" in codes_with_ke

    # 4. 測試空查詢
    r = client.get("/data/symbols/search", params={"q": ""})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 0
    assert body["results"] == []

    # 5. 測試 limit 限制
    r = client.get("/data/symbols/search", params={"q": "23", "limit": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert len(body["results"]) == 2



