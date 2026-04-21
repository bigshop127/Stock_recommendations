"""
notifier.py
Sends Telegram push notifications with mplfinance chart images.
Reads BOT_TOKEN and CHAT_ID from environment variables.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org"
_TV_LINK = "https://www.tradingview.com/chart/?symbol=TWSE:{symbol}"

BOT_TOKEN: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
CHAT_ID: str   = os.getenv("TELEGRAM_CHAT_ID", "")


def _post(endpoint: str, **kwargs) -> bool:
    """Generic Telegram Bot API POST with basic error logging."""
    if not BOT_TOKEN or not CHAT_ID:
        logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured.")
        return False
    url = f"{_TELEGRAM_API}/bot{BOT_TOKEN}/{endpoint}"
    try:
        resp = requests.post(url, timeout=30, **kwargs)
        if resp.status_code != 200:
            logger.warning("Telegram API %s returned %d: %s", endpoint, resp.status_code, resp.text[:200])
        return resp.status_code == 200
    except requests.RequestException as exc:
        logger.error("Telegram request failed: %s", exc)
        return False


def send_text(text: str) -> bool:
    return _post("sendMessage", json={
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    })


def send_photo(photo_path: Path, caption: str) -> bool:
    if not photo_path.exists():
        logger.warning("Chart not found: %s — sending text only.", photo_path)
        return send_text(caption)
    with open(photo_path, "rb") as f:
        return _post("sendPhoto", data={
            "chat_id": CHAT_ID,
            "caption": caption,
            "parse_mode": "Markdown",
        }, files={"photo": ("chart.png", f, "image/png")})


# ── Public API ─────────────────────────────────────────────────────────────────

def notify_bear_market(date_str: str) -> None:
    """Notify that today is a bear market day — no signals sent."""
    send_text(
        f"📭 *{date_str} — 今日無訊號*\n"
        f"原因：0050 收盤低於季線（MA60），大盤空頭確認。\n"
        f"系統暫停進場，明日再見。"
    )


def notify_no_signal(date_str: str) -> None:
    """Notify that scan ran but no stocks triggered today."""
    send_text(
        f"📭 *{date_str} — 今日無訊號*\n"
        f"大盤多頭確認 ✅，但全市場無股票同時滿足所有條件。\n"
        f"明日繼續觀察。"
    )


def notify_summary(signals: list[dict], date_str: str) -> None:
    """Send a header summary before individual signal cards."""
    lines = [f"🎯 *{date_str} 作戰名單 — 共 {len(signals)} 檔訊號*\n"]
    for i, s in enumerate(signals, 1):
        lines.append(
            f"{i}. `{s['symbol']}` | RSI {s['rsi14']:.1f} "
            f"| 量比 {s['vol_ratio']:.1f}x | 預估風險 -{s['risk_pct']:.1f}%"
        )
    lines.append("\n⬇️ 個別訊號卡片如下")
    send_text("\n".join(lines))


def notify_signal(sig: dict, chart_path: Path, stock_name: str = "") -> None:
    """Send one formatted signal card with a chart image."""
    symbol = sig["symbol"]
    display = f"{stock_name} ({symbol})" if stock_name else symbol
    tv_link = _TV_LINK.format(symbol=symbol)

    caption = (
        f"📊 *{display}*\n"
        f"【MA10 突破動能名單】\n\n"
        f"訊號：大盤多頭確認 ✅ | RSI: {sig['rsi14']:.1f} | 量比: {sig['vol_ratio']:.1f}x\n"
        f"進場：明日開盤掛入（今日收盤 ${sig['close']:.2f}）\n"
        f"停損：跌破 MA10 = ${sig['stop']:.2f}（預估單股風險 -{sig['risk_pct']:.1f}%）\n"
        f"目標：1.5R 停利一半 / 2.5R 全出\n\n"
        f"🔗 [TradingView 圖表]({tv_link})"
    )

    send_photo(chart_path, caption)
