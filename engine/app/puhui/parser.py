"""老王每日報告解析器（純函式、確定性、無 LLM、不打網路）。

吃 `reports/**/*.md` 報告原文 → 結構化 `PuhuiDaily`（dict，JSON 可序列化）。
**這份 dict 就是舊提示詞口中那個從未存在的 `puhui_analysis` JSON。**

雙模板（Step 0 實查發現，phase4 原文沒寫到）：
- **rich**（2026-05-19 起，16 篇）：每檔一個 `### <span style="color:..">🔴 股名（代號）</span>` + 2 欄表格。
- **legacy**（2026-05-14/15，2 篇）：單一表格 `| 代號 | 名稱 | 關鍵訊號 | 操作建議 |`，無 emoji 色碼、含亂碼/佔位假資料 → 低信心。

代號反查（name→code）與落地快取在 `repo.py`，本檔只做純解析：
rich 模板標題有代號就抓、沒有就留 `code=None`（交給 repo 反查）。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta

from app.puhui.mapping import classify_signal, color_to_emoji, emoji_to_stance

_TPE = timezone(timedelta(hours=8))

_CN_NUM = {"零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

# rich 個股區塊標題：`### ... 🔴/🟠/🟢 ...`（可含 <span>）
_STOCK_HEADER = re.compile(r"^###\s+(.*?(🔴|🟠|🟢).*?)\s*$", re.MULTILINE)
# legacy 個股表頭：| 代號 | 名稱 | ... |
_LEGACY_TABLE_HEADER = re.compile(r"^\|\s*代號\s*\|\s*名稱\s*\|", re.MULTILINE)
# <span style="color:xxx">
_SPAN_COLOR = re.compile(r'color:\s*(#?[0-9a-zA-Z]+)')
# 名稱（代號）：全形/半形括號皆可
_NAME_CODE = re.compile(r"^(.+?)[（(]\s*([^（）()]+?)\s*[)）]\s*$")
_TW_CODE = re.compile(r"^\d{4,6}[A-Z]?$")        # 台股代號（含少數帶字母）


def _strip_md(s: str) -> str:
    """去除 span/mark/粗體/連結等 markdown/html 雜訊，留純文字。"""
    if not s:
        return ""
    s = re.sub(r"<span[^>]*>|</span>", "", s)
    s = re.sub(r"<mark[^>]*>|</mark>", "", s)
    s = re.sub(r"<[^>]+>", "", s)                 # 其餘 html tag
    s = s.replace("**", "").replace("`", "")
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)  # [文字](url) → 文字
    return s.strip()


def _cn_to_fraction(token: str) -> float | None:
    """把「五成」「七」「10」之類 → 0~1 持股比例。"""
    token = token.strip()
    if token.isdigit():
        n = int(token)
    elif token in _CN_NUM:
        n = _CN_NUM[token]
    else:
        return None
    # n 是「X 成」的 X（1~10）
    if 0 <= n <= 10:
        return round(n / 10.0, 2)
    # 退路：百分比（如「50」當 50%）
    if 0 <= n <= 100:
        return round(n / 100.0, 2)
    return None


def _parse_water_level(text: str) -> float | None:
    """從『整體操作水位』段落抓持股水位 → 0~1。抓不到回 None。"""
    # 取「操作水位」標題後到下一個標題/分隔線的區塊
    m = re.search(r"操作水位.*?\n(.*?)(?:\n#{1,3}\s|\n---|\Z)", text, re.DOTALL)
    block = m.group(1) if m else text[:600]
    block = _strip_md(block)
    # 「X成」優先；其次「X%」
    mm = re.search(r"([零一二兩三四五六七八九十\d]+)\s*成", block)
    if mm:
        return _cn_to_fraction(mm.group(1))
    mm = re.search(r"(\d+)\s*%", block)
    if mm:
        return round(int(mm.group(1)) / 100.0, 2)
    return None


def _market_sentiment(water: float | None) -> dict:
    """以持股水位推大盤情緒標籤（老王『操作水位』即其大盤立場）。"""
    if water is None:
        return {"label": "未知", "score": None}
    if water >= 0.7:
        label = "偏多"
    elif water >= 0.5:
        label = "中性"
    elif water >= 0.3:
        label = "保守"
    else:
        label = "防禦"
    return {"label": label, "score": round(water * 100)}


# ── rich 模板 ────────────────────────────────────────────────────────────────
def _parse_rich_stock(header_raw: str, body: str) -> dict:
    """單檔 rich 區塊 → stock dict。"""
    emoji_m = re.search(r"(🔴|🟠|🟢)", header_raw)
    emoji = emoji_m.group(1) if emoji_m else None
    color_m = _SPAN_COLOR.search(header_raw)
    if emoji is None and color_m:
        emoji = color_to_emoji(color_m.group(1))

    title = _strip_md(re.sub(r"🔴|🟠|🟢", "", header_raw)).strip()
    name, code = title, None
    nc = _NAME_CODE.match(title)
    if nc:
        name = nc.group(1).strip()
        cand = nc.group(2).strip()
        code = cand if _TW_CODE.match(cand) else None   # 非台股代號（MU/Intel…）→ None

    # 表格 row：| 標籤 | 值 |
    rows: dict[str, str] = {}
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        label = _strip_md(cells[0])
        value = _strip_md(cells[1])
        if not label or label.startswith("---") or "項目" in label:
            continue
        rows[label] = value

    action = ""
    for k, v in rows.items():
        if "操作建議" in k:
            action = v
            break
    # reason：近期表現/技術 + 操作建議，串起來給前端
    reason_parts = [v for k, v in rows.items()
                    if any(t in k for t in ("近期表現", "技術", "操作建議", "外資籌碼", "下跌原因"))]
    reason = "；".join(p for p in reason_parts if p)[:300] or action

    signal, score, note = classify_signal(emoji, action or reason)
    return {
        "name": name, "code": code, "emoji": emoji,
        "stance": emoji_to_stance(emoji),
        "signal": signal, "score": score,
        "raw_action": action, "reason": reason, "note": note,
        "is_tw": bool(code),   # repo 會對 code=None 但像台股的做反查
    }


def _parse_rich(text: str) -> list[dict]:
    headers = list(_STOCK_HEADER.finditer(text))
    stocks = []
    for i, m in enumerate(headers):
        start = m.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        body = text[start:end]
        # 個股區塊內若撞到下一個 ## 大段落，截斷（避免吃到非個股內容）
        cut = re.search(r"\n##\s", body)
        if cut:
            body = body[: cut.start()]
        stocks.append(_parse_rich_stock(m.group(1), body))
    return stocks


# ── legacy 模板 ──────────────────────────────────────────────────────────────
def _parse_legacy(text: str) -> list[dict]:
    """單表格 `| 代號 | 名稱 | 關鍵訊號 | 操作建議 |`。無 emoji → 純關鍵詞、低信心。"""
    m = _LEGACY_TABLE_HEADER.search(text)
    if not m:
        return []
    stocks = []
    lines = text[m.start():].splitlines()
    for line in lines[1:]:
        line = line.strip()
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2 or set("".join(cells)) <= set("-: "):
            continue
        if "代號" in cells[0]:
            continue
        code = cells[0] if _TW_CODE.match(cells[0]) else None
        name = cells[1] if len(cells) > 1 else cells[0]
        key_sig = cells[2] if len(cells) > 2 else ""
        action = cells[3] if len(cells) > 3 else key_sig
        signal, score, note = classify_signal(None, action or key_sig)
        stocks.append({
            "name": _strip_md(name), "code": code, "emoji": None, "stance": None,
            "signal": signal, "score": score,
            "raw_action": _strip_md(action), "reason": _strip_md(f"{key_sig}；{action}").strip("；"),
            "note": note + "（legacy 模板，低信心）", "is_tw": bool(code),
        })
    return stocks


# ── 入口 ─────────────────────────────────────────────────────────────────────
def parse_report(text: str, date: str, source_file: str | None = None) -> dict:
    """報告原文 → PuhuiDaily dict（純函式）。

    自動偵測模板：有 rich 個股標題用 rich；否則退 legacy 單表格。
    """
    notes: list[str] = []
    is_rich = bool(_STOCK_HEADER.search(text))
    if is_rich:
        template = "rich"
        stocks = _parse_rich(text)
    else:
        template = "legacy"
        stocks = _parse_legacy(text)
        notes.append("legacy 模板（早期報告，無 emoji 色碼、可能含佔位資料）→ 信心折半")

    water = _parse_water_level(text)
    if water is None:
        notes.append("未解析到操作水位 → market 過濾退出")

    tw_stocks = [s for s in stocks if s["code"]]
    foreign = [s for s in stocks if not s["code"]]
    if foreign:
        notes.append(f"{len(foreign)} 檔無台股代號（美股/待反查）→ {[s['name'] for s in foreign]}")

    return {
        "date": date,
        "source_file": source_file,
        "template": template,
        "water_level": water,
        "market_sentiment": _market_sentiment(water),
        "stocks": stocks,
        "tw_count": len(tw_stocks),
        "notes": notes,
        "parsed_at": datetime.now(_TPE).isoformat(timespec="seconds"),
    }
