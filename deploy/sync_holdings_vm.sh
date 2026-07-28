#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# sync_holdings_vm.sh — 在 Oracle VM 上跑「玉山證券真實持倉同步」（2026-07-29 起的正式路徑）。
#
# 為什麼要包一層 docker：
#   玉山的 esun_trade SDK 只出 win_amd64 / macOS / manylinux **x86_64** 的 wheel，
#   沒有 linux-aarch64 版；這台 VM 是 ARM（Ampere）。所以裝 qemu-user-static 註冊
#   binfmt 後，用 --platform linux/amd64 跑 x86_64 容器來執行 SDK。一天叫幾次的
#   REST 查詢，模擬的速度損失無感。
#
# 憑證放哪：
#   /home/ubuntu/.fugle/{config.ini,*.p12,keyring.env}（chmod 600，只有 ubuntu 讀得到），
#   以唯讀掛載進容器的 /creds。帳號密碼與憑證密碼存在 cryptfile keyring
#   （/home/ubuntu/.fugle-keyring），用 keyring.env 裡的隨機密碼加密。
#
# READ-ONLY：腳本只呼叫 get_inventories/get_balance/get_settlements，不會下單。
#
# 用法：
#   deploy/sync_holdings_vm.sh          # 直接跑
#   由 gateway 的 POST /api/rebalance/sync-holdings-trigger 觸發（網頁「真實同步」按鈕）
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CRED_DIR="${FUGLE_CRED_DIR:-/home/ubuntu/.fugle}"
KEYRING_DIR="${FUGLE_KEYRING_DIR:-/home/ubuntu/.fugle-keyring}"
IMAGE="${FUGLE_SYNC_IMAGE:-fugle-sync:2.2.0}"

for f in "$CRED_DIR/config.ini" "$CRED_DIR/keyring.env"; do
  if [ ! -r "$f" ]; then
    echo "ERROR: 缺少憑證檔 $f —— 同步無法進行。" >&2
    echo "（2026-07-22 曾因 config.ini 被 Downloads 清理刪掉而失敗；現在檔案在 VM 上，" >&2
    echo "  不會再被本機清理程式碰到。真的不見的話重跑 scratchpad/push_creds.py。）" >&2
    exit 1
  fi
done

exec docker run --rm \
  --platform linux/amd64 \
  --network host \
  -v "$CRED_DIR":/creds:ro \
  -v "$KEYRING_DIR":/root/.local/share/python_keyring \
  -v "$APP_DIR/scripts":/app:ro \
  --env-file "$CRED_DIR/keyring.env" \
  -e FUGLE_CONFIG_PATH=/creds/config.ini \
  -e REBALANCE_GATEWAY_URL=http://localhost:3000 \
  "$IMAGE" \
  python /app/sync_fugle_holdings.py
