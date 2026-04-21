"""
run_daily.py
Daily automation entry point.
Triggered by Windows Task Scheduler at 15:30 on trading days.

Usage:
    python run_daily.py              # full scan (all MVP_UNIVERSE stocks)
    python run_daily.py --dry-run   # scan only, no Telegram push
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# Ensure working directory is this script's folder so relative imports work
os.chdir(Path(__file__).parent)

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler("daily_scan.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("run_daily")

# Load .env before any module that reads os.getenv
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv optional; set env vars via Task Scheduler or shell

from scanner import scan_today
from chart import generate_chart
from notifier import (
    BOT_TOKEN, CHAT_ID,
    notify_bear_market, notify_no_signal,
    notify_summary, notify_signal,
)

TZ_TAIPEI = ZoneInfo("Asia/Taipei")

# ── Stock name mapping (extend as needed) ──────────────────────────────────────
STOCK_NAMES: dict[str, str] = {
    "2330": "台積電", "2317": "鴻海", "2454": "聯發科", "2382": "廣達",
    "2308": "台達電", "2412": "中華電", "2881": "富邦金", "2882": "國泰金",
    "2886": "兆豐金", "2891": "中信金", "2884": "玉山金", "2892": "第一金",
    "2885": "元大金", "2880": "華南金", "2883": "開發金", "1301": "台塑",
    "1303": "南亞", "1326": "台化", "6505": "台塑化", "2002": "中鋼",
    "1216": "統一", "2912": "統一超", "5880": "合庫金", "2357": "華碩",
    "3711": "日月光投控", "2379": "瑞昱", "4904": "遠傳", "2303": "聯電",
    "2408": "南亞科", "2207": "和泰車", "3045": "台灣大", "2395": "研華",
    "5871": "中租控", "2603": "長榮", "2609": "陽明", "2615": "萬海",
    "1102": "亞泥", "1101": "台泥", "3034": "聯詠", "6669": "緯穎",
    "2345": "智邦", "2301": "光寶科", "3008": "大立光", "2376": "技嘉",
    "2354": "鴻準", "2887": "台新金", "2888": "新光金", "2890": "永豐金",
    "2474": "可成", "6415": "矽力-KY", "2344": "華邦電", "2449": "京元電子",
    "2337": "旺宏", "3037": "欣興", "2367": "燿華", "2388": "威盛",
    "2414": "精技", "3443": "創意", "3081": "聯亞", "5347": "世界",
    "2356": "英業達", "2353": "宏碁", "2352": "佳世達", "3706": "神達",
    "2409": "友達", "2498": "宏達電", "3481": "群創", "2324": "仁寶",
    "2329": "華泰", "2332": "友訊", "2338": "光罩", "2360": "致茂",
    "1504": "東元", "5904": "寶雅", "2915": "潤泰全", "2903": "遠百",
    "2201": "裕隆", "2204": "中華", "2206": "三陽工業", "2606": "裕民",
    "2612": "中航", "2616": "山隆", "2618": "長榮航", "2501": "國建",
    "2505": "國揚", "2511": "太子", "4711": "永信藥品", "2701": "萬企",
    "2702": "華園", "2105": "正新", "2106": "建大", "4906": "正文",
    "1590": "亞德客-KY", "2049": "上銀", "1717": "長興", "3673": "TPK宸鴻",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily signal scanner and Telegram notifier")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run scan but do not send Telegram messages")
    args = parser.parse_args()

    now = datetime.now(TZ_TAIPEI)
    today_str = now.strftime("%Y-%m-%d")
    logger.info("=== Daily scan started: %s ===", today_str)

    if not args.dry_run and (not BOT_TOKEN or not CHAT_ID):
        logger.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. "
                     "Add them to .env or use --dry-run.")
        sys.exit(1)

    # ── Run scan ───────────────────────────────────────────────────────────────
    signals, market_is_bull = scan_today()

    # ── Notify ─────────────────────────────────────────────────────────────────
    if args.dry_run:
        logger.info("[dry-run] Would send %d signal(s). Skipping Telegram.", len(signals))
        for s in signals:
            logger.info("  %s | RSI=%.1f | Risk=-%.1f%%", s["symbol"], s["rsi14"], s["risk_pct"])
        return

    if not market_is_bull:
        notify_bear_market(today_str)
        logger.info("Bear market notification sent.")
        return

    if not signals:
        notify_no_signal(today_str)
        logger.info("No-signal notification sent.")
        return

    # Send summary header
    notify_summary(signals, today_str)

    # Send individual cards (top 5 by RSI — same as max_positions=5 cap)
    for sig in signals[:5]:
        symbol = sig["symbol"]
        name = STOCK_NAMES.get(symbol, "")

        try:
            chart_path = generate_chart(symbol, name, sig["df"])
        except Exception as exc:
            logger.warning("Chart generation failed for %s: %s", symbol, exc)
            chart_path = Path("__no_chart__")

        notify_signal(sig, chart_path, name)
        logger.info("Signal card sent: %s", symbol)

    logger.info("=== Daily scan complete: %d signal(s) pushed ===", min(len(signals), 5))


if __name__ == "__main__":
    main()
