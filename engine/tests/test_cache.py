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
    # 固定「今天」：既有案例都用 2026-01 的已結算日期，不隨系統時鐘飄移
    monkeypatch.setattr(cache, "_today", lambda: pd.Timestamp("2026-07-14"))


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


class LaggingServer:
    """模擬 EOD 延遲來源：只有 <= available_until 的工作日拿得到資料。

    工作日＝pd.bdate_range（不含台股休市日），日期僅用來驗證機制，不對應真實行事曆。
    """

    def __init__(self, available_until: str):
        self.available_until = available_until
        self.calls: list[tuple[str, str]] = []

    def fetch(self, code: str, start: str, end: str) -> pd.DataFrame:
        self.calls.append((start, end))
        days = [d for d in _business_days(start, end) if d <= self.available_until]
        return pd.DataFrame({"date": days, "close": [100 + i for i in range(len(days))]})


def test_settled_weekend_tail_still_cache_hits():
    """1/31 是週六：尾端本來就沒資料，但已結算 → 浮水印照推，重跑不得再打 API。"""
    srv = FakeServer()
    cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    n = len(srv.calls)
    _, meta = cache.get_timeseries("ohlcv", "2330", "2026-01-01", "2026-01-31", srv.fetch)
    assert meta["cache_hit"] is True
    assert len(srv.calls) == n


def test_lagging_source_day_is_not_skipped_forever(monkeypatch):
    """來源延遲 publish 的交易日，補上後必須被回補。

    實例（2026-07-14）：TAIEX 指數收盤卡在 07-09 不再更新——盤中/EOD 未出時查詢，
    來源回傳空但浮水印照推到請求 end，該交易日就此永遠命中快取、不再回補。
    """
    srv = LaggingServer(available_until="2026-07-09")
    # 來源目前只出到 07-09；此時查到 07-11 → 尾端拿不到東西
    monkeypatch.setattr(cache, "_today", lambda: pd.Timestamp("2026-07-11"))
    df1, _ = cache.get_timeseries("ohlcv", "TAIEX", "2026-07-01", "2026-07-11", srv.fetch)
    assert df1["date"].max() == "2026-07-09"

    # 來源補齊後再查 → 空窗期的交易日必須回補，不可因浮水印已推到 07-11 而被永久跳過
    srv.available_until = "2026-07-14"
    monkeypatch.setattr(cache, "_today", lambda: pd.Timestamp("2026-07-14"))
    df2, meta = cache.get_timeseries("ohlcv", "TAIEX", "2026-07-01", "2026-07-14", srv.fetch)
    assert meta["cache_hit"] is False
    assert "2026-07-10" in set(df2["date"])
    assert df2["date"].max() == "2026-07-14"


# ── get_periodic：季報／月營收／股利這類「日期早於公布日」的資料（opt45）────────────


class PublishingServer:
    """模擬晚公布的期別資料：rows 裡只有「已公布」的那些列拿得到，呼叫區間用期別日期過濾。"""

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.published: set[str] = {r["date"] for r in rows}
        self.calls: list[tuple[str, str]] = []
        self.fail = False

    def fetch(self, code: str, start: str, end: str) -> pd.DataFrame:
        self.calls.append((start, end))
        if self.fail:
            raise RuntimeError("upstream down")
        out = [r for r in self.rows if r["date"] in self.published and start <= r["date"] <= end]
        return pd.DataFrame(out, columns=["date", "period", "eps"])


def _set_clock(monkeypatch, now: str):
    ts = pd.Timestamp(now)
    monkeypatch.setattr(cache, "_now", lambda: ts)
    monkeypatch.setattr(cache, "_today", lambda: ts.normalize())


QUARTERS = [
    {"date": "2025-12-31", "period": "Q4", "eps": 19.5},
    {"date": "2026-03-31", "period": "Q1", "eps": 22.1},
    {"date": "2026-06-30", "period": "Q2", "eps": 27.3},
]


