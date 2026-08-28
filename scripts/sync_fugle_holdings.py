"""
sync_fugle_holdings.py

Pulls real holdings (00631L / 00687B / 00953B) + cash balance from the
E.Sun Securities (Fugle Trade / esun_trade SDK) account and pushes them to
review-web's cloud holdings endpoint (POST /api/rebalance/holdings), which
already derives shares/avg_cost/cash from opening+trades server-side.

Cash is adjusted for in-flight settlements (get_settlements()): available_balance
already reflects anything settling today or earlier, so only rows with a
settlement date (c_date) strictly after today are added/subtracted — these are
T+2 amounts not yet credited (positive) or not yet deducted (negative).
get_settlements() is account-wide (no per-stock code), so it also picks up
pending settlement from any other stock traded in the same account.

READ-ONLY against the brokerage — only get_inventories()/get_balance()/
get_settlements() are called. No order placement.

Two ways to run (same script, same behaviour):
  - Oracle VM (2026-07-29 起的正式路徑，電腦關機也能同步)：
    deploy/sync_holdings_vm.sh，在 amd64 容器裡跑（玉山只出 x86_64 wheel，VM 是
    ARM，靠 qemu-user-static 模擬），憑證掛載自 VM 上的 ~/.fugle，gateway 走
    --network host 的 localhost:3000。
  - 本機 Windows（備援）：review-web/tools/sync-holdings.ps1，先開 SSH 隧道再跑，
    憑證留在本機。
"""

import configparser
import json
import os
import sys
from datetime import datetime

import requests

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# VM 上跑（deploy/sync_holdings_vm.sh，--network host）時 localhost 就是 gateway 本人；
# 本機跑時 localhost:3000 是 ssh -L 隧道的這一端。兩邊預設值相同，故只在特殊情況才需覆寫。
GATEWAY_BASE = os.environ.get("REBALANCE_GATEWAY_URL", "http://localhost:3000").rstrip("/")
GATEWAY_URL = GATEWAY_BASE + "/api/rebalance/holdings"
# Key/IP-allowlist console for this account. Must match the Core Entry host in
# config.ini (esuntradingapi = E.Sun); fugletradingapi is the parallel Fugle-
# branded console and does not hold this account's keys.
KEYS_URL = "https://esuntradingapi.esunsec.com.tw/keys/"

ETF_CODE = "00631L"
BOND_CODES = ["00687B", "00953B"]
TRACKED_CODES = {ETF_CODE, *BOND_CODES}


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


def extract_positions(inventories):
    """stk_no -> {shares, avg_cost, market_price}

    Uses cost_qty — the full quantity backing the cost basis (settled lots
    qty_l PLUS today's not-yet-settled buys qty_b, MINUS pending sells qty_s)
    — NOT qty_l. qty_l is only the settled/available lots, so on a day you buy
    it under-reports the position by exactly today's fills, and same-day
    purchases silently fail to sync until T+2. price_avg is the average over
    cost_qty (price_qty_sum / cost_qty), so it already pairs with cost_qty.
    """
    out = {}
    for item in inventories:
        code = item.get("stk_no")
        if code not in TRACKED_CODES:
            continue
        raw_qty = item.get("cost_qty")
        if raw_qty in (None, ""):
            raw_qty = item.get("qty_l", 0)
        shares = int(float(raw_qty or 0))
        avg_cost = float(item.get("price_avg", 0) or 0)
        market_price = float(item.get("price_now", 0) or item.get("price_mkt", 0) or 0)
        out[code] = {"shares": shares, "avg_cost": avg_cost, "market_price": market_price}
    return out


def extract_full_inventory(inventories):
    """Same per-item cost_qty/market_price logic as extract_positions(), but over
    EVERY code in the account instead of just TRACKED_CODES — used to price the
    "資產變化圖" net-worth snapshot's 股票/ETF 庫存市值, which needs the whole
    account, not just the 00631L/00687B/00953B rebalance strategy legs."""
    out = []
    for item in inventories:
        code = item.get("stk_no")
        if not code:
            continue
        raw_qty = item.get("cost_qty")
        if raw_qty in (None, ""):
            raw_qty = item.get("qty_l", 0)
        shares = int(float(raw_qty or 0))
        if shares <= 0:
            continue
        avg_cost = float(item.get("price_avg", 0) or 0)
        market_price = float(item.get("price_now", 0) or item.get("price_mkt", 0) or 0)
        # 沒把握 esun_trade 的 inventories 一定會給名稱欄位（沒查到官方文件列出保證有這個
        # key），純粹能拿就拿、拿不到就讓前端退回顯示代號本身，不影響市值計算。
        name = str(item.get("stock_name") or item.get("name") or "").strip()
        out.append({
            "code": code,
            "name": name,
            "shares": shares,
            "avg_cost": avg_cost,
            "market_price": market_price,
            "value": shares * market_price,
        })
    return out


