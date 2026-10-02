// node --test routes/reports_run.test.js
// 測資是 VM ~/puhui_daily.cron.log 的真實輸出（2026-09-30～10-02），只留判斷需要的行。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRun } = require('./reports_run');

const DOTENV = '◇ injected env (16) from .env // tip: ⌘ suppress logs { quiet: true }';

test('產生成功（含 push 衝突自動解決）→ done', () => {
  const out = [
    DOTENV,
    '[2026-10-01T05:00:19.718Z]   候選: 2026/10/01 國巨漲停！ | canRead=true',
    '[2026-10-01T05:10:09.585Z] 報告寫入 repo: reports/2026-10/W1/2026-10-01.md',
    '[2026-10-01T05:10:11.434Z] GitHub push 第一次失敗，rebase 後重試: Command failed',
    '[2026-10-01T05:10:15.875Z] 報告已推送到 GitHub（rebase 後重試成功）',
    '[2026-10-01T05:10:15.875Z] ===== puhui_daily 完成 =====',
  ].join('\n');
  assert.equal(summarizeRun(out, 0).outcome, 'done');
});

test('多篇候選、第一篇讀不到但第二篇可讀並完成 → 仍是 done', () => {
  const out = [
    '[x]   候選: 3999 會員週報 | canRead=false',
    '[x]   候選: 2026/10/02 一般盤勢 | canRead=true',
    '[2026-10-02T05:40:00.000Z] ===== puhui_daily 完成 =====',
  ].join('\n');
  assert.equal(summarizeRun(out, 0).outcome, 'done');
});

test('今天已有報告 → exists', () => {
  const out = '[2026-09-30T04:45:03.768Z] 輸出已存在: /home/ubuntu/Stock_recommendations/reports/2026-09/W5/2026-09-30.md → 跳過';
  assert.equal(summarizeRun(out, 0).outcome, 'exists');
});

test('列表還沒有今天的文章 → no_article', () => {
  const out = [
    DOTENV,
    '[2026-10-02T04:30:18.667Z] 文章列表中找不到 2026/10/02 的文章，可能未發文（週末/假日/請假）',
    '[2026-10-02T04:30:18.667Z] [quiet] 略過 Telegram: ℹ️ 浦惠投顧 2026/10/02',
    '[2026-10-02T04:30:18.667Z] [quiet] 略過 Email: [浦惠自動化] 2026/10/02 今日無發文',
  ].join('\n');
  assert.equal(summarizeRun(out, 0).outcome, 'no_article');
});

test('候選全部 canRead=false → no_access', () => {
  const out = [
    '[x]   候選: 2026/09/24 盤勢 | canRead=false',
    '[x] 所有候選文章都無權限閱讀（連續第 2 天）',
  ].join('\n');
  assert.equal(summarizeRun(out, 0).outcome, 'no_access');
});

test('paywall（exit 1）→ no_access，不是一般錯誤', () => {
  const out = [
    '[x] 抓取結果: 312 字 ⚠️ 疑似 paywall teaser',
    '[x] [quiet] 略過 Email: [浦惠自動化] 2026/10/02 Cookies 疑似失效',
  ].join('\n');
  assert.equal(summarizeRun(out, 1).outcome, 'no_access');
});

test('失敗時用腳本自己的告警主旨當原因，不露出 [quiet] 字樣', () => {
  const out = [
    '[2026-10-02T05:40:00.000Z] Gemini 全部 key 失敗: 429',
    '[2026-10-02T05:40:00.001Z] [quiet] 略過 Telegram: ⚠️ 浦惠投顧 2026/10/02 AI 摘要失敗',
    '[2026-10-02T05:40:00.002Z] [quiet] 略過 Email: [浦惠自動化] 2026/10/02 AI 摘要失敗',
  ].join('\n');
  const r = summarizeRun(out, 1);
  assert.equal(r.outcome, 'error');
  assert.equal(r.message, '執行失敗：2026/10/02 AI 摘要失敗');
});

test('失敗且沒有告警主旨 → 取最後一行（去掉時間戳）', () => {
  const r = summarizeRun('[2026-10-02T05:40:00.000Z] 未捕捉錯誤: boom\n', 1);
  assert.equal(r.message, '執行失敗：未捕捉錯誤: boom');
});

test('exit 0 但不認得的結尾 → error，不要假裝成功', () => {
  assert.equal(summarizeRun(DOTENV, 0).outcome, 'error');
  assert.equal(summarizeRun('', 0).outcome, 'error');
});
