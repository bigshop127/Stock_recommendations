"""FinMind 數據源 client（回測主力，免費／需 token）。

REST v4：GET https://api.finmindtrade.com/api/v4/data
回傳 {"msg","status","data":[...]}。金鑰走 settings.finmind_token（engine/.env）。

提供的 fetch_* 皆為 cache.get_timeseries 用的 FetchFn：(code, start, end) -> 乾淨 DataFrame。
對應 scoring-model.md：OHLCV→F_technical；法人/融資券→F_chips。
"""
from __future__ import annotations

import pandas as pd

from app.core.config import settings
from app.data.http import DataSourceError, get_json

API_URL = "https://api.finmindtrade.com/api/v4/data"

# 三大法人 name 欄位 → 中文分類聚合
_FOREIGN = {"Foreign_Investor", "Foreign_Dealer_Self"}
_TRUST = {"Investment_Trust"}
_DEALER = {"Dealer_self", "Dealer_Hedging"}


def _require_token() -> str:
    if not settings.finmind_token:
        raise DataSourceError(
            "缺少 FINMIND_TOKEN。請在 engine/.env 填入 FinMind token（見 engine/.env.example）。"
        )
    return settings.finmind_token


def _finmind_get(dataset: str, data_id: str, start: str, end: str) -> pd.DataFrame:
    params = {
        "dataset": dataset,
        "data_id": data_id,
        "start_date": start,
        "end_date": end,
        "token": _require_token(),
    }
    payload = get_json(API_URL, params=params)
    if not isinstance(payload, dict):
        raise DataSourceError(f"FinMind 非預期回應：{str(payload)[:200]}")
    if payload.get("status") != 200:
        raise DataSourceError(f"FinMind {dataset} 失敗：{payload.get('msg')}")
    data = payload.get("data") or []
    return pd.DataFrame(data)


# ── OHLCV（日 K）→ F_technical ──────────────────────────────────────────────
def fetch_ohlcv(code: str, start: str, end: str) -> pd.DataFrame:
    """日 K：date, open, high, low, close, volume(股), turnover(元)。"""
    raw = _finmind_get("TaiwanStockPrice", code, start, end)
    if raw.empty:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume", "turnover"])
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "open": raw["open"].astype(float),
            "high": raw["max"].astype(float),
            "low": raw["min"].astype(float),
            "close": raw["close"].astype(float),
            "volume": raw["Trading_Volume"].astype("int64"),
            "turnover": raw["Trading_money"].astype(float),
        }
    )
    return out.sort_values("date").reset_index(drop=True)


# ── 三大法人買賣超 → F_chips ─────────────────────────────────────────────────
def fetch_institutional(code: str, start: str, end: str) -> pd.DataFrame:
    """三大法人淨買超（股）：date, foreign_net, trust_net, dealer_net。"""
    raw = _finmind_get("TaiwanStockInstitutionalInvestorsBuySell", code, start, end)
    cols = ["date", "foreign_net", "trust_net", "dealer_net"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
    raw["net"] = raw["buy"].astype(float) - raw["sell"].astype(float)

    def _agg(names: set[str]) -> pd.Series:
        sub = raw[raw["name"].isin(names)]
        return sub.groupby("date")["net"].sum()

    foreign = _agg(_FOREIGN)
    trust = _agg(_TRUST)
    dealer = _agg(_DEALER)
    out = pd.DataFrame({"foreign_net": foreign, "trust_net": trust, "dealer_net": dealer}).fillna(0.0)
    out = out.reset_index().rename(columns={"index": "date"})
    out["date"] = out["date"].astype(str)
    return out.sort_values("date").reset_index(drop=True)[cols]


# ── 融資融券餘額 → F_chips ───────────────────────────────────────────────────
def fetch_margin(code: str, start: str, end: str) -> pd.DataFrame:
    """融資券：date, margin_balance, margin_change, short_balance, short_change（單位：張）。"""
    raw = _finmind_get("TaiwanStockMarginPurchaseShortSale", code, start, end)
    cols = ["date", "margin_balance", "margin_change", "short_balance", "short_change"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
    mt = raw["MarginPurchaseTodayBalance"].astype(float)
    my = raw["MarginPurchaseYesterdayBalance"].astype(float)
    st = raw["ShortSaleTodayBalance"].astype(float)
    sy = raw["ShortSaleYesterdayBalance"].astype(float)
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "margin_balance": mt,
            "margin_change": mt - my,
            "short_balance": st,
            "short_change": st - sy,
        }
    )
    return out.sort_values("date").reset_index(drop=True)


