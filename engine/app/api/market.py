"""市場與大盤資訊 API 端點（Phase 1）。

提供大盤指數、多空寬度、類股表現及三大法人資訊。
"""
from __future__ import annotations

import datetime
from typing import Any
from fastapi import APIRouter, HTTPException, Query

from app.data import taifex_client, twse_mis_client, twse_report_client, yfinance_client
from app.data.http import DataSourceError
from app.puhui.watchlist import build_watchlist

router = APIRouter(prefix="/market", tags=["market"])

TW50_COMPONENTS = [
    "2330", "2317", "2454", "2308", "2881", "2882", "2382", "2301", "2891", "2886",
    "3711", "2412", "1216", "2885", "2884", "2892", "2880", "1301", "1303", "2002",
    "3008", "2357", "2395", "3231", "2603", "2609", "2615", "1101", "1102", "2379",
    "3045", "4938", "5871", "5876", "5880", "2890", "2883", "2887", "6505", "1326",
    "2327", "2912", "9904", "2888", "2303", "2352", "2324", "1402", "2105", "9910"
]

MIS_CHANNELS = {
    "水泥": "tse_t01.tw",
    "食品": "tse_t02.tw",
    "塑膠": "tse_t03.tw",
    "紡織纖維": "tse_t04.tw",
    "電機機械": "tse_t05.tw",
    "電器電纜": "tse_t06.tw",
    "化學生技醫療": "tse_t07.tw",
    "玻璃陶瓷": "tse_t08.tw",
    "造紙": "tse_t09.tw",
    "鋼鐵": "tse_t10.tw",
    "橡膠": "tse_t11.tw",
    "汽車": "tse_t12.tw",
    "電子": "tse_t13.tw",
    "建材營造": "tse_t14.tw",
    "航運": "tse_t15.tw",
    "觀光餐旅": "tse_t16.tw",
    "金融保險": "tse_t17.tw",
    "貿易百貨": "tse_t18.tw",
    "其他": "tse_t20.tw",
    "化學": "tse_t21.tw",
    "生技醫療": "tse_t22.tw",
    "油電燃氣": "tse_t23.tw",
    "半導體": "tse_t24.tw",
    "電腦及週邊": "tse_t25.tw",
    "光電": "tse_t26.tw",
    "通信網路": "tse_t27.tw",
    "電子零組件": "tse_t28.tw",
    "電子通路": "tse_t29.tw",
    "資訊服務": "tse_t30.tw",
    "其他電子": "tse_t31.tw",
}


def query_multi_mis(channels: str) -> list[dict]:
    """批次查詢 TWSE MIS API 取得即時指數資料。"""
    from app.data.http import get_json
    from app.data.twse_mis_client import _ensure_cookie, API, _HEADERS
    import time
    _ensure_cookie()
    params = {
        "ex_ch": channels,
        "json": "1",
        "delay": "0",
        "_": str(int(time.time() * 1000))
    }
    try:
        payload = get_json(API, params=params, headers=_HEADERS)
        if isinstance(payload, dict):
            return payload.get("msgArray") or []
    except Exception:
        pass
    return []


def calculate_ma_ratios(date_str: str, watchlist_codes: list[str]) -> dict:
    """計算指定日期大盤站上 20MA/50MA 的比例。"""
    from app.data import cache, yfinance_client
    codes = sorted(list(set(watchlist_codes + TW50_COMPONENTS)))
    
    end_date = datetime.date.fromisoformat(date_str)
    start_date = end_date - datetime.timedelta(days=100)
    start_str = start_date.isoformat()
    end_str = end_date.isoformat()
    
    above_20_count = 0
    above_50_count = 0
    valid_count = 0
    
    for code in codes:
        try:
            df, _ = cache.get_timeseries(
                "ohlcv_adj", code, start_str, end_str,
                yfinance_client.fetch_stock_ohlcv
            )
            if df.empty or len(df) < 50:
                continue
            
            last_row = df.iloc[-1]
            last_close = float(last_row["close"])
            
            ma20 = df["close"].iloc[-20:].mean()
            ma50 = df["close"].iloc[-50:].mean()
            
            if last_close > ma20:
                above_20_count += 1
            if last_close > ma50:
                above_50_count += 1
            valid_count += 1
        except Exception:
            continue
            
    return {
        "above_ma20_ratio": round(above_20_count / valid_count, 4) if valid_count > 0 else 0.0,
        "above_ma50_ratio": round(above_50_count / valid_count, 4) if valid_count > 0 else 0.0,
        "universe": "watchlist_union_0050",
        "sample_size": valid_count
    }


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except DataSourceError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"數據源錯誤：{exc}") from exc


