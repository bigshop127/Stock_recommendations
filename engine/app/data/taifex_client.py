"""TAIFEX 期交所 期貨/選擇權數據 client（官方、免費、可回測）。

官方每日公布、可下載 CSV（Big5），是 regime gate（階段3）的領先指標：
- 三大法人期貨未平倉淨額（外資/投信/自營）→ 大盤多空傾向
- Put/Call Ratio（成交量比、未平倉比）→ 選擇權市場情緒

下載端點（POST 表單回 CSV）：
- 三大法人區分各期貨契約：https://www.taifex.com.tw/cht/3/futContractsDateDown
- P/C Ratio：                https://www.taifex.com.tw/cht/3/pcRatioDown

⚠️ 注意：欄位名/版面期交所偶有調整，本 client 以容錯方式抓取關鍵欄位；
   首次盤後實測需用 engine/scripts/smoke_2330.py 第 6 段校正（見 docs/data-layer.md）。
   日期參數格式為 yyyy/MM/dd。
"""
from __future__ import annotations

import io

import pandas as pd

from app.data.http import DataSourceError, post_text

FUT_CONTRACTS_DOWN = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
PCRATIO_DOWN = "https://www.taifex.com.tw/cht/3/pcRatioDown"

_FORM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) financeapp-engine/2",
    "Referer": "https://www.taifex.com.tw/cht/3/futContractsDate",
    "Content-Type": "application/x-www-form-urlencoded",
}


def _ymd(d: str) -> str:
    """'YYYY-MM-DD' → 'YYYY/MM/DD'（TAIFEX 表單格式）。"""
    return d.replace("-", "/")


def _read_csv(text: str) -> pd.DataFrame:
    if not text or not text.strip():
        return pd.DataFrame()
    head = text.lstrip()[:60]
    if head.startswith("<") or "DOCTYPE" in head.upper():
        raise DataSourceError("TAIFEX 回傳 HTML（多為契約代號錯誤或查詢被拒），非 CSV。")
    try:
        # index_col=False：TAIFEX 資料列常有尾端逗號，避免 pandas 誤把首欄當索引而整體位移。
        df = pd.read_csv(io.StringIO(text), index_col=False)
    except Exception as exc:
        raise DataSourceError(f"TAIFEX CSV 解析失敗：{exc}") from exc
    df.columns = [str(c).strip() for c in df.columns]
    return df


def _pick(df: pd.DataFrame, *candidates: str) -> str | None:
    """在欄位名中找第一個包含任一關鍵字的欄（容忍期交所欄名微調）。"""
    for col in df.columns:
        for kw in candidates:
            if kw in col:
                return col
    return None


def _to_num(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype(str).str.replace(",", "", regex=False).str.strip(),
        errors="coerce",
    )


# 臺股期貨契約代號（TAIFEX 用 TXF；容忍常見別名 TX/TAIEX）
_PRODUCT_ALIAS = {"TX": "TXF", "TAIEX": "TXF"}


# ── 三大法人期貨未平倉淨額 → regime ─────────────────────────────────────────
def fetch_institutional_futures(code: str, start: str, end: str, product: str = "TXF") -> pd.DataFrame:
    """三大法人在指定期貨契約（預設臺股期貨 TXF）的未平倉淨口數。

    回傳：date, foreign_oi_net, trust_oi_net, dealer_oi_net（多空未平倉口數淨額）。
    `code` 參數為 cache.get_timeseries 介面所需，實際以 `product` 篩選契約。
    """
    commodity = _PRODUCT_ALIAS.get(product.upper(), product)
    text = post_text(
        FUT_CONTRACTS_DOWN,
        data={"queryStartDate": _ymd(start), "queryEndDate": _ymd(end), "commodityId": commodity},
        headers=_FORM_HEADERS,
        encoding="big5",
    )
    df = _read_csv(text)
    cols = ["date", "foreign_oi_net", "trust_oi_net", "dealer_oi_net"]
    if df.empty:
        return pd.DataFrame(columns=cols)

    c_date = _pick(df, "日期")
    c_who = _pick(df, "身份別", "身分別")
    # 多空未平倉口數淨額（非「交易」淨額）
    c_net = _pick(df, "未平倉口數淨額", "未平倉餘額淨額") or _pick(df, "未平倉口數")
    if not (c_date and c_who and c_net):
        raise DataSourceError(f"TAIFEX 期貨 CSV 欄位非預期：{list(df.columns)[:12]}")

    df = df.copy()
    df["_date"] = df[c_date].astype(str).str.strip().str.replace("/", "-", regex=False)
    df["_who"] = df[c_who].astype(str).str.strip()
    df["_net"] = _to_num(df[c_net])

    who_map = {"外資": "foreign_oi_net", "外資及陸資": "foreign_oi_net",
               "投信": "trust_oi_net", "自營商": "dealer_oi_net", "自營": "dealer_oi_net"}
    df["_key"] = df["_who"].map(lambda w: next((v for k, v in who_map.items() if k in w), None))
    df = df.dropna(subset=["_key"])

    out = (
        df.pivot_table(index="_date", columns="_key", values="_net", aggfunc="sum")
        .reset_index()
        .rename(columns={"_date": "date"})
    )
    for c in cols:
        if c not in out.columns:
            out[c] = pd.NA
    return out[cols].sort_values("date").reset_index(drop=True)


# ── Put/Call Ratio → 選擇權情緒 ─────────────────────────────────────────────
def fetch_pc_ratio(code: str, start: str, end: str) -> pd.DataFrame:
    """台指選擇權 Put/Call Ratio。回傳：date, pc_volume_ratio, pc_oi_ratio。"""
    text = post_text(
        PCRATIO_DOWN,
        data={"queryStartDate": _ymd(start), "queryEndDate": _ymd(end)},
        headers=_FORM_HEADERS,
        encoding="big5",
    )
    df = _read_csv(text)
    cols = ["date", "pc_volume_ratio", "pc_oi_ratio"]
    if df.empty:
        return pd.DataFrame(columns=cols)

    c_date = _pick(df, "日期")
    c_vol = _pick(df, "成交量比率", "買賣權成交量比率")
    c_oi = _pick(df, "未平倉量比率", "買賣權未平倉量比率")
    if not c_date:
        raise DataSourceError(f"TAIFEX P/C CSV 欄位非預期：{list(df.columns)[:12]}")

    out = pd.DataFrame({"date": df[c_date].astype(str).str.strip().str.replace("/", "-", regex=False)})
    out["pc_volume_ratio"] = _to_num(df[c_vol]) if c_vol else pd.NA
    out["pc_oi_ratio"] = _to_num(df[c_oi]) if c_oi else pd.NA
    return out[cols].sort_values("date").reset_index(drop=True)
