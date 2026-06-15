#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# bootstrap.sh — Oracle Cloud ARM VM 一鍵部署（階段8）。冪等，可重複執行。
#
# 在 VM 上（已 git clone 本 repo 後）執行：
#     cd <repo>/deploy && chmod +x *.sh && sudo ./bootstrap.sh
#
# 做的事：裝 Node20/Python venv/系統相依 → pip/npm 安裝 → build 前端 →
#         安裝 systemd（engine+gateway，開機自啟/crash 自重啟）→ 裝 cron → 設時區。
# 不做的事：不建立任何祕密（engine/.env、根 .env 需你 scp 上來）；不搶 VM（那在 Windows 跑）。
# 詳見 docs/runbook.md。
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 參數（可用環境變數覆寫）────────────────────────────────
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$(id -un)}}"
INSTALL_PLAYWRIGHT="${INSTALL_PLAYWRIGHT:-1}"   # 0=跳過 chromium（若不在 VM 跑老王 B1 可省）
NODE_MAJOR="${NODE_MAJOR:-20}"
TZ_NAME="${TZ_NAME:-Asia/Taipei}"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }

log "APP_DIR=$APP_DIR  RUN_USER=$RUN_USER  TZ=$TZ_NAME  playwright=$INSTALL_PLAYWRIGHT"
[ -f "$APP_DIR/server.cjs" ] || { echo "找不到 server.cjs，APP_DIR 不對？"; exit 1; }

# ── 套件管理員偵測 ─────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else echo "不支援的發行版（無 apt/dnf/yum）"; exit 1; fi
log "套件管理員：$PM"

# ── 系統相依 ───────────────────────────────────────────────
log "安裝系統相依（git/curl/python venv/編譯工具）"
if [ "$PM" = apt ]; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y git curl ca-certificates python3 python3-venv python3-pip build-essential
else
  $SUDO "$PM" install -y git curl ca-certificates python3 python3-pip gcc gcc-c++ make || true
  # Oracle Linux 的 venv 內建在 python3；若缺 ensurepip 再補
fi

# ── 時區 ───────────────────────────────────────────────────
log "設定時區 $TZ_NAME（cron 觸發時間以此為準）"
$SUDO timedatectl set-timezone "$TZ_NAME" 2>/dev/null || warn "timedatectl 設定失敗（容器環境？）可手動設定"

# ── Node.js ────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  cur=$(node -v | sed -E 's/v([0-9]+).*/\1/')
  [ "$cur" -ge 18 ] && need_node=0 && log "Node 已安裝 $(node -v)"
fi
if [ "$need_node" -eq 1 ]; then
  log "安裝 Node $NODE_MAJOR（NodeSource）"
  if [ "$PM" = apt ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    $SUDO "$PM" install -y nodejs
  fi
fi
NODE_BIN="$(command -v node)"
log "Node：$NODE_BIN $(node -v)"

# ── Python venv + 引擎相依 ─────────────────────────────────
log "建立引擎 venv 並安裝 requirements（pandas/pyarrow 有 aarch64 wheel）"
cd "$APP_DIR/engine"
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install --upgrade pip wheel
./.venv/bin/pip install -r requirements.txt
log "引擎相依完成：$(./.venv/bin/python -V)"

# ── Node 相依（gateway + 老王腳本：dotenv/playwright/googleapis…）─────────
log "安裝 Node 相依（npm ci）"
cd "$APP_DIR"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

if [ "$INSTALL_PLAYWRIGHT" = "1" ]; then
  log "安裝 Playwright Chromium（+系統相依）供老王 B1 抓文"
  npx playwright install chromium --with-deps || warn "playwright 安裝失敗；B2（老王留本機）可忽略"
fi

# ── 前端 build（web/dist 由 gateway 同源 serve）────────────
if [ -f "$APP_DIR/web/package.json" ]; then
  log "build 前端（web/ → web/dist）"
  cd "$APP_DIR/web"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
  npm run build
  cd "$APP_DIR"
else
  warn "找不到 web/package.json，略過前端 build"
fi

# ── 祕密檔檢查（不建立，只提醒）────────────────────────────
[ -f "$APP_DIR/engine/.env" ] || warn "缺 engine/.env（FINMIND_TOKEN/FUGLE_API_KEY/FRED_API_KEY）→ 請 scp 上來"
[ -f "$APP_DIR/.env" ] || warn "缺根 .env（TELEGRAM_*；B1 還需 GOOGLE_*/GEMINI_*）→ 請 scp 上來"

# ── systemd units ──────────────────────────────────────────
log "安裝 systemd units（engine + gateway）"
render() { sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@RUN_USER@|$RUN_USER|g" -e "s|@NODE_BIN@|$NODE_BIN|g" "$1"; }
render "$APP_DIR/deploy/puhui-engine.service"  | $SUDO tee /etc/systemd/system/puhui-engine.service  >/dev/null
render "$APP_DIR/deploy/puhui-gateway.service" | $SUDO tee /etc/systemd/system/puhui-gateway.service >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now puhui-engine.service
$SUDO systemctl enable --now puhui-gateway.service
sleep 2
$SUDO systemctl --no-pager --lines=0 status puhui-engine.service  || true
$SUDO systemctl --no-pager --lines=0 status puhui-gateway.service || true

# ── cron（盤後刷新 + 健康檢查；老王 B1 預設註解）────────────
log "安裝 cron（refresh + healthcheck；老王 B1 預設停用）"
chmod +x "$APP_DIR/deploy/refresh.sh" "$APP_DIR/deploy/healthcheck.sh" 2>/dev/null || true
CRON_TMP="$(mktemp)"
crontab -u "$RUN_USER" -l 2>/dev/null | sed '/# >>> puhui phase8 >>>/,/# <<< puhui phase8 <<</d' > "$CRON_TMP" || true
{
  echo "# >>> puhui phase8 >>>"
  sed -e "s|@APP_DIR@|$APP_DIR|g" "$APP_DIR/deploy/crontab.example" | grep -vE '^\s*#( |$)' | grep -vE '^\s*$'
  echo "# <<< puhui phase8 <<<"
} >> "$CRON_TMP"
$SUDO crontab -u "$RUN_USER" "$CRON_TMP"
rm -f "$CRON_TMP"
log "目前 $RUN_USER 的 cron："
crontab -u "$RUN_USER" -l 2>/dev/null | sed -n '/# >>> puhui phase8 >>>/,/# <<< puhui phase8 <<</p' || true

log "完成 ✅  健康檢查：curl -s http://127.0.0.1:3000/api/health"
cat <<NEXT

下一步（見 docs/runbook.md）：
  1) 若上面有 [warn] 缺祕密 → scp engine/.env 與根 .env 上來後：
       sudo systemctl restart puhui-engine puhui-gateway
  2) 從你的電腦用 SSH tunnel 看前端（最安全，不用開對外埠）：
       ssh -L 3000:localhost:3000 $RUN_USER@<VM_IP>   然後瀏覽器開 http://localhost:3000
  3) 老王雲端化（B1，選用）：先 'claude'/'gemini' CLI 登入，再到 crontab 取消老王那行註解。
NEXT
