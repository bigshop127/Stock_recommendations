"""老王訊號映射表（決策2，使用者 2026-06-14 定案）。

把報告個股區塊的 **emoji 色碼** 與 **操作建議關鍵詞** → 標準化 `signal ∈
{BUY, ADD, HOLD, WATCH, REDUCE, SELL}` 與 0~100 分數（同一分數即 sentiment 子訊號 `puhui`）。

## 🚨 最大坑：報告 emoji 色碼語意與股市慣例「相反」
報告模板（由 `scripts/puhui_daily.cjs` 的系統提示詞定義）個股色碼是：
- 🔴 color:red    ＝ **可持續抱股 / 看多**（不是「跌」！）
- 🟠 color:#B35A00 ＝ **觀察、訊號待確認**
- 🟢 color:green  ＝ **風險警示 / 看空**（不是「漲」！）
用「紅漲綠跌」直覺映射會把每一檔反向 → 本表以上述語意為準，並有專測鎖死。

## 設計
- **emoji 為主**：決定分數帶（看多/觀察/看空）。
- **操作建議關鍵詞為輔**：在帶內挑 action 標籤、微調分數。
- **條件式停損不算 SELL**：個股看多建議常附「跌破均線即停損出場」，那是風險提示、不是賣訊；
  只有「一律先賣 / 出清 / 賣出」等**主指令**才判 SELL（見 `classify_signal` 順序與專測）。
- 舊版模板無 emoji（emoji=None）→ 純靠關鍵詞，信心由 repo 層砍半並標 `legacy_template`。
"""
from __future__ import annotations

import re

# emoji → 立場（語意相反，見上）
_EMOJI_STANCE = {"🔴": "bull", "🟠": "neutral", "🟢": "bear"}

# color hex / 名稱 → emoji（解析 <span style="color:..."> 時備援）
_COLOR_EMOJI = {
    "red": "🔴", "#b35a00": "🟠", "green": "🟢",
}

# 標準 signal → 分數（0~100；emoji 帶內由關鍵詞挑選）
SIGNAL_SCORE = {
    "BUY": 88.0,     # 明確進場
    "ADD": 78.0,     # 加碼 / 續抱
    "HOLD": 65.0,    # 看多但無明確動作
    "WATCH": 50.0,   # 觀察待確認
    "REDUCE": 32.0,  # 減碼 / 調節
    "SELL": 18.0,    # 出清 / 賣出 / 主指令停損
}
# 🟢（看空）但建議「等站上均線再買」→ 偏空觀望，比中性 WATCH 再低一階
WATCH_BEARISH_SCORE = 40.0

# 關鍵詞群（以出現即命中；順序在 classify 內處理優先級）
_KW_BUY = re.compile(r"買進|進場|順勢買|順勢翻多|翻多買|可買|逢低買|突破買|突破後買")
_KW_ADD = re.compile(r"續抱|加碼|可抱|持有|抱牢|留倉|留強")
_KW_REDUCE = re.compile(r"減碼|調節|汰弱|降低持股|減持")
_KW_SELL = re.compile(r"出清|一律先賣|賣出|先賣|停損出場|轉弱出場|跌破.{0,6}賣")
# 「等/待…再買進」「尚未/暫勿/觀察」= 觀望條件（即使含「買」字也不是現在買）
_KW_WATCH_COND = re.compile(r"等[^。，]*?再?(?:買|進場)|待[^。，]*?(?:確認|站上)|尚未|暫勿|暫不|觀察|等待|待.*?突破")

# 否定詞：避免「不賣出」「減碼都不需要做」被誤判（前 3 / 後 5 字窗內出現即視為否定）
_NEG_MARK = re.compile(r"[不勿別未沒無免]")


def _negated(text: str, start: int, end: int) -> bool:
    return bool(_NEG_MARK.search(text[max(0, start - 3):start]) or _NEG_MARK.search(text[end:end + 5]))


def _hit(pat: re.Pattern, text: str) -> bool:
    """關鍵詞命中且**非否定語境**才算（每個出現點各自判否定）。"""
    return any(not _negated(text, m.start(), m.end()) for m in pat.finditer(text))


