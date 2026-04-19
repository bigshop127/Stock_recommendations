
/**
 * CCB v0.12.2 - Strict WAL Logger
 * 常駐 File Descriptor + fdatasyncSync 確保不可逆落盤
 */

const fs = require('fs');
const path = require('path');

const WAL_FILE_PATH = path.join(__dirname, '../../logs/ccb_domain_events.jsonl');
let walFd = null;

function initWal() {
  if (walFd !== null) return;

  const dir = path.dirname(WAL_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  walFd = fs.openSync(WAL_FILE_PATH, 'a');
  console.log(`[WAL] 領域事件日誌已掛載: ${WAL_FILE_PATH}`);
}

function logDomainEvent(eventType, payload) {
  initWal();

  const event = {
    type: eventType,
    ts: new Date().toISOString(),
    ...payload,
  };

  const logLine = JSON.stringify(event) + '\n';

  try {
    fs.writeSync(walFd, logLine);
    fs.fdatasyncSync(walFd);
  } catch (error) {
    console.error(`[WAL] 致命錯誤：無法寫入事件 ${eventType}`, error);
    throw error;
  }
}

// 進程退出前優雅關閉 FD
process.on('SIGINT', () => {
  if (walFd !== null) {
    fs.closeSync(walFd);
    console.log('[WAL] 檔案描述子已安全關閉');
  }
  process.exit(0);
});

module.exports = { logDomainEvent };
