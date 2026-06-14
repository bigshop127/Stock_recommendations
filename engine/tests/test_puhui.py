"""階段4 老王整合測試（純運算/解析，不打網路；網路相依用 monkeypatch）。

重點驗收：
- 🚨 emoji 色碼語意相反（🔴看多/🟢看空）不被「紅漲綠跌」反向（專測鎖死）。
- 看多建議內的「條件式停損」不被誤判成 SELL。
- 雙模板（rich/legacy）都能解析。
- 量化×老王 背離 → conflict + 降信心、且不蓋掉量化分。
- 缺日 fallback / legacy 折扣 / name→code 反查 / 觀察清單雙排序。
"""
from pathlib import Path

import pytest

from app.factors.config import DEFAULT_CONFIG
from app.puhui import blend, mapping, parser, repo
from app.puhui import watchlist as wl

CFG = DEFAULT_CONFIG
RICH = repo.REPORTS_DIR / "2026-06" / "W2" / "2026-06-12.md"
LEGACY = repo.REPORTS_DIR / "2026-05" / "W2" / "2026-05-14.md"


# ── 🚨 emoji 語意相反（本階段「還原股價級」陷阱）──────────────────────────────
def test_emoji_semantics_are_inverted_not_stock_convention():
    assert mapping.emoji_to_stance("🔴") == "bull"     # 紅=看多（非「跌」）
    assert mapping.emoji_to_stance("🟢") == "bear"     # 綠=看空（非「漲」）
    assert mapping.emoji_to_stance("🟠") == "neutral"

    sig_r, score_r, _ = mapping.classify_signal("🔴", "可順勢翻多買進")
    sig_g, score_g, _ = mapping.classify_signal("🟢", "跌破季均線、四面楚歌空方型態")
    assert sig_r in {"BUY", "ADD", "HOLD"} and score_r > 60
    assert sig_g in {"REDUCE", "SELL", "WATCH"} and score_g < 50
    assert score_r > score_g                            # 🔴 必定高於 🟢


def test_conditional_stoploss_inside_buy_is_not_sell():
    """看多建議『跌破均線即停損出場』是風險提示，不是賣訊。"""
    sig, _, _ = mapping.classify_signal("🔴", "可順勢翻多買進，跌破三條短期均線即停損出場")
    assert sig == "BUY"


def test_green_wait_to_buy_is_bearish_watch():
    sig, score, _ = mapping.classify_signal("🟢", "耐心等待站上所有短中長期均線（四海遊龍）再買進")
    assert sig == "WATCH"
    assert score == mapping.WATCH_BEARISH_SCORE       # 比中性 WATCH 更低（偏空觀望）


def test_primary_sell_keyword():
    sig, _, _ = mapping.classify_signal("🟢", "跌破均線，一律先賣、出清持股")
    assert sig == "SELL"


def test_legacy_no_emoji_uses_keyword():
    sig, _, _ = mapping.classify_signal(None, "進場點：100，停損點：90，目標價：120")
    assert sig == "BUY"


def test_negation_not_flipped_to_bearish():
    """🔴 看多股：『不賣出』『減碼都不需要做』是看多語意，不能被反向成 SELL/REDUCE。"""
    sig1, _, _ = mapping.classify_signal("🔴", "週二關鍵防守日不賣出,多賺兩根漲停板")
    assert sig1 in {"BUY", "ADD", "HOLD"}
    sig2, _, _ = mapping.classify_signal("🔴", "持續守住五日均線連獲利減碼動作都不需要做")
    assert sig2 in {"BUY", "ADD", "HOLD"}
    # 但真正的「獲利減碼一半」仍要判 REDUCE（否定守門不可矯枉過正）
    sig3, _, _ = mapping.classify_signal("🟠", "按基本操作法則 獲利減碼一半持股")
    assert sig3 == "REDUCE"