# ── 外資持股比率 → F_chips ───────────────────────────────────────────────────
def fetch_shareholding(code: str, start: str, end: str) -> pd.DataFrame:
    """外資持股比率：date, foreign_holding_ratio。"""
    raw = _finmind_get("TaiwanStockShareholding", code, start, end)
    cols = ["date", "foreign_holding_ratio"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
    if "ForeignInvestmentSharesRatio" not in raw.columns:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "foreign_holding_ratio": pd.to_numeric(raw["ForeignInvestmentSharesRatio"], errors="coerce"),
        }
    )
    return out.sort_values("date").reset_index(drop=True)


# ── 個股估值（PER/PBR/殖利率，日頻）→ Phase 4 ──────────────────────────────────
def fetch_valuation(code: str, start: str, end: str) -> pd.DataFrame:
    """個股估值：date, pe_ratio, pb_ratio, dividend_yield。"""
    raw = _finmind_get("TaiwanStockPER", code, start, end)
    cols = ["date", "pe_ratio", "pb_ratio", "dividend_yield"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "pe_ratio": pd.to_numeric(raw["PER"], errors="coerce"),
            "pb_ratio": pd.to_numeric(raw["PBR"], errors="coerce"),
            "dividend_yield": pd.to_numeric(raw["dividend_yield"], errors="coerce"),
        }
    )
    return out[cols].sort_values("date").reset_index(drop=True)


# ── 月營收（YoY/MoM 計算移至 service，此處只抓 raw 資料）→ Phase 4 ───────────────
def fetch_month_revenue(code: str, start: str, end: str) -> pd.DataFrame:
    """月營收：date, revenue。"""
    raw = _finmind_get("TaiwanStockMonthRevenue", code, start, end)
    cols = ["date", "revenue"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
        
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "revenue": pd.to_numeric(raw["revenue"], errors="coerce"),
        }
    )
    return out[cols].sort_values("date").reset_index(drop=True)


# ── 獲利能力（EPS / 三率，季頻）→ Phase 4 ──────────────────────────────────────
def fetch_financials(code: str, start: str, end: str) -> pd.DataFrame:
    """獲利能力 (季頻)：date, eps, gross_margin, operating_margin, net_margin。"""
    raw = _finmind_get("TaiwanStockFinancialStatements", code, start, end)
    cols = ["date", "eps", "gross_margin", "operating_margin", "net_margin"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
        
    df_pivot = raw.pivot_table(index="date", columns="type", values="value", aggfunc="first").reset_index()
    
    eps_col = "EPS" if "EPS" in df_pivot.columns else None
    rev_col = "Revenue" if "Revenue" in df_pivot.columns else None
    gross_col = "GrossProfit" if "GrossProfit" in df_pivot.columns else None
    op_col = "OperatingIncome" if "OperatingIncome" in df_pivot.columns else None
    net_col = "IncomeAfterTaxes" if "IncomeAfterTaxes" in df_pivot.columns else None
    
    out = pd.DataFrame()
    out["date"] = df_pivot["date"].astype(str)
    
    if eps_col:
        out["eps"] = pd.to_numeric(df_pivot[eps_col], errors="coerce")
    else:
        out["eps"] = None
        
    if rev_col and gross_col:
        out["gross_margin"] = (pd.to_numeric(df_pivot[gross_col], errors="coerce") / 
                                pd.to_numeric(df_pivot[rev_col], errors="coerce") * 100).round(2)
    else:
        out["gross_margin"] = None
        
    if rev_col and op_col:
        out["operating_margin"] = (pd.to_numeric(df_pivot[op_col], errors="coerce") / 
                                    pd.to_numeric(df_pivot[rev_col], errors="coerce") * 100).round(2)
    else:
        out["operating_margin"] = None
        
    if rev_col and net_col:
        out["net_margin"] = (pd.to_numeric(df_pivot[net_col], errors="coerce") / 
                              pd.to_numeric(df_pivot[rev_col], errors="coerce") * 100).round(2)
    else:
        out["net_margin"] = None
        
    return out[cols].sort_values("date").reset_index(drop=True)


# ── 股利政策（年頻）→ Phase 4 ──────────────────────────────────────────────────
def fetch_dividend(code: str, start: str, end: str) -> pd.DataFrame:
    """股利政策：date, cash_dividend, stock_dividend。"""
    raw = _finmind_get("TaiwanStockDividend", code, start, end)
    cols = ["date", "cash_dividend", "stock_dividend"]
    if raw.empty:
        return pd.DataFrame(columns=cols)
        
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "cash_dividend": pd.to_numeric(raw["CashEarningsDistribution"], errors="coerce").fillna(0.0),
            "stock_dividend": pd.to_numeric(raw["StockEarningsDistribution"], errors="coerce").fillna(0.0),
        }
    )
    return out[cols].sort_values("date").reset_index(drop=True)


