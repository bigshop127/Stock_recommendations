"""階段 2 真實驗收腳本（擴張版）。

涵蓋：
- 免金鑰源（隨時可跑）：TWSE MIS 五檔、TAIFEX 期貨/PC、yfinance 大盤、鉅亨/Google 新聞。
- 需金鑰源：FinMind OHLCV+籌碼（FINMIND_TOKEN）、FRED 總經（FRED_API_KEY）。
- 富果為可選：只有設定 FUGLE_API_KEY 時才測歷史分K 回溯範圍。

執行（從 engine/ 目錄）：
    .\.venv\Scripts\python.exe scripts\smoke_2330.py        # 或 ... 2317
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402
from app.data import service, taifex_client, twse_mis_client  # noqa: E402
from app.data.fugle_client import get_historical_candles  # noqa: E402
from app.data.http import DataSourceError  # noqa: E402

CODE = sys.argv[1] if len(sys.argv) > 1 else "2330"
TODAY = date.today()
YEAR_AGO = (TODAY - timedelta(days=365)).isoformat()
WEEK_AGO = (TODAY - timedelta(days=9)).isoformat()


def hr(title: str) -> None:
    print("\n" + "=" * 60 + f"\n{title}\n" + "=" * 60)


def section_keys() -> None:
    hr("0. 金鑰檢查")
    print(f"  FINMIND_TOKEN：{bool(settings.finmind_token)}　FUGLE_API_KEY：{bool(settings.fugle_api_key)}"
          f"　FRED_API_KEY：{bool(settings.fred_api_key)}")
    print(f"  BOOK_SOURCE：{settings.book_source}　快取目錄：{settings.cache_path}")


def section_book_mis() -> None:
    hr(f"1. TWSE MIS 即時最佳五檔（{CODE}，免金鑰）")
    try:
        q = twse_mis_client.get_quote(CODE)
        print(f"  股名：{q['name']}　channel：{q['channel']}　最新價：{q['last_price']}　time：{q['time']}")
        print(f"  委買五檔：{q['bids']}")
        print(f"  委賣五檔：{q['asks']}")
        if not q["bids"] and not q["asks"]:
            print("  （非交易時段五檔可能為空；盤中重跑可見即時委買賣）")
    except (DataSourceError, Exception) as exc:
        print(f"  取得失敗：{exc}")


def section_ohlcv() -> None:
    hr(f"2. FinMind 日K OHLCV（{CODE} 近一年；需 token）")
    try:
        res = service.get_ohlcv(CODE, YEAR_AGO, TODAY.isoformat())
        print(f"  股名：{res['name']}　筆數：{res['rows']}　cache_hit：{res['cache']['cache_hit']}")
        if res["data"]:
            print(f"  首筆：{res['data'][0]}")
            print(f"  末筆：{res['data'][-1]}")
        res2 = service.get_ohlcv(CODE, YEAR_AGO, TODAY.isoformat())
        print(f"  重跑 cache_hit：{res2['cache']['cache_hit']}（fetched={res2['cache']['fetched_ranges']}）")
    except DataSourceError as exc:
        print(f"  略過（缺 token？）：{exc}")


def section_chips() -> None:
    hr(f"3. FinMind 籌碼：三大法人 + 融資券（{CODE}；需 token）")
    try:
        res = service.get_chips(CODE, YEAR_AGO, TODAY.isoformat())
        print(f"  筆數：{res['rows']}　法人 cache_hit：{res['cache']['institutional']['cache_hit']}")
        if res["data"]:
            print(f"  末筆：{res['data'][-1]}")
    except DataSourceError as exc:
        print(f"  略過（缺 token？）：{exc}")


def section_futures() -> None:
    hr("4. TAIFEX 期貨：三大法人未平倉 + P/C Ratio（免金鑰）")
    try:
        pc = taifex_client.fetch_pc_ratio("OPT", WEEK_AGO, TODAY.isoformat())
        print(f"  P/C 筆數：{len(pc)}")
        if not pc.empty:
            print(f"  末筆 P/C：{pc.tail(1).to_dict('records')[0]}")
        inst = taifex_client.fetch_institutional_futures("TX", WEEK_AGO, TODAY.isoformat(), product="TX")
        print(f"  三大法人期貨未平倉筆數：{len(inst)}")
        if not inst.empty:
            print(f"  末筆：{inst.tail(1).to_dict('records')[0]}")
    except (DataSourceError, Exception) as exc:
        print(f"  取得失敗（盤後校正）：{exc}")


def section_news() -> None:
    hr("5. 新聞：鉅亨最新 + Google News 關鍵字（免金鑰）")
    try:
        latest = service.get_news(limit=3)
        print(f"  鉅亨最新 {latest['count']} 則：")
        for it in latest["items"][:3]:
            print(f"    - {(it['title'] or '')[:42]}　{it['published']}")
        kw = service.get_news(keyword=CODE, limit=3)
        print(f"  Google News「{CODE}」{kw['count']} 則：")
        for it in kw["items"][:3]:
            print(f"    - {(it['title'] or '')[:50]}")
    except (DataSourceError, Exception) as exc:
        print(f"  取得失敗：{exc}")


def section_macro() -> None:
    hr("6. FRED 美國總經（us10y / yield_curve；需 FRED_API_KEY）")
    try:
        for s in ("us10y", "yield_curve", "vix"):
            res = service.get_macro(s, (TODAY - timedelta(days=30)).isoformat(), TODAY.isoformat())
            tail = res["data"][-1] if res["data"] else None
            print(f"  {s:>11}（{res['series_id']}）筆數：{res['rows']}　末筆：{tail}")
    except DataSourceError as exc:
        print(f"  略過（缺 FRED_API_KEY？）：{exc}")


def section_market() -> None:
    hr("7. yfinance 大盤/美股快照（免金鑰）")
    res = service.get_market()
    for label, v in res["indices"].items():
        print(f"  {label:>7}（{v.get('symbol')}）→ close={v.get('close')} change%={v.get('change_pct')}")


def section_fugle_optional() -> None:
    if not settings.fugle_api_key:
        return
    hr(f"8. 富果 歷史分K 回溯範圍探測（{CODE}，timeframe=1；僅在有富果 key 時）")
    farthest = None
    for days_back in (1, 3, 5, 10, 20, 40, 60, 90, 120, 180, 365):
        d = (TODAY - timedelta(days=days_back)).isoformat()
        try:
            df = get_historical_candles(CODE, d, d, timeframe="1")
            ok = not df.empty
            print(f"    {d}（T-{days_back:>3}）→ {'有 ' + str(len(df)) + ' 根' if ok else '空'}")
            if ok:
                farthest = d
        except Exception as exc:
            print(f"    {d}（T-{days_back:>3}）→ 例外：{str(exc)[:80]}")
            break
    print(f"  → 最早可取分K 日期：{farthest or '（無）'}")


if __name__ == "__main__":
    section_keys()
    section_book_mis()
    section_ohlcv()
    section_chips()
    section_futures()
    section_news()
    section_macro()
    section_market()
    section_fugle_optional()
    print("\n✅ smoke 結束。免金鑰源（MIS/TAIFEX/news/yfinance）應直接可見；FinMind/FRED 需對應金鑰。")
