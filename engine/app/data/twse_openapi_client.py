"""TWSE OpenAPI Client for Company Profiles (t187ap03_L).

日快取一次全市場公司基本資料。
"""
from __future__ import annotations

import datetime
from typing import Any
from app.data import finmind_client
from app.data.http import get_json

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) financeapp-engine/2",
}

_TWSE_LISTED_PROFILE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"

_INDUSTRY_MAP = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維",
    "05": "電機機械", "06": "電器電纜", "07": "化學工業", "08": "生技醫療業",
    "09": "玻璃陶瓷", "10": "造紙工業", "11": "鋼鐵工業", "12": "橡膠工業",
    "13": "汽車工業", "14": "建材營造", "15": "航運業", "16": "觀光餐旅",
    "17": "金融保險", "18": "貿易百貨", "19": "綜合", "20": "其他",
    "21": "化學工業", "22": "生技醫療業", "23": "油電燃氣業", "24": "半導體業",
    "25": "電腦及週邊設備業", "26": "光電業", "27": "通信網路業", "28": "電子零組件業",
    "29": "電子通路業", "30": "資訊服務業", "31": "其他電子業", "32": "文化創意業",
    "33": "農業科技業", "34": "電商業", "35": "綠能環保", "36": "數位雲端",
    "37": "運動休閒", "38": "居家生活"
}

_profiles_cache: dict[str, dict[str, Any]] | None = None
_cache_date: str | None = None


def _fetch_all_profiles() -> dict[str, dict[str, Any]]:
    global _profiles_cache, _cache_date
    today_str = datetime.date.today().isoformat()
    if _profiles_cache is not None and _cache_date == today_str:
        return _profiles_cache

    profiles: dict[str, dict[str, Any]] = {}
    try:
        data = get_json(_TWSE_LISTED_PROFILE_URL, headers=_HEADERS)
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                code = str(item.get("公司代號") or "").strip()
                if not code:
                    continue

                website = str(item.get("網址") or "").strip()
                if website and website not in ("-", "－", "None", "null"):
                    if not (website.startswith("http://") or website.startswith("https://")):
                        website = f"https://{website}"
                else:
                    website = None

                founded_raw = str(item.get("成立日期") or "").strip()
                founded = None
                if len(founded_raw) >= 4:
                    founded = founded_raw[:4]

                capital_raw = item.get("實收資本額")
                capital = None
                if capital_raw is not None:
                    try:
                        capital = float(str(capital_raw).replace(",", "").strip())
                    except ValueError:
                        capital = None

                ind_code = str(item.get("產業別") or "").strip()
                industry = _INDUSTRY_MAP.get(ind_code) or (item.get("產業別簡稱") if "產業別簡稱" in item else None)

                chairman = str(item.get("董事長") or "").strip()
                if chairman in ("-", "－", "None", "null", ""):
                    chairman = None

                address = str(item.get("住址") or "").strip()
                if address in ("-", "－", "None", "null", ""):
                    address = None

                name = str(item.get("公司簡稱") or item.get("公司名稱") or "").strip() or None
                full_name = str(item.get("公司名稱") or "").strip() or None

                profiles[code] = {
                    "code": code,
                    "name": name,
                    "full_name": full_name,
                    "industry": industry,
                    "founded": founded,
                    "chairman": chairman,
                    "address": address,
                    "website": website,
                    "capital": capital,
                    "source": "TWSE OpenAPI t187ap03_L",
                    "as_of": today_str
                }
    except Exception as e:
        print(f"[twse_openapi_client] Warning: failed to fetch profiles from TWSE OpenAPI: {e}")

    _profiles_cache = profiles
    _cache_date = today_str
    return profiles


def fetch_company_profile(code: str) -> dict[str, Any]:
    today_str = datetime.date.today().isoformat()
    profiles = _fetch_all_profiles()
    if code in profiles:
        return profiles[code]

    finmind_name = finmind_client.get_stock_name(code)
    return {
        "code": code,
        "name": finmind_name if finmind_name != code else None,
        "full_name": None,
        "industry": None,
        "founded": None,
        "chairman": None,
        "address": None,
        "website": None,
        "capital": None,
        "source": "TWSE OpenAPI (Degraded)",
        "as_of": today_str
    }