# ── 發行股數（估值市值計算用，日頻）→ Phase 4 ─────────────────────────
def fetch_shares_issued(code: str, start: str, end: str) -> pd.DataFrame:
    """發行股數：date, shares。"""
    raw = _finmind_get("TaiwanStockShareholding", code, start, end)
    cols = ["date", "shares"]
    if raw.empty or "NumberOfSharesIssued" not in raw.columns:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(
        {
            "date": raw["date"].astype(str),
            "shares": pd.to_numeric(raw["NumberOfSharesIssued"], errors="coerce"),
        }
    )
    return out[cols].sort_values("date").reset_index(drop=True)




# ── 股名（補 StockSignal.name）──────────────────────────────────────────────
_name_cache: dict[str, str] = {}


def get_stock_name(code: str) -> str | None:
    """由 TaiwanStockInfo 取股名；查不到回 None。結果記憶體快取。"""
    if code in _name_cache:
        return _name_cache[code]
    try:
        raw = _finmind_get("TaiwanStockInfo", code, "2000-01-01", "2100-01-01")
    except DataSourceError:
        return None
    name = None
    if not raw.empty and "stock_name" in raw.columns:
        name = str(raw.iloc[-1]["stock_name"])
        _name_cache[code] = name
    return name


# ── 股名 → 代號 反查（階段4 老王次要個股常只有股名）───────────────────────────
# phase4：用「同一份 TaiwanStockInfo」建 name→code 映射（記憶體快取）；
# 查不到（例：美股 美光/英特爾）→ None，由上層降級標 code=null、不硬猜。
_name_code_map: dict[str, str] | None = None


def _load_name_code_map() -> dict[str, str]:
    global _name_code_map
    if _name_code_map is not None:
        return _name_code_map
    try:
        raw = _finmind_get("TaiwanStockInfo", "", "2000-01-01", "2100-01-01")
    except DataSourceError:
        return {}
    m: dict[str, str] = {}
    if not raw.empty and {"stock_id", "stock_name"} <= set(raw.columns):
        for sid, nm in zip(raw["stock_id"].astype(str), raw["stock_name"].astype(str)):
            nm, sid = nm.strip(), sid.strip()
            # 只收一般上市櫃股票代號（4~6 碼，可帶尾字母），首見為準
            if nm and sid and nm not in m and 4 <= len(sid.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ")) <= 6:
                m[nm] = sid
    _name_code_map = m
    return m


def get_code_by_name(name: str) -> str | None:
    """股名 → 台股代號；查不到回 None。結果記憶體快取（建一次全表）。"""
    if not name:
        return None
    return _load_name_code_map().get(name.strip())
