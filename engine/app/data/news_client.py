"""財經新聞 client（免費公開源；供階段4 F_sentiment）。

兩條免費路徑：
- 無關鍵字（大盤/最新台股新聞）→ 鉅亨 Anue 公開 JSON（newslist）。
- 帶關鍵字（個股輿情）        → Google News RSS（關鍵字搜尋，極穩定）。

統一輸出：[{title, summary, published(ISO), url, source_feed}]。

⚠️ 說明：
- 鉅亨 newslist 為公開但未文件化的 JSON 節點，路徑可能變動；失敗時自動退回 Google News RSS。
- 新聞屬時效性資料，本層不長期快取；情緒「歷史回測」需另建語料庫（階段4 再評估）。
- 僅取標題/摘要供情緒分析，不轉載全文。
"""
from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote
from xml.etree import ElementTree as ET

from app.data.http import DataSourceError, get_json, get_text

# 鉅亨 Anue 台股新聞列表（公開 JSON）
CNYES_NEWSLIST = "https://api.cnyes.com/media/api/v1/newslist/category/tw_stock"
CNYES_NEWS_URL = "https://news.cnyes.com/news/id/{id}"
# Google News RSS 關鍵字搜尋
GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"

_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) financeapp-engine/2"}


def _iso_from_epoch(sec) -> str | None:
    try:
        return datetime.fromtimestamp(int(sec), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _from_cnyes(limit: int) -> list[dict]:
    payload = get_json(CNYES_NEWSLIST, params={"limit": limit, "page": 1}, headers=_HEADERS)
    if not isinstance(payload, dict):
        raise DataSourceError(f"鉅亨 newslist 非預期回應：{str(payload)[:200]}")
    items = (payload.get("items") or {}).get("data") or []
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        nid = it.get("newsId") or it.get("id")
        out.append({
            "title": it.get("title"),
            "summary": (it.get("summary") or "").strip() or None,
            "published": _iso_from_epoch(it.get("publishAt")),
            "url": CNYES_NEWS_URL.format(id=nid) if nid else None,
            "source_feed": "cnyes",
        })
    return out


def _from_google_rss(keyword: str, limit: int) -> list[dict]:
    q = f"{keyword} when:7d"
    text = get_text(
        GOOGLE_NEWS_RSS,
        params={"q": q, "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"},
        headers=_HEADERS,
    )
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise DataSourceError(f"Google News RSS 解析失敗：{exc}") from exc
    out: list[dict] = []
    for item in root.iterfind(".//item"):
        title = item.findtext("title")
        link = item.findtext("link")
        pub = item.findtext("pubDate")
        src = item.findtext("source")
        out.append({
            "title": title,
            "summary": None,
            "published": pub,  # RFC822；階段4 正規化
            "url": link,
            "source_feed": f"google_news:{src}" if src else "google_news",
        })
        if len(out) >= limit:
            break
    return out


def get_news(keyword: str | None = None, limit: int = 30) -> list[dict]:
    """取新聞清單。帶 keyword（如股名/代號）→ Google News RSS；否則 → 鉅亨最新台股新聞。"""
    if keyword:
        return _from_google_rss(keyword, limit)
    try:
        return _from_cnyes(limit)
    except DataSourceError:
        # 鉅亨節點異動時的廣度備援
        return _from_google_rss("台股", limit)
