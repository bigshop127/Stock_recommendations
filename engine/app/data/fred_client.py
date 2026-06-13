"""FRED（聖路易聯準會資料庫）美國總經 client（官方 API、免費金鑰、可回測）。

註冊即免費取得 api_key：https://fred.stlouisfed.org/docs/api/api_key.html
觀測值 API：GET https://api.stlouisfed.org/fred/series/observations
            ?series_id=DGS10&api_key=KEY&file_type=json&observation_start=&observation_end=

供階段5/環境因子：利率、殖利率曲線、CPI、失業率、聯邦基金利率、VIX。
這是 MacroMicro / 財經M平方 的免費源頭，直接打官方即可，不必爬第三方圖表站。
"""
from __future__ import annotations

import pandas as pd

from app.core.config import settings
from app.data.http import DataSourceError, get_json

API = "https://api.stlouisfed.org/fred/series/observations"

# 常用 series 友善別名 → FRED series_id
SERIES = {
    "us10y": "DGS10",        # 美國 10 年期公債殖利率
    "us2y": "DGS2",          # 美國 2 年期公債殖利率
    "yield_curve": "T10Y2Y",  # 10Y-2Y 利差（衰退領先指標）
    "cpi": "CPIAUCSL",       # CPI（季調）
    "unemployment": "UNRATE",  # 失業率
    "fed_funds": "FEDFUNDS",  # 聯邦基金有效利率
    "vix": "VIXCLS",         # VIX 收盤
}


def _require_key() -> str:
    if not settings.fred_api_key:
        raise DataSourceError(
            "缺少 FRED_API_KEY。請至 https://fred.stlouisfed.org/docs/api/api_key.html "
            "免費註冊後填入 engine/.env（見 engine/.env.example）。"
        )
    return settings.fred_api_key


def resolve_series(name: str) -> str:
    """別名（us10y…）或原生 series_id（DGS10…）皆可。"""
    return SERIES.get(name.lower(), name)


def fetch_series(series_id: str, start: str, end: str) -> pd.DataFrame:
    """取單一 series 觀測值。回傳：date, value（float；FRED 缺值 '.' 會被剔除）。"""
    sid = resolve_series(series_id)
    payload = get_json(
        API,
        params={
            "series_id": sid,
            "api_key": _require_key(),
            "file_type": "json",
            "observation_start": start,
            "observation_end": end,
        },
    )
    if not isinstance(payload, dict):
        raise DataSourceError(f"FRED 非預期回應：{str(payload)[:200]}")
    if "observations" not in payload:
        raise DataSourceError(f"FRED {sid} 失敗：{payload.get('error_message') or str(payload)[:200]}")

    obs = payload["observations"]
    cols = ["date", "value"]
    if not obs:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(obs)[["date", "value"]]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")  # '.' → NaN
    df = df.dropna(subset=["value"]).reset_index(drop=True)
    df["date"] = df["date"].astype(str)
    return df
