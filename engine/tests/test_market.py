"""階段 1 驗收：測試 /market/* 各端點資料格式、回溯邏輯及欄位正確性。"""
import datetime
from fastapi.testclient import TestClient

from app.main import app
from app.data import twse_report_client

client = TestClient(app)


def test_market_indices_ok():
    r = client.get("/market/indices?range=1d")
    assert r.status_code == 200
    body = r.json()
    assert "date" in body
    assert "as_of" in body
    assert "indices" in body
    
    indices = body["indices"]
    assert len(indices) == 5
    
    twse = next(it for it in indices if it["key"] == "TWSE")
    assert twse["name"] == "加權指數"
    assert twse["intraday_proxy"] is False
    
    tx = next(it for it in indices if it["key"] == "TX")
    assert tx["name"] == "台指期"
    assert tx["intraday_proxy"] is True


def test_market_breadth_ok():
    r = client.get("/market/breadth")
    assert r.status_code == 200
    body = r.json()
    assert "date" in body
    assert "advancing" in body
    assert "declining" in body
    assert "unchanged" in body
    assert "above_ma20_ratio" in body
    assert "above_ma50_ratio" in body
    assert body["universe"] == "watchlist_union_0050"
    assert body["source"] == "TWSE"


def test_market_sectors_ok():
    r = client.get("/market/sectors")
    assert r.status_code == 200
    body = r.json()
    assert "date" in body
    assert "sectors" in body
    
    sectors = body["sectors"]
    assert len(sectors) > 0
    
    # 斷言：至少有一檔類股的 change_pct 不是 0 且不是 null
    has_valid_change = False
    for sec in sectors:
        assert "name" in sec
        assert "turnover" in sec
        change = sec.get("change_pct")
        if change is not None and change != 0.0:
            has_valid_change = True
            
    assert has_valid_change, "類股漲跌幅不應全為 0 或 null，請檢查 channel prefix 對照與匹配邏輯。"


def test_market_institutional_ok():
    r = client.get("/market/institutional?days=5")
    assert r.status_code == 200
    body = r.json()
    assert "date" in body
    assert "latest" in body
    assert "trend" in body
    assert body["unit"] == "元"
    
    trend = body["trend"]
    assert len(trend) > 0
    assert "foreign" in trend[0]
    assert "investment_trust" in trend[0]
    assert "dealer" in trend[0]
    assert "total" in trend[0]


def test_rollback_helper_logic():
    # 測試 rollback 機制在正常交易日上可以成功解析，且若提供未來日期會正確回溯
    future_date = (datetime.date.today() + datetime.timedelta(days=5)).isoformat()
    
    # 呼叫 get_with_rollback，預期會順利回溯到最近的有資料交易日 (比如今日或前一個交易日)
    data, actual_date = twse_report_client.get_with_rollback(
        twse_report_client.get_mi_index_ms, future_date, max_days=10
    )
    assert actual_date <= future_date
    assert "advancing" in data
