"""Tests for TWSE OpenAPI company profile client and API endpoint."""
from fastapi.testclient import TestClient
from app.main import app
from app.data import service

client = TestClient(app)


def test_fetch_company_profile_2330():
    profile = service.get_company_profile("2330")
    assert profile["code"] == "2330"
    assert profile["name"] is not None
    assert profile["founded"] == "1987"
    assert profile["chairman"] is not None
    assert profile["source"] is not None


def test_fetch_company_profile_degraded():
    profile = service.get_company_profile("999999")
    assert profile["code"] == "999999"
    assert profile["chairman"] is None
    assert profile["website"] is None
    assert "Degraded" in profile["source"] or "TWSE" in profile["source"]


def test_profile_api_endpoint():
    res = client.get("/data/profile?code=2330")
    assert res.status_code == 200
    data = res.json()
    assert data["code"] == "2330"
    assert "name" in data
    assert "chairman" in data
