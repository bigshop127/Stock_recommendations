"""階段 2 驗收：parquet 快取「重跑命中、不重打 API」與 gap-based 補抓。

不打網路：用合成 fetch_fn 記錄 API 呼叫次數與區間。
"""
import pandas as pd
import pytest

from app.core.config import settings
from app.data import cache


@pytest.fixture(autouse=True)
def _tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "engine_cache_dir", str(tmp_path))


def _business_days(start: str, end: str) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range(start, end)]


class FakeServer:
    """模擬數據源：回傳區間內工作日的合成資料，並記錄每次呼叫區間。"""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def fetch(self, code: str, start: str, end: str) -> pd.DataFrame:
        self.calls.append((start, end))
        days = _business_days(start, end)
        return pd.DataFrame({"date": days, "close": [100 + i for i in range(len(days))]})


def test_first_fetch_then_cache_hit():
    srv = FakeServer()
    df1, m1 = cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    assert m1["cache_hit"] is False
    assert len(srv.calls) == 1
    assert m1["rows"] == len(df1) > 0

    # 同區間重跑 → 命中快取、0 次 API
    df2, m2 = cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    assert m2["cache_hit"] is True
    assert len(srv.calls) == 1  # 沒有新增呼叫
    assert len(df2) == len(df1)


def test_subrange_is_cache_hit():
    srv = FakeServer()
    cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    df, meta = cache.get_timeseries("ohlcv", "2330", "2026-01-10", "2026-01-20", srv.fetch)
    assert meta["cache_hit"] is True
    assert len(srv.calls) == 1
    assert df["date"].min() >= "2026-01-10" and df["date"].max() <= "2026-01-20"


def test_extend_end_fetches_only_tail_gap():
    srv = FakeServer()
    cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-15", srv.fetch)
    cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    # 第二次只補尾端缺口，起點應在 1/16 之後（不重抓 1/01~1/15）
    assert len(srv.calls) == 2
    tail_start, tail_end = srv.calls[1]
    assert tail_start > "2026-01-15"
    assert tail_end == "2026-01-31"


def test_extend_start_fetches_only_head_gap():
    srv = FakeServer()
    cache.get_timeseries("ohlcv", "2330", "2026-01-15", "2026-01-31", srv.fetch)
    cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    assert len(srv.calls) == 2
    head_start, head_end = srv.calls[1]
    assert head_start == "2026-01-01"
    assert head_end < "2026-01-15"
