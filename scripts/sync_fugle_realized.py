"""
sync_fugle_realized.py

Pulls realized (matched buy/sell) stock/ETF trades from the E.Sun Securities
(Fugle Trade / esun_trade SDK) account via get_transactions_by_date(), and
pushes them to review-web's cloud endpoint (POST /api/stock-realized/sync-import),
which dedupes and appends into data/stock_realized_trades.json.

Why get_transactions_by_date() and not a dedicated "realized P&L" call: the SDK
has no such endpoint. get_transactions_by_date() returns 成交明細 (fill/match
detail) rows; a row with buy_sell == "S" is a broker-matched CLOSING sale, and
already carries the broker's own realized-gain computation in `make` (net of
ALL fees/taxes on both legs) plus `cost` (the negative cost-basis outlay of the
matched buy leg, itself already inclusive of that leg's own buy commission).
Verified against several live rows: recv - abs(cost) == make exactly, and
recv is already net of this sell leg's own fee+tax (from mat_dats). So:

    buy_price  = abs(cost) / qty          (fee-inclusive cost-basis per share —
                                            NOT the raw traded buy price; the
                                            buy-side commission is baked in
                                            here rather than reported separately,
                                            because the original buy fill may
                                            fall outside the queried window)
    sell_price = price_avg                (raw, accurate)
    fee        = sum(mat_dats[].fee)       (this SELL leg's own commission only —
                                            the buy leg's commission is already
                                            absorbed into buy_price above)
    tax        = sum(mat_dats[].tax)       (this SELL leg's own transaction tax)

Plugged into review-web's stockRealizedBreakdown() formula
(net = (sell_price - buy_price) * qty - fee - tax), this reproduces the
broker's own `make` value exactly. `side` is always reported as 'long' here —
determining 融資/融券 from the API's s_type field was not reliably decodable
from a compiled SDK with no live short-sell example to check against, and per
review-web's own design note, side does not affect the money calculation, only
a display label. Correct it manually in the UI if a synced row was actually a
margin short.

Date range: the API caps a single query at ~180 days (366 days returns
AW00002). So a backfill spanning REALIZED_SYNC_SINCE..today is walked in
150-day chunks (a safety margin under the observed 180-day ceiling).

Dedup: each row gets a stable sync_ref built from the broker's own order_no(s)
in mat_dats (unique per matched fill, immune to any rounding in the derived
buy_price above), sent as `sync_ref` — the gateway route prefixes it into a
`ref` and tracks it in imported_refs so re-running this script (e.g. on a
schedule) is a cheap no-op for trades already synced. The gateway route also
has a second, fuzzy safety-net match (symbol + sell_date + qty + sell_price)
to catch the case where the SAME trade was already entered manually or via
screenshot import before this script ever ran once — see routes/stock_realized.js.

READ-ONLY against the brokerage — only get_transactions_by_date() is called.
No order placement.

Two ways to run (same script, same behaviour):
  - Oracle VM (正式路徑，electricity-independent)：
    deploy/sync_realized_vm.sh，在 amd64 容器裡跑（玉山只出 x86_64 wheel，VM 是
    ARM，靠 qemu-user-static 模擬），憑證掛載自 VM 上的 ~/.fugle，gateway 走
    --network host 的 localhost:3000。
  - 觸發：POST /api/stocks/sync-realized-trigger（review-web「已實現損益總覽」
    頁的「真實同步」按鈕），或直接在 VM 上手動跑這支腳本。
"""

import configparser
import json
import os
import sys
from datetime import datetime, timedelta

import requests

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GATEWAY_BASE = os.environ.get("REBALANCE_GATEWAY_URL", "http://localhost:3000").rstrip("/")
GATEWAY_URL = GATEWAY_BASE + "/api/stock-realized/sync-import"
KEYS_URL = "https://esuntradingapi.esunsec.com.tw/keys/"

CHUNK_DAYS = 150  # 實測 180 天可行、366 天回 AW00002，抓 150 天當安全邊際
DEFAULT_LOOKBACK_DAYS = 730  # 沒指定 REALIZED_SYNC_SINCE 時，預設回溯兩年


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def fugle_login():
    env = load_env(os.path.join(REPO_ROOT, ".env"))
    config_path = env.get("FUGLE_CONFIG_PATH") or os.environ.get("FUGLE_CONFIG_PATH")
    if not config_path or not os.path.exists(config_path):
        print(f"ERROR: FUGLE_CONFIG_PATH not set or file missing: {config_path}", file=sys.stderr)
        sys.exit(1)

    cfg = configparser.ConfigParser()
    cfg.read(config_path, encoding="utf-8")

    from esun_trade.sdk import SDK

    sdk = SDK(cfg)
    sdk.login()
    return sdk