# ── 雙模板解析（用 repo 內真實報告檔，確定性）─────────────────────────────────
def test_parse_rich_report():
    d = parser.parse_report(RICH.read_text(encoding="utf-8"), "2026-06-12")
    assert d["template"] == "rich"
    assert d["water_level"] == 0.5                     # 「五成或以下」
    by_code = {s["code"]: s for s in d["stocks"] if s["code"]}
    assert by_code["2303"]["emoji"] == "🔴"            # 聯電
    assert by_code["2303"]["signal"] == "BUY"
    assert by_code["3017"]["stance"] == "bear"         # 奇鋐 🟢
    assert by_code["3017"]["signal"] in {"WATCH", "REDUCE"}
    # 美股無台股代號 → code=None（交給反查/降級）
    foreign = [s["name"] for s in d["stocks"] if not s["code"]]
    assert any(("美光" in n) or ("甲骨文" in n) or ("英特爾" in n) for n in foreign)


def test_parse_legacy_report():
    d = parser.parse_report(LEGACY.read_text(encoding="utf-8"), "2026-05-14")
    assert d["template"] == "legacy"
    assert d["water_level"] == 0.7                     # 「七成」
    codes = {s["code"] for s in d["stocks"] if s["code"]}
    assert "2330" in codes
    assert all(s["emoji"] is None for s in d["stocks"])


# ── 融合（決策3）──────────────────────────────────────────────────────────────
def test_water_to_gate_bounds():
    assert blend.water_to_gate(None) is None
    assert 0.8 <= blend.water_to_gate(0.5) <= 0.9
    assert blend.water_to_gate(1.0) <= CFG.puhui.water_gate_cap + 1e-9
    assert blend.water_to_gate(0.1) >= CFG.puhui.water_gate_floor - 1e-9


def test_assess_agreement():
    assert blend.assess_agreement(40.0, 88.0, CFG) == ("divergent", True)   # 量空 vs 老王多
    assert blend.assess_agreement(80.0, 88.0, CFG) == ("aligned", False)    # 同多
    assert blend.assess_agreement(50.0, 88.0, CFG) == ("neutral", False)    # 量化中性
    assert blend.assess_agreement(80.0, None, CFG) == ("no_puhui", False)


def test_blended_conflict_lowers_conf_and_keeps_quant(monkeypatch):
    """老王看多 vs 量化偏空 → conflict、降信心，量化分不被蓋掉。"""
    fake_swing = {"code": "2303", "name": "聯電", "date": "2026-06-12", "mode": "swing",
                  "action": "reduce", "score": 40.0, "confidence": 0.70, "factors": [],
                  "reasons": ["量化偏空"], "regime_gate": 1.0, "live_only": False,
                  "generated_at": "2026-06-12T08:00:00+08:00"}
    monkeypatch.setattr(blend, "build_swing_signal", lambda code, date, cfg: dict(fake_swing))
    fake_daily = {"as_of_date": "2026-06-12", "requested_date": "2026-06-12", "stale": False,
                  "fallback_days": 0, "confidence_factor": 1.0, "water_level": 0.5, "notes": [],
                  "stocks": [{"code": "2303", "name": "聯電", "emoji": "🔴", "stance": "bull",
                              "signal": "BUY", "score": 88.0, "raw_action": "買進", "reason": "買進"}]}
    monkeypatch.setattr(blend.repo, "get_daily", lambda date, cfg=CFG: dict(fake_daily))

    out = blend.build_blended_signal("2303", "2026-06-12")
    assert out["conflict"] is True
    assert out["confidence"] < 0.70                      # 降信心
    assert out["blend"]["quant_swing_score"] == 40.0     # 量化分保留
    assert out["score"] < 50                             # 仍偏空，未被老王看多蓋成多
    assert out["puhui"]["signal"] == "BUY"


def test_blended_aligned_boosts_conf(monkeypatch):
    fake_swing = {"code": "2303", "name": "聯電", "date": "2026-06-12", "mode": "swing",
                  "action": "buy", "score": 80.0, "confidence": 0.60, "factors": [],
                  "reasons": [], "regime_gate": 1.0, "live_only": False, "generated_at": "x"}
    monkeypatch.setattr(blend, "build_swing_signal", lambda code, date, cfg: dict(fake_swing))
    fake_daily = {"as_of_date": "2026-06-12", "requested_date": "2026-06-12", "stale": False,
                  "fallback_days": 0, "confidence_factor": 1.0, "water_level": 0.8, "notes": [],
                  "stocks": [{"code": "2303", "name": "聯電", "emoji": "🔴", "stance": "bull",
                              "signal": "BUY", "score": 88.0, "raw_action": "買進", "reason": "買進"}]}
    monkeypatch.setattr(blend.repo, "get_daily", lambda date, cfg=CFG: dict(fake_daily))
    out = blend.build_blended_signal("2303", "2026-06-12")
    assert out["agreement"] == "aligned"
    assert out["confidence"] >= 0.60


