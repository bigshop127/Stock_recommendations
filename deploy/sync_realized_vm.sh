#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# sync_realized_vm.sh — 在 Oracle VM 上跑「玉山證券個股/ETF 已實現損益同步」（opt37）。
#
# 跟 sync_holdings_vm.sh 共用同一個 docker image（同一份 esun_trade SDK 環境、
# 同一套 amd64+qemu 理由、同一份憑證），只是換一支腳本、換一個環境變數
# （REALIZED_SYNC_SINCE，可選——不給就用腳本預設的往回 730 天）。
#
# READ-ONLY：腳本只呼叫 get_transactions_by_date，不會下單。
#
# 用法：
#   deploy/sync_realized_vm.sh                              # 預設回溯 730 天
#   REALIZED_SYNC_SINCE=2024-01-01 deploy/sync_realized_vm.sh  # 指定回溯起點
#   由 gateway 的 POST /api/stocks/sync-realized-trigger 觸發（網頁「真實同步」按鈕）
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRED_DIR="${FUGLE_CRED_DIR:-/home/ubuntu/.fugle}"
KEYRING_DIR="${FUGLE_KEYRING_DIR:-/home/ubuntu/.fugle-keyring}"
IMAGE="${FUGLE_SYNC_IMAGE:-fugle-sync:2.2.0}"

for f in "$CRED_DIR/config.ini" "$CRED_DIR/keyring.env"; do
  if [ ! -r "$f" ]; then
    echo "ERROR: 缺少憑證檔 $f —— 同步無法進行。" >&2
    exit 1
  fi
done

EXTRA_ENV=()
if [ -n "${REALIZED_SYNC_SINCE:-}" ]; then
  EXTRA_ENV=(-e "REALIZED_SYNC_SINCE=${REALIZED_SYNC_SINCE}")
fi

exec docker run --rm \
  --platform linux/amd64 \
  --network host \
  -v "$CRED_DIR":/creds:ro \
  -v "$KEYRING_DIR":/root/.local/share/python_keyring \
  -v "$APP_DIR/scripts":/app:ro \
  --env-file "$CRED_DIR/keyring.env" \
  -e FUGLE_CONFIG_PATH=/creds/config.ini \
  -e REBALANCE_GATEWAY_URL=http://localhost:3000 \
  "${EXTRA_ENV[@]}" \
  "$IMAGE" \
  python /app/sync_fugle_realized.py