@router.get("/indices", summary="大盤主要指數即時報價與 Sparkline")
def get_indices(
    range_param: str = Query("1d", alias="range", pattern="^(1d|5d|1m)$", description="Sparkline 區間")
):
    def _fetch():
        # 1. 批次拿 MIS 即時指數 (加權, 櫃買, 電子, 金融)
        mis_ch = "tse_t00.tw|otc_o00.tw|tse_t13.tw|tse_t17.tw"
        rows = query_multi_mis(mis_ch)
        mis_map = {row.get("ch"): row for row in rows if row.get("ch")}

        # 2. 拿台指期即時報價
        tx_quotes = {}
        try:
            tx_quotes = taifex_client.get_live_quotes()
        except Exception:
            pass

        # 3. 拿加權總成交金額當 volume
        twse_vol = None
        try:
            mi_data = twse_report_client.get_mi_index_ms(datetime.date.today().isoformat())
            if not mi_data:
                # 往前退一日拿
                mi_data, _ = twse_report_client.get_with_rollback(twse_report_client.get_mi_index_ms)
            if mi_data:
                twse_vol = mi_data.get("volume")
        except Exception:
            pass

        # 4. 組裝 5 指數
        indices_configs = [
            {"key": "TWSE", "name": "加權指數", "ch": "t00.tw", "yf": "^TWII", "vol": twse_vol},
            {"key": "OTC", "name": "櫃買指數", "ch": "o00.tw", "yf": "^TWOII", "vol": None},
            {"key": "electronic", "name": "電子工業", "ch": "t13.tw", "yf": "0053.TW", "vol": None},
            {"key": "finance", "name": "金融保險", "ch": "t17.tw", "yf": "0055.TW", "vol": None},
            {"key": "TX", "name": "台指期", "ch": None, "yf": "^TWII", "vol": None},
        ]

        out = []
        for cfg in indices_configs:
            price = None
            change = None
            change_pct = None
            volume = cfg["vol"]

            if cfg["key"] == "TX":
                # 從期交所取得
                tx_info = tx_quotes.get("TX")
                if tx_info:
                    price = tx_info["price"]
                    change = tx_info["change"]
                    change_pct = tx_info["change_pct"]
                    volume = tx_info["volume"]
            else:
                row = mis_map.get(cfg["ch"])
                if row:
                    try:
                        price = float(row.get("z", 0))
                        if price == 0 or price == "-":
                            price = float(row.get("o", 0)) or float(row.get("y", 0))
                        prev = float(row.get("y", 0))
                        change = price - prev
                        change_pct = (change / prev * 100) if prev != 0 else 0.0
                    except Exception:
                        pass

            # Sparkline 走勢
            intraday = []
            history = []
            
            if range_param == "1d":
                if cfg["key"] == "TX":
                    # TX 縮放加權走勢
                    twse_intraday = yfinance_client.fetch_intraday_sparkline("^TWII")
                    if twse_intraday and price:
                        # 找加權最新現值
                        twse_row = mis_map.get("t00.tw")
                        twse_price = None
                        if twse_row:
                            twse_price = float(twse_row.get("z", 0)) or float(twse_row.get("y", 0))
                        ratio = price / twse_price if (twse_price and twse_price != 0) else 1.0
                        intraday = [{"t": p["t"], "v": round(p["v"] * ratio, 2)} for p in twse_intraday]
                else:
                    intraday = yfinance_client.fetch_intraday_sparkline(cfg["yf"])
            else:
                if cfg["key"] == "TX":
                    # TX 歷史縮放加權走勢
                    twse_history = yfinance_client.fetch_history_sparkline("^TWII", range_param)
                    if twse_history and price:
                        twse_row = mis_map.get("t00.tw")
                        twse_price = None
                        if twse_row:
                            twse_price = float(twse_row.get("z", 0)) or float(twse_row.get("y", 0))
                        ratio = price / twse_price if (twse_price and twse_price != 0) else 1.0
                        history = [{"date": p["date"], "close": round(p["close"] * ratio, 2)} for p in twse_history]
                else:
                    history = yfinance_client.fetch_history_sparkline(cfg["yf"], range_param)

            out.append({
                "key": cfg["key"],
                "name": cfg["name"],
                "price": round(price, 2) if price is not None else None,
                "change": round(change, 2) if change is not None else None,
                "change_pct": round(change_pct, 4) if change_pct is not None else None,
                "volume": volume,
                "intraday": intraday,
                "history": history,
                "source": "TAIFEX" if cfg["key"] == "TX" else "TWSE MIS",
                "intraday_proxy": True if cfg["key"] == "TX" else False,
            })

        return {
            "date": datetime.date.today().isoformat(),
            "as_of": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "indices": out,
        }

    return _guard(_fetch)


