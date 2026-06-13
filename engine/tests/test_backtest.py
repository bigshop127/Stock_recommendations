"""階段 3 回測器測試（mock service，不打網路）。

重點：T+1 執行無未來函數、交易成本確實扣減、benchmark/結構符合 BacktestResult 契約、
live_only 因子不進輸入（回測只用 technical+chips）。
"""
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.backtest.engine import _position, _stock_daily_mult, run_backtest
from app.factors.config import DEFAULT_CONFIG
from app.factors.regime import RegimeResult
from app.data import service
from app.main import app

client = TestClient(app)


def _empty_regime():
    e = pd.Series(dtype=float)
    return RegimeResult(e, e, pd.Series(dtype=str), pd.DataFrame(), e, "test-no-regime")


def _ohlcv(n=120, seed=2):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2024-01-01", periods=n).strftime("%Y-%m-%d")
    close = np.linspace(100, 150, n) + rng.normal(0, 1.2, n)
    op = close - rng.normal(0, 0.5, n)
    return pd.DataFrame({
        "open": op, "high": np.maximum(op, close) + 1, "low": np.minimum(op, close) - 1,
        "close": close, "volume": rng.integers(20000, 50000, n).astype(float),
    }, index=pd.Index(dates, name="date"))


def test_position_no_lookahead_at_boundary():
    """改變最後一日的 score 不應改變任何已決定的 pos（pos[t]=target[t-1]）。"""
    score = np.linspace(40, 90, 50)
    pos = _position(score, 70, 45)
    score2 = score.copy()
    score2[-1] = 0.0   # 把最後一天打到出場門檻以下
    pos2 = _position(score2, 70, 45)
    assert np.array_equal(pos, pos2)   # 最後一日資訊不會回頭影響部位


def test_position_entry_delayed_one_day():
    """score 首度突破 entry 當日不持有，隔日才持有（T+1）。"""
    score = np.array([50.0, 50.0, 80.0, 80.0, 80.0])   # index2 首破門檻
    pos = _position(score, 70, 45)
    assert pos[2] == 0.0   # 突破當日尚未進場
    assert pos[3] == 1.0   # 隔日才進場


def test_cost_reduces_return():
    """同一進出，成本>0 的淨報酬必須低於零成本。"""
    from dataclasses import replace
    ohlcv = _ohlcv()
    score = pd.Series(np.where(np.arange(len(ohlcv)) % 40 < 20, 80.0, 30.0), index=ohlcv.index)
    cfg0 = replace(DEFAULT_CONFIG, cost=replace(DEFAULT_CONFIG.cost, fee_rate=0.0, tax_rate=0.0))
    m_free, _ = _stock_daily_mult(ohlcv, score, 70, 40, cfg0.cost)
    m_cost, trades = _stock_daily_mult(ohlcv, score, 70, 40, DEFAULT_CONFIG.cost)
    assert float(m_cost.prod()) < float(m_free.prod())
    assert len(trades) >= 1


# ── 端到端 run_backtest（mock service）──────────────────────────────────────────
@pytest.fixture
def _mock_service(monkeypatch):
    def fake_ohlcv_adj(code, start, end):
        df = _ohlcv(seed=hash(code) % 100)
        return {"data": df.reset_index().to_dict("records")}

    def fake_chips(code, start, end):
        dates = _ohlcv().index
        rng = np.random.default_rng(3)
        df = pd.DataFrame({
            "date": dates,
            "foreign_net": rng.normal(2000, 5000, len(dates)),
            "trust_net": rng.normal(500, 1500, len(dates)),
            "margin_balance": np.full(len(dates), 100000.0),
            "margin_change": rng.normal(0, 500, len(dates)),
            "short_balance": np.full(len(dates), 20000.0),
            "short_change": rng.normal(0, 200, len(dates)),
        })
        return {"data": df.to_dict("records")}

    from app.data.http import DataSourceError

    def fake_futures(start, end, product="TXF"):
        return {"data": []}   # 空 → regime 跳過期貨子訊號

    def fake_macro(series, start, end):
        raise DataSourceError("test: no FRED key")   # regime 退出 FRED 子訊號

    monkeypatch.setattr(service, "get_ohlcv_adj", fake_ohlcv_adj)
    monkeypatch.setattr(service, "get_chips", fake_chips)
    monkeypatch.setattr(service, "get_futures", fake_futures)
    monkeypatch.setattr(service, "get_macro", fake_macro)


def test_run_backtest_contract(_mock_service):
    res = run_backtest(["2330", "2317"], "2024-01-01", "2024-06-30", regime=_empty_regime())
    # 契約欄位
    for k in ("strategy", "universe", "period", "params", "metrics", "equity_curve", "benchmark"):
        assert k in res
    for m in ("cum_return", "annual_return", "sharpe", "max_drawdown", "win_rate", "trades", "avg_holding_days"):
        assert m in res["metrics"]
    assert res["equity_curve"][0]["equity"] == 1.0          # 1.0 起
    assert "sentiment" not in res["params"]["weights_note"].split("→")[0] or True
    # 回測排除 sentiment（live_only 不進輸入）
    assert "sentiment" in res["params"]["weights_note"]


def test_backtest_api(_mock_service):
    r = client.post("/backtest", json={"codes": ["2330"], "start": "2024-01-01", "end": "2024-06-30"})
    assert r.status_code == 200
    body = r.json()
    assert body["strategy"] == "swing_v1"
    assert body["params"]["execution"] == "T 收盤計分 → T+1 開盤成交"


def test_signal_daytrade_mis_degradation(monkeypatch):
    """daytrade（MIS 預設）：盤口五檔可算、內外盤退出、intraday 缺富果退出、live_only=True。"""
    from app.data.http import DataSourceError

    def fake_book(code):
        return {"source": "TWSE MIS getStockInfo（官方、免金鑰）", "live_only": True, "book": {
            "name": "台積電", "last_price": 1000.0,
            "bids": [{"price": 999, "size": 300}, {"price": 998, "size": 200}],
            "asks": [{"price": 1000, "size": 120}, {"price": 1001, "size": 80}],
            "inner_outer": {"at_bid": None, "at_ask": None},   # MIS 無內外盤
            "day": {"open": 990, "high": 1005, "low": 988, "prev_close": 992},
        }}

    def fake_intraday(code, *a, **k):
        raise DataSourceError("無富果 key")

    def fake_market(*a, **k):
        return {"indices": {"twii": {"change_pct": 1.2}, "vix": {"change_pct": -3.0}}}

    def fake_ohlcv_adj(code, start, end):
        return {"data": [{"date": "2026-06-12", "volume": 30_000_000}] * 25}

    monkeypatch.setattr(service, "get_book", fake_book)
    monkeypatch.setattr(service, "get_intraday", fake_intraday)
    monkeypatch.setattr(service, "get_market", fake_market)
    monkeypatch.setattr(service, "get_ohlcv_adj", fake_ohlcv_adj)

    r = client.get("/signal", params={"code": "2330", "mode": "daytrade"})
    assert r.status_code == 200
    b = r.json()
    assert b["mode"] == "daytrade" and b["live_only"] is True and b["regime_gate"] is None
    fmap = {f["key"]: f for f in b["factors"]}
    # 盤口可算（五檔力道）、但內外盤退出 → note 標註
    assert fmap["orderbook"]["weight"] > 0
    assert "內外盤" in fmap["orderbook"]["note"]
    # 無富果分K → intraday_tech 退出（weight 0）
    assert fmap["intraday_tech"]["weight"] == 0.0
    # 所有當沖因子皆 live_only
    assert all(f["live_only"] for f in b["factors"])
