#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# healthcheck.sh — gateway/engine 健康檢查（階段8 §E）。cron 每 15 分鐘跑。
#   打 /api/health；engine 或 gateway 異常 → 嘗試 systemctl restart + Telegram 告警。
#   去抖動：連續失敗才告警一次（用 /tmp 狀態檔），避免每 15 分鐘洗版。
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"
STATE="/tmp/puhui_health.state"          # down 狀態記號（避免重複告警）
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

envval() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''\r'; }
TG_TOKEN="$(envval TELEGRAM_BOT_TOKEN)"; TG_CHAT="$(envval TELEGRAM_CHAT_ID)"
tg() {
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] && \
    curl -s -m 10 "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$TG_CHAT" --data-urlencode "text=$1" >/dev/null || true
}

resp="$(curl -s --fail -m 15 "$GATEWAY_URL/api/health" 2>/dev/null || true)"
# engine 旗標：health 回傳含 "engine":"up" 視為健康；gateway 無回應視為 gateway 掛
if [ -n "$resp" ] && echo "$resp" | grep -q '"engine"[: ]*"\?up'; then
  if [ -f "$STATE" ]; then tg "✅ VM 服務恢復正常（$(date '+%F %T')）"; rm -f "$STATE"; fi
  echo "[health] OK $resp"
  exit 0
fi

# 異常：嘗試重啟對應服務
echo "[health] UNHEALTHY resp='${resp:-<no-response>}' → restart"
if [ -z "$resp" ]; then
  $SUDO systemctl restart puhui-gateway puhui-engine
else
  $SUDO systemctl restart puhui-engine     # gateway 活著但 engine down
fi

if [ ! -f "$STATE" ]; then
  date > "$STATE"
  tg "⚠️ VM 健康檢查失敗（$(date '+%F %T')）：${resp:-gateway 無回應}。已嘗試 systemctl restart，請查 journalctl -u puhui-engine -u puhui-gateway。"
fi