def color_to_emoji(color: str | None) -> str | None:
    """<span style="color:..."> 的色值 → emoji（解析備援；emoji 缺時用）。"""
    if not color:
        return None
    return _COLOR_EMOJI.get(color.strip().lower())


def emoji_to_stance(emoji: str | None) -> str | None:
    """emoji → 'bull' | 'neutral' | 'bear' | None。**語意相反，勿用紅漲綠跌**。"""
    return _EMOJI_STANCE.get(emoji or "")


def classify_signal(emoji: str | None, action_text: str | None) -> tuple[str, float, str]:
    """(emoji, 操作建議原文) → (signal, score, note)。

    emoji 定分數帶、關鍵詞挑 action。回 note 說明判定依據（給 reasons/除錯）。
    """
    text = (action_text or "").strip()
    stance = emoji_to_stance(emoji)

    has_watch_cond = bool(_KW_WATCH_COND.search(text))
    # 買訊：命中買進關鍵詞且**非**「等…再買」這種觀望條件；其餘關鍵詞均過否定詞守門
    has_buy = _hit(_KW_BUY, text) and not has_watch_cond
    has_add = _hit(_KW_ADD, text)
    has_reduce = _hit(_KW_REDUCE, text)
    has_sell = _hit(_KW_SELL, text)

    # ── 看多帶（🔴）──────────────────────────────────────────────
    if stance == "bull":
        # 注意：買訊優先於「停損」字樣（看多建議內的條件式停損非賣訊）
        if has_buy:
            return "BUY", SIGNAL_SCORE["BUY"], "🔴看多＋明確進場"
        if has_reduce:
            return "REDUCE", SIGNAL_SCORE["REDUCE"], "🔴看多但建議減碼（背離→以文字為準）"
        if has_sell and not has_add:
            return "SELL", SIGNAL_SCORE["SELL"], "🔴看多但建議出清（背離）"
        if has_add:
            return "ADD", SIGNAL_SCORE["ADD"], "🔴看多＋續抱/加碼"
        return "HOLD", SIGNAL_SCORE["HOLD"], "🔴看多（無明確動作→續抱）"

    # ── 觀察帶（🟠）──────────────────────────────────────────────
    if stance == "neutral":
        if has_buy:
            return "WATCH", SIGNAL_SCORE["WATCH"] + 5, "🟠觀察（出現買訊但待確認）"
        if has_sell or has_reduce:
            return "REDUCE", SIGNAL_SCORE["REDUCE"], "🟠觀察＋偏空操作"
        return "WATCH", SIGNAL_SCORE["WATCH"], "🟠觀察、訊號待確認"

    # ── 看空帶（🟢）──────────────────────────────────────────────
    if stance == "bear":
        if has_sell:
            return "SELL", SIGNAL_SCORE["SELL"], "🟢看空＋出清/賣出"
        if has_reduce:
            return "REDUCE", SIGNAL_SCORE["REDUCE"], "🟢看空＋減碼"
        if has_watch_cond or has_buy or has_add:
            # 「等站上所有均線再買」= 目前空方、留意翻多 → 偏空觀望
            return "WATCH", WATCH_BEARISH_SCORE, "🟢看空但留意（等條件成立再進）"
        return "REDUCE", SIGNAL_SCORE["REDUCE"], "🟢風險警示/看空"

    # ── 無 emoji（舊版模板）：純關鍵詞 ───────────────────────────────
    if has_buy:
        return "BUY", SIGNAL_SCORE["BUY"], "（無色碼）關鍵詞：進場"
    if has_add:
        return "ADD", SIGNAL_SCORE["ADD"], "（無色碼）關鍵詞：續抱/加碼"
    if has_sell:
        return "SELL", SIGNAL_SCORE["SELL"], "（無色碼）關鍵詞：賣出/出清"
    if has_reduce:
        return "REDUCE", SIGNAL_SCORE["REDUCE"], "（無色碼）關鍵詞：減碼"
    return "WATCH", SIGNAL_SCORE["WATCH"], "（無色碼）無明確操作關鍵詞→觀察"
