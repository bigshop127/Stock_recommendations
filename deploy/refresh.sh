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

# 「同日雙生報告」衝突自救（2026-07-08 事故：pull --rebase 撞到 VM/本機備援同日都產報告的
# AA 衝突時，原本只 alert 就放著，repo 卡在 rebase 中間到人工發現才修）。
# 回傳：0=沒卡住或已自動解掉（呼叫端不必再 alert）／1=卡住但無法安全自動解，已在此函式內 alert 過。
# 2=沒卡在 rebase（pull 失敗是別的原因，例如網路），呼叫端仍應照舊 alert。
resolve_reports_conflict() {
  if [ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ]; then
    return 2
  fi
  local conflicts non_reports
  conflicts="$(git diff --name-only --diff-filter=U)"
  non_reports="$(echo "$conflicts" | grep -v '^reports/' || true)"
  if [ -z "$conflicts" ] || [ -n "$non_reports" ]; then
    alert "rebase 卡住且衝突超出 reports/ 範圍（$conflicts），已 abort 回復乾淨狀態，需人工檢查"
    git rebase --abort
    return 1
  fi
  ok "偵測到 reports/ 範圍內同日雙生報告衝突，VM 為 production，自動取 VM 版本並繼續：$conflicts"
  echo "$conflicts" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    git checkout --theirs -- "$f"
    git add "$f"
  done
  if GIT_EDITOR=true git rebase --continue >/dev/null 2>&1; then
    ok "衝突已自動解決，rebase 完成"
    return 0
  else
    alert "rebase --continue 仍失敗，已 abort 回復乾淨狀態，需人工檢查"
    git rebase --abort
    return 1
  fi
}

ok "start date=$DATE gateway=$GATEWAY_URL"

# 1) 先同步 repo（避免與本機/手機分岔）
if ! git pull --rebase --autostash origin "$BRANCH" 2>&1 | tail -5; then
  resolve_reports_conflict
  [ $? -eq 2 ] && alert "git pull --rebase 失敗（稍後 push 可能衝突）"
fi

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
    if git pull --rebase --autostash origin "$BRANCH" >/dev/null 2>&1; then
      git push 2>&1 | tail -2 || alert "git push 失敗（檢查 deploy key/PAT）"
    else
      resolve_reports_conflict; rc=$?
      if [ $rc -eq 0 ]; then
        git push 2>&1 | tail -2 || alert "git push 失敗（檢查 deploy key/PAT）"
      elif [ $rc -eq 2 ]; then
        alert "git push 失敗（rebase 失敗，檢查 deploy key/PAT）"
      fi
      # rc=1：已在 resolve_reports_conflict 內 alert 過且 abort 回復乾淨狀態，這裡不再重複 push/alert
    fi
  fi
fi
ok "done"
