#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# refresh.sh — 盤後「無 LLM」數據/訊號刷新（階段8 §D，第一層必達）。cron 週一~五盤後跑。
#   1) git pull --rebase：取本機老王(B2)/手機 的最新 reports/
#   2) 打 gateway 端點暖快取（dashboard/watchlist；engine 會抓並快取 FinMind/yfinance）
#   3) 把當日「量化訊號快照」(/api/dashboard) 存成 reports/signals/<date>.json（無 LLM、git 追蹤）
#   4) 有變更才 commit & push（手機可離線讀當日訊號）
#   5) 任何步驟失敗 → Telegram 告警（沿用根 .env 的 TELEGRAM_*）
# 不呼叫 /api/agents/decide（那很貴、需 LLM；維持前端按鈕觸發）。
# ──────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3000}"
DATE="$(date +%F)"                       # 系統 TZ 已由 bootstrap 設為 Asia/Taipei
SNAP_DIR="$APP_DIR/reports/signals"
SNAP_PATH="$SNAP_DIR/$DATE.json"
cd "$APP_DIR" || exit 1

# 推送目標一律用「目前 checkout 的分支」，不再硬寫 master。
# （VM 被切到 phase3-chips 時，硬寫 master 會把 master rebase 進來造成分叉、push 被拒。）
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"

envval() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''\r'; }
TG_TOKEN="$(envval TELEGRAM_BOT_TOKEN)"; TG_CHAT="$(envval TELEGRAM_CHAT_ID)"
alert() {
  echo "[refresh][ALERT] $1"
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] && \
    curl -s -m 10 "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
      --data-urlencode "chat_id=$TG_CHAT" \
      --data-urlencode "text=⚠️ VM 盤後刷新失敗（$DATE）：$1" >/dev/null || true
}
ok() { echo "[refresh] $(date '+%F %T') $1"; }

ok "start date=$DATE gateway=$GATEWAY_URL"

# 1) 先同步 repo（避免與本機/手機分岔）
git pull --rebase --autostash origin "$BRANCH" 2>&1 | tail -2 || alert "git pull --rebase 失敗（稍後 push 可能衝突）"

# 2) 暖快取 + 3) 存當日訊號快照
mkdir -p "$SNAP_DIR"
if curl -s --fail -m 120 "$GATEWAY_URL/api/dashboard" -o "$SNAP_PATH.tmp"; then
  mv "$SNAP_PATH.tmp" "$SNAP_PATH"
  ok "dashboard 快照寫入 reports/signals/$DATE.json ($(wc -c < "$SNAP_PATH") bytes)"
else
  rm -f "$SNAP_PATH.tmp"
  alert "/api/dashboard 取用失敗（engine/gateway 異常？）"
  exit 1
fi
curl -s --fail -m 120 "$GATEWAY_URL/api/watchlist" -o /dev/null && ok "watchlist 暖快取 OK" || ok "watchlist 暖快取略過"

# 4) 有變更才 commit & push
git add reports/signals/ 2>/dev/null
if git diff --cached --quiet; then
  ok "無新增/變更，免 push"
else
  git -c user.name="puhui-vm" -c user.email="puhui-vm@local" commit -m "signals: $DATE (vm refresh)" >/dev/null 2>&1
  if git push 2>&1 | tail -2; then
    ok "已 push reports/signals/$DATE.json"
  else
    ok "push 第一次失敗，rebase 後重試"
    git pull --rebase --autostash origin "$BRANCH" >/dev/null 2>&1 && git push 2>&1 | tail -2 || alert "git push 失敗（檢查 deploy key/PAT）"
  fi
fi
ok "done"
