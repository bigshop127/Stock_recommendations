'use strict';
/**
 * 回歸測試（階段8 §A）：驗證 RUN_TARGET 解耦後，local / ci / vm 三種環境的旗標與輸出路徑正確，
 * 且 local 與 ci 與「舊 IS_CI 行為」完全一致。純讀模組頂部常數，不打網路、不呼叫 LLM。
 *
 * 執行：node scripts/test_puhui_run_target.cjs
 */
const assert = require('assert');
const MOD = require.resolve('./puhui_daily.cjs');

function loadWith(env) {
  for (const k of ['RUN_TARGET', 'CI']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[MOD];
  return require('./puhui_daily.cjs');
}

let pass = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ok  ${name}`);
  pass++;
}

console.log('local（預設：無 RUN_TARGET、無 CI）— 必須與舊 !IS_CI 行為一致');
let m = loadWith({});
check('RUN_TARGET=local', m.RUN_TARGET === 'local');
check('用 Claude CLI 主力（IS_CI=false）', m.IS_CI === false);
check('寫 Obsidian（WRITE_OBSIDIAN=true）', m.WRITE_OBSIDIAN === true);
check('git push（!IS_CI）', m.IS_CI === false);
check('跳過判斷看 Obsidian 筆記', m.EXISTING_OUTPUT_PATH === m.NOTE_PATH);

console.log('\nci（CI=true，無 RUN_TARGET）— 必須與舊 IS_CI 行為一致');
m = loadWith({ CI: 'true' });
check('RUN_TARGET=ci', m.RUN_TARGET === 'ci');
check('只用 Gemini（IS_CI=true）', m.IS_CI === true);
check('不寫 Obsidian（WRITE_OBSIDIAN=false）', m.WRITE_OBSIDIAN === false);

console.log('\nvm（RUN_TARGET=vm）— 新增：Claude CLI + 不寫 Obsidian + git push + 告警');
m = loadWith({ RUN_TARGET: 'vm' });
check('RUN_TARGET=vm', m.RUN_TARGET === 'vm');
check('用 Claude CLI 主力（IS_CI=false）', m.IS_CI === false);
check('不寫 Obsidian（WRITE_OBSIDIAN=false）', m.WRITE_OBSIDIAN === false);
check('git push（!IS_CI）', m.IS_CI === false);
check('跳過判斷看 repo 報告（非 Obsidian）', m.EXISTING_OUTPUT_PATH === m.REPORT_PATH);

console.log('\n邊界：RUN_TARGET 明確設定優先於 CI 旗標');
m = loadWith({ RUN_TARGET: 'vm', CI: 'true' });
check('vm + CI=true 仍為 vm（IS_CI=false）', m.RUN_TARGET === 'vm' && m.IS_CI === false);
m = loadWith({ RUN_TARGET: 'VM' });
check('大小寫不敏感（VM → vm）', m.RUN_TARGET === 'vm');

console.log(`\n✅ ${pass} checks passed`);
