"""市場與大盤資訊 API 端點（Phase 1）。

提供大盤指數、多空寬度、類股表現及三大法人資訊。
"""
from __future__ import annotations

import datetime
import json
import math
from pathlib import Path
from typing import Any
from fastapi import APIRouter, HTTPException, Query

from app.core.config import settings
from app.data import taifex_client, twse_mis_client, twse_report_client, yfinance_client, finmind_client, cache
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


# ── 資金潮汐相關輔助與端點 ──────────────────────────────────────────────────
_code_sector_map: dict[str, str] | None = None

def get_sector_by_code(code: str) -> str:
    global _code_sector_map
    if _code_sector_map is None:
        _code_sector_map = {}
        try:
            raw = finmind_client._finmind_get("TaiwanStockInfo", "", "2000-01-01", "2100-01-01")
            if not raw.empty and {"stock_id", "industry_category"} <= set(raw.columns):
                for sid, cat in zip(raw["stock_id"].astype(str), raw["industry_category"].astype(str)):
                    sid = sid.strip()
                    cat = cat.strip()
                    if cat and cat != "None" and cat != "nan" and cat != "":
                        _code_sector_map[sid] = cat
        except Exception:
            pass
    return _code_sector_map.get(code, "其他")


def get_recent_trading_days(end_date_str: str, n: int = 6) -> list[str]:
    """獲取指定日期（含）前 N 個加權指數交易日。"""
    end_dt = datetime.date.fromisoformat(end_date_str)
    start_dt = end_dt - datetime.timedelta(days=n * 3 + 10)
    start_str = start_dt.isoformat()
    try:
        df, _ = cache.get_timeseries(
            "ohlcv_adj", "^TWII", start_str, end_date_str,
            yfinance_client.fetch_stock_ohlcv
        )
        if not df.empty:
            dates = df["date"].astype(str).tolist()
            dates = [d for d in dates if d <= end_date_str]
            if len(dates) >= n:
                return dates[-n:]
    except Exception:
        pass
    # 備用方案：跳過六日
    dates = []
    curr = end_dt
    while len(dates) < n:
        if curr.weekday() < 5:
            dates.append(curr.isoformat())
        curr -= datetime.timedelta(days=1)
    return list(reversed(dates))


def get_capital_tide_cache(date_str: str, universe: str) -> dict | None:
    p = settings.cache_path / "capital_tide" / f"{date_str}_{universe}.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return None


def write_capital_tide_cache(date_str: str, universe: str, data: dict) -> None:
    p = settings.cache_path / "capital_tide" / f"{date_str}_{universe}.json"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