# ── repo：反查 / fallback / 折扣 ──────────────────────────────────────────────
def test_resolve_codes_reverse_lookup(monkeypatch):
    daily = {"stocks": [{"name": "緯創", "code": None, "is_tw": False},
                        {"name": "美光", "code": None, "is_tw": False}], "notes": []}
    monkeypatch.setattr(repo.finmind_client, "get_code_by_name",
                        lambda n: "3231" if n == "緯創" else None)
    out = repo._resolve_codes(daily)
    got = {s["name"]: s["code"] for s in out["stocks"]}
    assert got["緯創"] == "3231"
    assert got["美光"] is None                          # 美股查無 → 不硬猜


def test_fallback_uses_recent_and_marks_stale(monkeypatch):
    monkeypatch.setattr(repo, "_scan_index",
                        lambda force=False: {"2026-06-10": Path("a"), "2026-06-12": Path("b")})
    monkeypatch.setattr(repo, "_parse_one",
                        lambda date, use_cache, resolve: {"date": date, "template": "rich",
                                                          "stocks": [], "notes": [], "water_level": 0.5})
    d = repo.get_daily("2026-06-15")                     # 無當日報告
    assert d["as_of_date"] == "2026-06-12" and d["stale"] is True
    assert d["confidence_factor"] == CFG.puhui.stale_conf_factor
    assert repo.get_daily("2026-06-30") is None          # 超過 fallback 視窗 → 退出


def test_legacy_confidence_discount(monkeypatch):
    monkeypatch.setattr(repo, "_scan_index", lambda force=False: {"2026-05-14": Path("x")})
    monkeypatch.setattr(repo, "_parse_one",
                        lambda date, use_cache, resolve: {"date": date, "template": "legacy",
                                                          "stocks": [], "notes": [], "water_level": 0.7})
    d = repo.get_daily("2026-05-14")
    assert d["stale"] is False
    assert d["confidence_factor"] == CFG.puhui.legacy_conf_factor


# ── 觀察清單（決策4：純量化排序 + 老王 tag/source）──────────────────────────────
def test_watchlist_dual_rank_and_source(monkeypatch):
    monkeypatch.setattr(wl.repo, "get_daily", lambda date, cfg=CFG: {
        "requested_date": date, "as_of_date": date, "stale": False, "water_level": 0.5, "notes": [],
        "stocks": [{"code": "2303", "name": "聯電", "emoji": "🔴", "signal": "BUY",
                    "score": 88, "raw_action": "買進", "reason": "買進"}]})

    def fake_swing(code, date, cfg):
        return {"code": code, "name": code, "score": {"2303": 80.0, "2330": 50.0}.get(code, 55.0),
                "confidence": 0.6, "reasons": ["外資連 3 買"], "regime_gate": 1.0}
    monkeypatch.setattr(wl, "build_swing_signal", fake_swing)
    # 盤後無盤口：daytrade 因子皆退出 → daytrade_prob = None（排末）
    monkeypatch.setattr(wl, "build_daytrade_signal",
                        lambda code, cfg: {"score": 0.0, "factors": [{"weight": 0.0}]})

    out = wl.build_watchlist("2026-06-12", extra_codes=["2330"])
    items = {it["code"]: it for it in out["items"]}
    assert items["2303"]["rank_swing"] == 1             # 80 > 50（純量化排序）
    assert "puhui" in items["2303"]["source"]
    assert items["2330"]["source"] == ["factor"]
    assert items["2303"]["daytrade_prob"] is None       # 盤後無盤口 → null
    assert items["2303"]["puhui_signal"] == "BUY"       # 老王當 tag/欄位、不污染排名
