"""Unit tests for TDCC shareholding dispersion backend logic, level 16/17 exclusion, and API."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.data.service import aggregate_dispersion, DEFAULT_THRESHOLDS, get_shareholding_dispersion
from app.data import tdcc_client

client = TestClient(app)


def test_aggregate_dispersion_level_16_17_exclusion():
    mock_rows = [
        # Week 1
        {"date": "2026-06-26", "HoldingSharesLevel": 1, "people": 50000, "percent": 20.0},
        {"date": "2026-06-26", "HoldingSharesLevel": 8, "people": 20000, "percent": 22.1},
        {"date": "2026-06-26", "HoldingSharesLevel": 9, "people": 100, "percent": 10.0},
        {"date": "2026-06-26", "HoldingSharesLevel": 11, "people": 45, "percent": 8.3},
        {"date": "2026-06-26", "HoldingSharesLevel": 12, "people": 30, "percent": 15.0},
        {"date": "2026-06-26", "HoldingSharesLevel": 15, "people": 19, "percent": 24.6},
        # Level 16 (差異數調整) & Level 17 (合計) MUST be excluded!
        {"date": "2026-06-26", "HoldingSharesLevel": 16, "people": 0, "percent": 0.0},
        {"date": "2026-06-26", "HoldingSharesLevel": 17, "people": 71241, "percent": 100.0},

        # Week 2
        {"date": "2026-07-03", "HoldingSharesLevel": 1, "people": 51000, "percent": 20.5},
        {"date": "2026-07-03", "HoldingSharesLevel": 8, "people": 20047, "percent": 21.6},
        {"date": "2026-07-03", "HoldingSharesLevel": 9, "people": 101, "percent": 10.1},
        {"date": "2026-07-03", "HoldingSharesLevel": 11, "people": 44, "percent": 8.2},
        {"date": "2026-07-03", "HoldingSharesLevel": 12, "people": 31, "percent": 15.5},
        {"date": "2026-07-03", "HoldingSharesLevel": 15, "people": 18, "percent": 24.1},
        {"date": "2026-07-03", "HoldingSharesLevel": 16, "people": 0, "percent": 0.0},
        {"date": "2026-07-03", "HoldingSharesLevel": 17, "people": 71241, "percent": 100.0},
    ]

    result = aggregate_dispersion(mock_rows, DEFAULT_THRESHOLDS)
    assert len(result) == 2

    # Week 1 assertions
    w1 = result[0]
    assert w1["date"] == "2026-06-26"
    assert w1["retail"]["people"] == 70000
    assert w1["retail"]["people_delta"] is None
    assert w1["retail"]["shares_pct"] == 42.1

    assert w1["mid"]["people"] == 145
    assert w1["mid"]["people_delta"] is None
    assert w1["mid"]["shares_pct"] == 18.3

    # CRITICAL BUG FIX ASSERTION: Large headcount must NOT include 71241 from Level 17!
    assert w1["large"]["people"] == 49
    assert w1["large"]["people_delta"] is None
    assert w1["large"]["shares_pct"] == 39.6

    # Week 2 assertions
    w2 = result[1]
    assert w2["date"] == "2026-07-03"
    assert w2["retail"]["people"] == 71047
    assert w2["retail"]["people_delta"] == 1047

    assert w2["mid"]["people"] == 145
    assert w2["mid"]["people_delta"] == 0

    assert w2["large"]["people"] == 49
    assert w2["large"]["people_delta"] == 0


def test_get_shareholding_dispersion_service():
    res = get_shareholding_dispersion("3450", weeks=16)
    assert res["code"] == "3450"
    assert "weekly" in res
    assert isinstance(res["weekly"], list)
    assert res["source"] == "TDCC 集保戶股權分散表 (id=1-5)"


def test_shareholding_endpoint():
    response = client.get("/data/shareholding?code=3450&weeks=10")
    assert response.status_code == 200
    data = response.json()
    assert data["code"] == "3450"
    assert "weekly" in data
    assert isinstance(data["weekly"], list)
    assert data["source"] == "TDCC 集保戶股權分散表 (id=1-5)"