def pending_settlement_adjustment(settlements, today=None):
    """Sum settlement rows whose c_date (settlement date) is strictly after
    today — those are the only ones not yet reflected in available_balance.
    Returns (adjustment_total, detail_rows_used)."""
    today_str = today or datetime.now().strftime("%Y%m%d")
    total = 0.0
    used = []
    for row in settlements:
        c_date = row.get("c_date", "")
        if c_date > today_str:
            price = float(row.get("price", 0) or 0)
            total += price
            used.append(row)
    return total, used


def current_public_ip():
    """Best-effort egress IP, purely to make the AGA0002 hint actionable.
    Returns None instead of raising — this only runs on a path that is already
    failing, and must not turn a clear error into a confusing one."""
    try:
        return requests.get("https://checkip.amazonaws.com", timeout=5).text.strip()
    except requests.exceptions.RequestException:
        return None


def fetch_account(sdk):
    """inventories + balance + settlements, with a readable failure for AGA0002.

    The trading API key is pinned to an IP allowlist (see KEYS_URL). login()
    succeeds from any IP — only the API-key-signed calls below are checked — so
    running from an unlisted IP raises a bare ValueError several lines after
    "Login OK", which reads like a bug in this script but is not one. Mobile
    hotspots / tethering get a floating CGNAT address, so this recurs whenever
    the machine is not on its usual network.
    """
    try:
        return sdk.get_inventories(), sdk.get_balance(), sdk.get_settlements()
    except ValueError as e:
        if "AGA0002" not in str(e):
            raise
        ip = current_public_ip()
        print(f"\nERROR: the E.Sun trading API rejected this machine's IP ({e})", file=sys.stderr)
        print("The trading API key is pinned to an IP allowlist and this", file=sys.stderr)
        print("machine's current public IP is not on it. Nothing is broken.", file=sys.stderr)
        print(f"  current public IP : {ip or '(could not determine - no internet?)'}", file=sys.stderr)
        print(f"  fix               : add that IP at {KEYS_URL}", file=sys.stderr)
        print("  note              : 正式路徑跑在 Oracle VM 上，公網 IP 固定為", file=sys.stderr)
        print("                      140.238.48.197，白名單加一次就不會再飄。若這裡看到", file=sys.stderr)
        print("                      的是別的 IP，代表你是從本機備援路徑跑的（家用/手機", file=sys.stderr)
        print("                      網路 IP 會變動），改回 VM 同步即可。", file=sys.stderr)
        sys.exit(1)