def test_periodic_late_published_quarter_is_picked_up(monkeypatch):
    """Q2（2026-06-30）8 月中才公布：7 月查過一次之後，8 月底再查必須補到（get_timeseries 會永久漏掉）。"""
    srv = PublishingServer(QUARTERS)
    srv.published.discard("2026-06-30")
    _set_clock(monkeypatch, "2026-07-20 10:00")
    df1, m1 = cache.get_periodic("fin", "2330", "2025-01-01", "2026-07-20", srv.fetch, refresh_days=200)
    assert list(df1["date"]) == ["2025-12-31", "2026-03-31"]
    assert m1["cache_hit"] is False

    # ttl（6 小時）內再查 → 不打 API
    _set_clock(monkeypatch, "2026-07-20 15:00")
    _, m2 = cache.get_periodic("fin", "2330", "2025-01-01", "2026-07-20", srv.fetch, refresh_days=200)
    assert m2["cache_hit"] is True
    assert len(srv.calls) == 1

    # 8 月底：Q2 已公布，快取過期 → 只重抓最近 200 天，補到 Q2
    srv.published.add("2026-06-30")
    _set_clock(monkeypatch, "2026-08-31 09:00")
    df3, m3 = cache.get_periodic("fin", "2330", "2025-01-01", "2026-08-31", srv.fetch, refresh_days=200)
    assert m3["cache_hit"] is False
    assert srv.calls[-1] == ("2026-02-12", "2026-08-31")
    assert list(df3["date"]) == ["2025-12-31", "2026-03-31", "2026-06-30"]


def test_periodic_legacy_watermark_triggers_full_refetch(monkeypatch, tmp_path):
    """舊 get_timeseries 留下的浮水印（沒有 fetched_at）→ 整段重抓一次，把以前漏掉的期別補回來。"""
    srv = PublishingServer(QUARTERS)
    _set_clock(monkeypatch, "2026-09-27 12:00")
    cache.write_cache("fin", "2330", pd.DataFrame(QUARTERS[:2]))
    cache._write_covered("fin", "2330", "2025-01-01", "2026-09-24")
    df, meta = cache.get_periodic("fin", "2330", "2025-01-01", "2026-09-27", srv.fetch, refresh_days=200)
    assert srv.calls == [("2025-01-01", "2026-09-27")]
    assert df["date"].max() == "2026-06-30"
    assert meta["cache_hit"] is False


def test_periodic_refresh_failure_serves_cache(monkeypatch):
    srv = PublishingServer(QUARTERS)
    _set_clock(monkeypatch, "2026-09-01 09:00")
    cache.get_periodic("fin", "2330", "2025-01-01", "2026-09-01", srv.fetch, refresh_days=200)
    fetched_at = cache._read_meta("fin", "2330")["fetched_at"]

    srv.fail = True
    _set_clock(monkeypatch, "2026-09-02 09:00")
    df, _ = cache.get_periodic("fin", "2330", "2025-01-01", "2026-09-02", srv.fetch, refresh_days=200)
    assert len(df) == 3  # 回舊快取
    assert cache._read_meta("fin", "2330")["fetched_at"] == fetched_at  # 沒成功就不算抓過，下次再試


def test_periodic_first_fetch_failure_raises(monkeypatch):
    srv = PublishingServer(QUARTERS)
    srv.fail = True
    _set_clock(monkeypatch, "2026-09-01 09:00")
    with pytest.raises(RuntimeError):
        cache.get_periodic("fin", "2330", "2025-01-01", "2026-09-01", srv.fetch, refresh_days=200)


def test_periodic_empty_result_is_remembered(monkeypatch):
    """ETF 沒有財報：抓回空的也要記住，ttl 內不要每次重打。"""
    srv = PublishingServer([])
    _set_clock(monkeypatch, "2026-09-01 09:00")
    df, _ = cache.get_periodic("fin", "0050", "2025-01-01", "2026-09-01", srv.fetch, refresh_days=200)
    assert df.empty
    _set_clock(monkeypatch, "2026-09-01 10:00")
    _, meta = cache.get_periodic("fin", "0050", "2025-01-01", "2026-09-01", srv.fetch, refresh_days=200)
    assert meta["cache_hit"] is True
    assert len(srv.calls) == 1


def test_periodic_head_gap_and_key_cols(monkeypatch):
    """往前要更早的區間 → 只補前段；key_cols 讓同一天兩筆不同期別的股利不會互相覆蓋。"""
    rows = [
        {"date": "2024-07-01", "period": "112年", "eps": 1.0},
        {"date": "2025-07-01", "period": "113年", "eps": 2.0},
        {"date": "2025-07-01", "period": "113年特別", "eps": 0.5},
    ]
    srv = PublishingServer(rows)
    _set_clock(monkeypatch, "2026-01-01 09:00")
    df1, _ = cache.get_periodic("div", "1101", "2025-01-01", "2026-01-01", srv.fetch, refresh_days=400, key_cols=["date", "period"])
    assert len(df1) == 2
    _set_clock(monkeypatch, "2026-01-01 10:00")
    df2, _ = cache.get_periodic("div", "1101", "2024-01-01", "2026-01-01", srv.fetch, refresh_days=400, key_cols=["date", "period"])
    assert srv.calls[-1] == ("2024-01-01", "2024-12-31")
    assert len(df2) == 3
