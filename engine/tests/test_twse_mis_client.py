"""TWSE MIS client：tse/otc 頻道判別（bug regression：誤鎖空白 placeholder 頻道）。"""
from __future__ import annotations

from app.data import twse_mis_client as mis


def _empty_row() -> dict:
    """代號打錯市場時 MIS 仍回 200，但 msgArray[0] 幾乎全是 placeholder。"""
    return {"tv": "-", "s": "-", "c": "", "z": "-"}


def _real_row(code: str, channel: str) -> dict:
    return {
        "c": code, "n": "測試", "z": "27.89", "y": "27.87", "o": "27.87",
        "h": "27.92", "l": "27.82", "v": "12864",
        "a": "27.90_27.91_", "f": "1015_1549_",
        "b": "27.89_27.88_", "g": "75_561_",
        "t": "13:30:00", "ex": "otc" if channel.startswith("otc") else "tse",
    }


def test_get_quote_falls_back_to_otc_when_tse_is_placeholder(monkeypatch):
    """00687B 等債券 ETF 掛牌在 OTC；tse_ 頻道回空白 placeholder 不該被當成「找到」。"""
    mis._channel_cache.clear()
    calls: list[str] = []

    def fake_get_json(url, *, params=None, headers=None):
        ch = params["ex_ch"]
        calls.append(ch)
        row = _empty_row() if ch.startswith("tse_") else _real_row("00687B", ch)
        return {"msgArray": [row]}

    monkeypatch.setattr(mis, "get_json", fake_get_json)
    monkeypatch.setattr(mis, "_ensure_cookie", lambda: None)

    result = mis.get_quote("00687B")

    assert calls == ["tse_00687B.tw", "otc_00687B.tw"]
    assert result["last_price"] == 27.89
    assert mis._channel_cache["00687B"] == "otc_00687B.tw"


def test_get_quote_caches_correct_channel_for_next_call(monkeypatch):
    mis._channel_cache.clear()
    calls: list[str] = []

    def fake_get_json(url, *, params=None, headers=None):
        ch = params["ex_ch"]
        calls.append(ch)
        row = _empty_row() if ch.startswith("tse_") else _real_row("00687B", ch)
        return {"msgArray": [row]}

    monkeypatch.setattr(mis, "get_json", fake_get_json)
    monkeypatch.setattr(mis, "_ensure_cookie", lambda: None)

    mis.get_quote("00687B")
    calls.clear()
    mis.get_quote("00687B")

    assert calls == ["otc_00687B.tw"]