@router.get("/breadth", summary="市場多空寬度統計")
def get_breadth(date: str | None = Query(None, description="日期 YYYY-MM-DD")):
    def _fetch():
        res, actual_date = twse_report_client.get_with_rollback(
            twse_report_client.get_mi_index_ms, date
        )
        
        # 取得 watchlist 代號，以計算站上 MA 比例
        wl_codes = []
        try:
            wl = build_watchlist(actual_date)
            wl_codes = [item["code"] for item in wl.get("items", [])]
        except Exception:
            pass
            
        ma_ratios = calculate_ma_ratios(actual_date, wl_codes)

        return {
            "date": actual_date,
            **res,
            **ma_ratios,
            "source": "TWSE",
        }

    return _guard(_fetch)


@router.get("/sectors", summary="產業類股成交量值與漲跌幅")
def get_sectors(date: str | None = Query(None, description="日期 YYYY-MM-DD")):
    def _fetch():
        res, actual_date = twse_report_client.get_with_rollback(
            twse_report_client.get_bfiamu, date
        )

        # 批次取得 MIS 指數計算類股即時漲跌幅
        channels = "|".join(MIS_CHANNELS.values())
        mis_rows = query_multi_mis(channels)
        
        mis_pct_map = {}
        for row in mis_rows:
            ch = row.get("ch")
            if not ch:
                continue
            try:
                price = float(row.get("z", 0))
                if price == 0 or price == "-":
                    price = float(row.get("o", 0)) or float(row.get("y", 0))
                prev = float(row.get("y", 0))
                change_pct = (price - prev) / prev * 100 if prev != 0 else 0.0
                mis_pct_map[ch] = round(change_pct, 4)
            except Exception:
                pass

        sectors_out = []
        for sec in res:
            name = sec["name"]
            ch_code = MIS_CHANNELS.get(name)
            change_pct = None
            if ch_code:
                ch_key = ch_code.replace("tse_", "").replace("otc_", "")
                if ch_key in mis_pct_map:
                    change_pct = mis_pct_map[ch_key]
                    
            sectors_out.append({
                "name": name,
                "change_pct": change_pct,
                "turnover": sec["turnover"],
                "source": "TWSE",
            })

        return {
            "date": actual_date,
            "sectors": sectors_out,
        }

    return _guard(_fetch)


@router.get("/institutional", summary="三大法人買賣超與歷史趨勢")
def get_institutional(
    date: str | None = Query(None, description="日期 YYYY-MM-DD"),
    days: int = Query(20, ge=1, le=60, description="趨勢天數"),
):
    def _fetch():
        latest, actual_date = twse_report_client.get_with_rollback(
            twse_report_client.get_bfi82u, date
        )

        # 往前追溯 days 個交易日建立 trend
        import time
        from app.data import cache
        trend = []
        curr_dt = datetime.date.fromisoformat(actual_date)
        attempts = 0
        max_attempts = days * 3 # 擴大搜尋範圍以防假期

        while len(trend) < days and attempts < max_attempts:
            date_str = curr_dt.isoformat()
            try:
                is_cached = cache.read_cache("twse_bfi82u", date_str) is not None
                data = twse_report_client.get_bfi82u(date_str)
                if data:
                    trend.append({
                        "date": date_str,
                        "foreign": data["foreign"],
                        "investment_trust": data["investment_trust"],
                        "dealer": data["dealer"],
                        "total": data["total"],
                    })
                    if not is_cached:
                        time.sleep(0.2)
            except Exception:
                pass
            curr_dt -= datetime.timedelta(days=1)
            attempts += 1

        # 轉為升序 (舊到新)
        trend = list(reversed(trend))

        return {
            "date": actual_date,
            "unit": "元",
            "latest": latest,
            "trend": trend,
            "source": "TWSE",
        }

    return _guard(_fetch)
