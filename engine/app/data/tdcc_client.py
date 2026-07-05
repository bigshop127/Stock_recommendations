"""TDCC 集保戶股權分散表官方開放資料 Client (id=1-5)."""
from __future__ import annotations

import io
from pathlib import Path
from typing import Any
import urllib.request
import pandas as pd

from app.core.config import settings

TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5"
CACHE_SUBDIR = "tdcc_shareholding"


def get_tdcc_dir() -> Path:
    d = settings.cache_path / CACHE_SUBDIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def fetch_latest_snapshot() -> pd.DataFrame:
    """從 TDCC 開放資料抓取最新一週全市場股權分散表。

    回傳標準欄位：
    ["date", "code", "HoldingSharesLevel", "people", "shares", "percent"]
    """
    cols = ["date", "code", "HoldingSharesLevel", "people", "shares", "percent"]
    try:
        req = urllib.request.Request(
            TDCC_URL,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()

        df_raw = pd.read_csv(io.BytesIO(content), encoding="utf-8-sig", dtype=str)
        if df_raw.empty or len(df_raw.columns) < 6:
            return pd.DataFrame(columns=cols)

        raw_date = str(df_raw.iloc[:, 0].values[0]).strip()
        if len(raw_date) == 8 and raw_date.isdigit():
            formatted_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        else:
            formatted_date = raw_date

        df = pd.DataFrame()
        df["date"] = [formatted_date] * len(df_raw)
        df["code"] = df_raw.iloc[:, 1].astype(str).str.strip()
        df["HoldingSharesLevel"] = pd.to_numeric(df_raw.iloc[:, 2], errors="coerce").fillna(0).astype(int)
        df["people"] = pd.to_numeric(df_raw.iloc[:, 3].astype(str).str.replace(",", ""), errors="coerce").fillna(0).astype(int)
        df["shares"] = pd.to_numeric(df_raw.iloc[:, 4].astype(str).str.replace(",", ""), errors="coerce").fillna(0).astype(int)
        df["percent"] = pd.to_numeric(df_raw.iloc[:, 5].astype(str).str.replace(",", ""), errors="coerce").fillna(0.0).astype(float)

        return df[cols]
    except Exception as exc:
        print(f"[tdcc_client] fetch_latest_snapshot error: {exc}")
        return pd.DataFrame(columns=cols)


def save_snapshot() -> str | None:
    """檢查並備份最新一週 TDCC 全市場快照至本地 parquet（冪等）。
    
    回傳：日期字串 YYYY-MM-DD 或 None。
    """
    df = fetch_latest_snapshot()
    if df.empty or "date" not in df.columns:
        return None

    date_str = str(df["date"].iloc[0]).strip()
    if not date_str:
        return None

    tdcc_dir = get_tdcc_dir()
    file_path = tdcc_dir / f"{date_str}.parquet"

    if file_path.exists():
        return date_str

    try:
        df.to_parquet(file_path, index=False)
        print(f"[tdcc_client] Saved TDCC shareholding snapshot for {date_str} to {file_path}")
        return date_str
    except Exception as exc:
        print(f"[tdcc_client] Failed to save parquet {file_path}: {exc}")
        return date_str


def load_history(code: str, weeks: int = 16) -> list[dict[str, Any]]:
    """從本地 tdcc_shareholding 讀取最近 N 週資料，並篩選指定股票 code。"""
    tdcc_dir = get_tdcc_dir()
    files = sorted(tdcc_dir.glob("*.parquet"))

    if not files:
        return []

    target_files = files[-weeks:]
    all_rows: list[dict[str, Any]] = []

    for f in target_files:
        try:
            df = pd.read_parquet(f)
            if df.empty:
                continue
            sub = df[df["code"] == code]
            if not sub.empty:
                all_rows.extend(sub.to_dict(orient="records"))
        except Exception as exc:
            print(f"[tdcc_client] load_history read error {f}: {exc}")

    return all_rows