def get_current_holdings():
    resp = requests.get(GATEWAY_URL, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("holdings") if data.get("exists") else None


def build_settlement(adjustment, pending_rows):
    """Structured pending-settlement snapshot for the rebalance page to show
    the user what is still in-flight (money coming in on a sell, going out on a
    buy) — the same rows summed into the cash adjustment, itemised.
    receivable = sum of positive rows (incoming), payable = sum of negatives."""
    receivable = sum(
        float(r.get("price", 0) or 0) for r in pending_rows if float(r.get("price", 0) or 0) > 0
    )
    payable = sum(
        float(r.get("price", 0) or 0) for r in pending_rows if float(r.get("price", 0) or 0) < 0
    )
    return {
        "as_of": datetime.now().strftime("%Y%m%d"),
        "net": adjustment,
        "receivable": receivable,
        "payable": payable,
        "rows": [
            {
                "trade_date": r.get("date", ""),
                "settle_date": r.get("c_date", ""),
                "amount": float(r.get("price", 0) or 0),
            }
            for r in pending_rows
        ],
    }


def build_payload(positions, cash, prior, settlement=None, full_inventory=None):
    prior = prior or {}
    etf_pos = positions.get(ETF_CODE, {"shares": 0, "avg_cost": 0, "market_price": 0})

    prior_bonds = {b.get("code"): b for b in (prior.get("bonds") or [])}
    bonds_payload = []
    opening_bonds = []
    for code in BOND_CODES:
        pos = positions.get(code, {"shares": 0, "avg_cost": 0, "market_price": 0})
        prior_b = prior_bonds.get(code, {})
        price = pos["market_price"] or prior_b.get("price", 0)
        bonds_payload.append({"code": code, "price": price})
        opening_bonds.append({"code": code, "shares": pos["shares"], "avg_cost": pos["avg_cost"]})

    payload = {
        "price": etf_pos["market_price"] or prior.get("price", 0),
        "bonds": bonds_payload,
        "cash_reserve": prior.get("cash_reserve", 100000),
        "bond_split": prior.get("bond_split", 0.6),
        "target_beta": prior.get("target_beta", 1.3),
        "tolerance_mode": prior.get("tolerance_mode", "abs"),
        "threshold_pct": prior.get("threshold_pct", 10),
        "threshold_abs": prior.get("threshold_abs", 0.1),
        "etf_beta": prior.get("etf_beta", 2.0),
        "locked": prior.get("locked", {"cash": False, "bonds": {c: False for c in BOND_CODES}}),
        "opening": {
            "shares": etf_pos["shares"],
            "avg_cost": etf_pos["avg_cost"],
            "cash": cash,
            "bonds": opening_bonds,
        },
        "trades": [],
        "settlement": settlement or {},
        "full_inventory": full_inventory or {},
    }
    return payload


def main():
    print("Logging into Fugle Trade (E.Sun)...")
    sdk = fugle_login()
    print("Login OK. Fetching inventories + balance...")

    inventories, balance, settlements = fetch_account(sdk)
    positions = extract_positions(inventories)
    full_positions = extract_full_inventory(inventories)
    raw_cash = float(balance.get("available_balance", 0) or 0)
    adjustment, pending_rows = pending_settlement_adjustment(settlements)
    cash = raw_cash + adjustment

    print(f"\nAvailable balance (before settlement adjustment): {raw_cash}")
    if pending_rows:
        print("Pending settlements not yet reflected in balance:")
        for row in pending_rows:
            print(f"  trade {row.get('date')} -> settles {row.get('c_date')}: {row.get('price')}")
    else:
        print("Pending settlements not yet reflected in balance: none")
    print(f"Settlement adjustment: {adjustment:+.0f}")
    print(f"Adjusted cash (used as 'cash'): {cash}")

    print("\nReal account snapshot (tracked codes only):")
    for code in [ETF_CODE, *BOND_CODES]:
        p = positions.get(code, {"shares": 0, "avg_cost": 0, "market_price": 0})
        print(f"  {code}: shares={p['shares']}, avg_cost={p['avg_cost']}, market_price={p['market_price']}")
    print(f"  cash: {cash}")

    full_inventory_total = sum(p["value"] for p in full_positions)
    full_inventory = {
        "total_value": full_inventory_total,
        "positions": full_positions,
        "synced_at": datetime.now().isoformat(),
    }
    print(f"\nFull account inventory (all codes, for net-worth snapshot): {len(full_positions)} positions, total value {full_inventory_total:.0f}")

    print("\nFetching current review-web config (to preserve target_beta/locks/etc)...")
    try:
        prior = get_current_holdings()
    except requests.exceptions.RequestException as e:
        print(f"ERROR: could not reach {GATEWAY_URL} ({e})", file=sys.stderr)
        print("VM 上跑：確認 puhui-gateway.service 還活著（systemctl status puhui-gateway）。", file=sys.stderr)
        print("本機跑：確認 SSH 隧道有開（用 sync-holdings.ps1 會自動開）。", file=sys.stderr)
        sys.exit(1)

    settlement = build_settlement(adjustment, pending_rows)
    payload = build_payload(positions, cash, prior, settlement, full_inventory)

    print("\nPushing snapshot to review-web...")
    resp = requests.post(GATEWAY_URL, json=payload, timeout=10)
    resp.raise_for_status()
    result = resp.json()
    print(f"OK. Saved at {result.get('saved_at')}")
    h = result.get("holdings", {})
    print(f"  00631L: shares={h.get('shares')}, avg_cost={h.get('avg_cost')}")
    for b in h.get("bonds", []):
        print(f"  {b.get('code')}: shares={b.get('shares')}, avg_cost={b.get('avg_cost')}")
    print(f"  cash: {h.get('cash')}")


if __name__ == "__main__":
    main()
