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
get_settlements() are called. No order placement. Trading credentials never
leave this machine; only the resulting position snapshot (shares/avg_cost/cash)
is sent to the gateway, and only over the existing SSH tunnel (localhost:3000).

Run via review-web/tools/sync-holdings.ps1 (sets up the SSH tunnel first).
"""

import configparser
import json
import os
import sys
from datetime import datetime

import requests

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GATEWAY_URL = "http://localhost:3000/api/rebalance/holdings"

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


def get_current_holdings():
    resp = requests.get(GATEWAY_URL, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("holdings") if data.get("exists") else None


def build_payload(positions, cash, prior):
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
    }
    return payload


def main():
    print("Logging into Fugle Trade (E.Sun)...")
    sdk = fugle_login()
    print("Login OK. Fetching inventories + balance...")

    inventories = sdk.get_inventories()
    balance = sdk.get_balance()
    settlements = sdk.get_settlements()
    positions = extract_positions(inventories)
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

    print("\nFetching current review-web config (to preserve target_beta/locks/etc)...")
    try:
        prior = get_current_holdings()
    except requests.exceptions.RequestException as e:
        print(f"ERROR: could not reach {GATEWAY_URL} ({e})", file=sys.stderr)
        print("Is the SSH tunnel to the VM open? Run via sync-holdings.ps1.", file=sys.stderr)
        sys.exit(1)

    payload = build_payload(positions, cash, prior)

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