def current_public_ip():
    try:
        return requests.get("https://checkip.amazonaws.com", timeout=5).text.strip()
    except requests.exceptions.RequestException:
        return None


def date_chunks(start, end, chunk_days):
    """[start, end] inclusive, walked forward in <=chunk_days windows."""
    out = []
    cur = start
    while cur <= end:
        nxt = min(cur + timedelta(days=chunk_days), end)
        out.append((cur, nxt))
        cur = nxt + timedelta(days=1)
    return out


def fetch_all_transactions(sdk, start, end):
    rows = []
    for a, b in date_chunks(start, end, CHUNK_DAYS):
        try:
            chunk = sdk.get_transactions_by_date(a.isoformat(), b.isoformat())
        except ValueError as e:
            if "AGA0002" in str(e):
                ip = current_public_ip()
                print(f"\nERROR: the E.Sun trading API rejected this machine's IP ({e})", file=sys.stderr)
                print(f"  current public IP : {ip or '(unknown)'}", file=sys.stderr)
                print(f"  fix               : add that IP at {KEYS_URL}", file=sys.stderr)
                sys.exit(1)
            raise
        print(f"  {a.isoformat()} ~ {b.isoformat()}: {len(chunk)} 筆原始交易紀錄", file=sys.stderr)
        rows.extend(chunk)
    return rows


def as_float(v, fb=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return fb


def to_iso_date(yyyymmdd):
    s = str(yyyymmdd or "")
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return ""


def build_realized_trades(raw_rows):
    """買賣兩腿已由玉山配對好——只挑 buy_sell == 'S' 的列（收盤賣出腿，
    帶有已結算的 make/cost），其餘（'B' 開倉腿、'' 零股調整列）略過。"""
    out = []
    skipped = 0
    for row in raw_rows:
        if row.get("buy_sell") != "S":
            continue
        symbol = str(row.get("stk_no") or "").strip()
        qty = as_float(row.get("qty"))
        sell_price = as_float(row.get("price_avg"))
        cost = as_float(row.get("cost"))
        sell_date = to_iso_date(row.get("t_date"))
        if not symbol or qty <= 0 or sell_price <= 0 or not sell_date:
            skipped += 1
            continue

        mat_dats = row.get("mat_dats") or []
        fee = sum(as_float(m.get("fee")) for m in mat_dats)
        tax = sum(as_float(m.get("tax")) for m in mat_dats)
        order_nos = sorted({str(m.get("order_no")) for m in mat_dats if m.get("order_no")})
        sync_ref = f"{symbol}_{'-'.join(order_nos) if order_nos else sell_date + '_' + str(int(qty))}"

        out.append({
            "symbol": symbol,
            "name": str(row.get("stk_na") or "").strip() or symbol,
            "side": "long",
            "qty": int(qty),
            "buy_price": round(abs(cost) / qty, 4) if qty else 0,
            "sell_price": sell_price,
            "sell_date": sell_date,
            "fee": round(fee, 2),
            "tax": round(tax, 2),
            "note": "玉山 API 真實同步",
            "sync_ref": sync_ref,
        })
    if skipped:
        print(f"  略過 {skipped} 筆不完整/零股調整列", file=sys.stderr)
    return out


def main():
    since_str = os.environ.get("REALIZED_SYNC_SINCE", "").strip()
    end = datetime.now().date()
    if since_str:
        try:
            start = datetime.strptime(since_str, "%Y-%m-%d").date()
        except ValueError:
            print(f"ERROR: REALIZED_SYNC_SINCE 格式錯誤（要 YYYY-MM-DD）: {since_str}", file=sys.stderr)
            sys.exit(1)
    else:
        start = end - timedelta(days=DEFAULT_LOOKBACK_DAYS)

    print(f"Logging into Fugle Trade (E.Sun)... 查詢範圍 {start} ~ {end}")
    sdk = fugle_login()
    print("Login OK. Fetching transactions...")

    raw_rows = fetch_all_transactions(sdk, start, end)
    trades = build_realized_trades(raw_rows)
    print(f"\n共 {len(raw_rows)} 筆原始交易紀錄，其中 {len(trades)} 筆是已實現賣出交易。")

    if not trades:
        print("沒有可同步的已實現交易，結束。")
        print("SYNC_RESULT:" + json.dumps({"added": 0, "skipped_already": 0, "skipped_duplicate": 0, "total_incoming": 0}))
        return

    print("\nPushing to review-web...")
    resp = requests.post(GATEWAY_URL, json={"trades": trades}, timeout=30)
    resp.raise_for_status()
    result = resp.json()
    print(f"OK. 新增 {result.get('added')} 筆、已同步過跳過 {result.get('skipped_already')} 筆、"
          f"偵測到重複（人工/截圖已輸入過）跳過 {result.get('skipped_duplicate')} 筆。")
    print("SYNC_RESULT:" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