@router.get("/capital-tide", summary="資金潮汐數據（資金流向 × 動能泡泡圖）")
def get_capital_tide(
    date: str | None = Query(None, description="日期 YYYY-MM-DD"),
    universe: str = Query("watchlist_union_0050", description="評估個股範圍")
):
    def _fetch():
        # 1. 取得實際日期
        _, actual_date = twse_report_client.get_with_rollback(
            twse_report_client.get_mi_index_ms, date
        )
        
        # 2. 檢查快取
        cached_data = get_capital_tide_cache(actual_date, universe)
        if cached_data:
            return cached_data

        # 3. 取得 universe 代號
        wl_codes = []
        try:
            wl = build_watchlist(actual_date)
            wl_codes = [item["code"] for item in wl.get("items", [])]
        except Exception:
            pass
        universe_codes = sorted(list(set(wl_codes + TW50_COMPONENTS)))

        # 4. 取得近 6 日交易日以算 5 日流向與慣性
        trading_dates = get_recent_trading_days(actual_date, n=6)
        if len(trading_dates) < 2:
            raise HTTPException(status_code=502, detail="交易日不足，無法計算資金潮汐")

        stocks_data = []
        errors = []

        for code in universe_codes:
            try:
                name = finmind_client.get_stock_name(code)
                sector = get_sector_by_code(code)

                # 三大法人 chips (最後 5 天)
                inst_df, _ = cache.get_timeseries(
                    "chips_inst", code, trading_dates[1], trading_dates[-1],
                    finmind_client.fetch_institutional
                )
                flow_raw = 0.0
                if not inst_df.empty:
                    sub_inst = inst_df[inst_df["date"].isin(trading_dates[1:])]
                    if not sub_inst.empty:
                        flow_raw = float((sub_inst["foreign_net"] + sub_inst["trust_net"] + sub_inst["dealer_net"]).sum() / 1000.0)

                # OHLCV_adj 還原價 (6 天)
                ohlcv_df, _ = cache.get_timeseries(
                    "ohlcv_adj", code, trading_dates[0], trading_dates[-1],
                    yfinance_client.fetch_stock_ohlcv
                )
                
                momentum_raw = 0.0
                size_raw = 10000.0 # 預設

                if not ohlcv_df.empty:
                    sub_ohlcv = ohlcv_df[ohlcv_df["date"].isin(trading_dates)].sort_values("date")
                    if len(sub_ohlcv) >= 6:
                        close_t = float(sub_ohlcv.iloc[-1]["close"])
                        close_t_5 = float(sub_ohlcv.iloc[0]["close"])
                        if close_t_5 > 0:
                            momentum_raw = (close_t / close_t_5 - 1) * 100 / 5.0
                    elif len(sub_ohlcv) >= 2:
                        close_t = float(sub_ohlcv.iloc[-1]["close"])
                        close_t_5 = float(sub_ohlcv.iloc[0]["close"])
                        days_diff = len(sub_ohlcv) - 1
                        if close_t_5 > 0 and days_diff > 0:
                            momentum_raw = (close_t / close_t_5 - 1) * 100 / days_diff

                    # size_raw = volume * close
                    if not sub_ohlcv.empty:
                        last_row = sub_ohlcv.iloc[-1]
                        size_raw = float(last_row["volume"] * last_row["close"])

                stocks_data.append({
                    "code": code,
                    "name": name,
                    "sector": sector,
                    "flow_raw": flow_raw,
                    "momentum_raw": round(momentum_raw, 4),
                    "size_raw": size_raw
                })
            except Exception as exc:
                errors.append(f"{code} 錯誤: {str(exc)}")
                continue

        if not stocks_data:
            raise HTTPException(status_code=502, detail="無有效個股數據可計算資金潮汐")

        # 5. 正規化與座標計算
        flows = [s["flow_raw"] for s in stocks_data]
        mean_f = sum(flows) / len(flows)
        var_f = sum((x - mean_f) ** 2 for x in flows) / len(flows)
        std_f = math.sqrt(var_f) if var_f > 0 else 0.0

        moms = [s["momentum_raw"] for s in stocks_data]
        mean_m = sum(moms) / len(moms)
        var_m = sum((x - mean_m) ** 2 for x in moms) / len(moms)
        std_m = math.sqrt(var_m) if var_m > 0 else 0.0

        # Size log-scale mapping
        sizes = [math.log10(s["size_raw"]) if s["size_raw"] > 0 else 0.0 for s in stocks_data]
        min_sz = min(sizes) if sizes else 0.0
        max_sz = max(sizes) if sizes else 1.0
        diff_sz = max_sz - min_sz if max_sz > min_sz else 1.0

        out_stocks = []
        for s, sz_val in zip(stocks_data, sizes):
            # flow_x z-score clipped to [-3, 3] mapped to [-1, 1]
            z_f = (s["flow_raw"] - mean_f) / std_f if std_f > 0 else 0.0
            flow_x = max(-1.0, min(1.0, z_f / 3.0))

            # momentum_y z-score clipped to [-3, 3] mapped to [-1, 1]
            z_m = (s["momentum_raw"] - mean_m) / std_m if std_m > 0 else 0.0
            momentum_y = max(-1.0, min(1.0, z_m / 3.0))

            # size normalized to [0.2, 1.0]
            sz = 0.2 + 0.8 * (sz_val - min_sz) / diff_sz

            # strength
            blend = 0.5 * flow_x + 0.5 * momentum_y
            strength = round((blend + 1.0) * 50.0)

            # quadrant
            if flow_x >= 0 and momentum_y >= 0:
                quad = "inflow_up"
            elif flow_x >= 0 and momentum_y < 0:
                quad = "inflow_down"
            elif flow_x < 0 and momentum_y >= 0:
                quad = "outflow_up"
            else:
                quad = "outflow_down"

            out_stocks.append({
                "code": s["code"],
                "name": s["name"],
                "sector": s["sector"],
                "flow_x": round(flow_x, 4),
                "flow_raw": round(s["flow_raw"], 2),
                "momentum_y": round(momentum_y, 4),
                "momentum_raw": round(s["momentum_raw"], 4),
                "size": round(sz, 4),
                "size_raw": s["size_raw"],
                "strength": strength,
                "quadrant": quad
            })

        result = {
            "date": actual_date,
            "window_days": 5,
            "universe": universe,
            "axes": {
                "x": { "label": "資金流向", "unit": "近5日法人淨買賣超(張)" },
                "y": { "label": "進入慣性", "unit": "近5日平均漲幅(%/日)" }
            },
            "stocks": out_stocks,
            "source": "FinMind/yfinance",
            "degraded": False,
            "errors": errors
        }

        write_capital_tide_cache(actual_date, universe, result)
        return result

    return _guard(_fetch)
