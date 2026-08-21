// versus.cjs — 「00631L 正二＋現金（目標 Beta）」 對上 「小型0050期貨（槓桿）」
// 兩邊吃同一段行情、同一個崩盤訊號、同一組口徑，唯一的差別是工具。
//
// 口徑對齊三件事（不對齊就會比出假差距）：
//   1. 再平衡帶：正二策略是 β±0.1 絕對值，期貨用 bandAbs:0.1 對齊（不是相對 20%）
//   2. 閒置資金：正二的現金部位會生息，期貨專戶裡超過原始保證金的閒錢也用 idleRate:1 補上
//   3. 崩盤加碼：正二是「跌 28% 拉滿 β2.0、創新高才收回」，期貨用 holdUntilAth 複製同一條規則
const { simulate, SERIES, rateOn } = require('./engine.cjs');
const { simulateETF, buildReal, buildModelled } = require('./etf.cjs');

const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';
const REAL = buildReal();
const MODEL = buildModelled(0.03);              // 合成正二：拖累 3.0%/年（真實反解 2.3~4.2%，取中間偏保守）
const F_REAL = SERIES.findIndex((r) => r.date >= REAL[0].date);

const FUT = { dipAdd: 0, trimStep: 0, rollsPerYear: 4, bandAbs: 0.1, idleRate: 1 };
const CRASH_FUT = { dipStep: 0.28, dipAdd: 0, dipLevels: 1, holdUntilAth: true };   // dipAdd 由呼叫端補

function fut(L, startIdx, extra) {
  return simulate(Object.assign({ startIdx, L0: L }, FUT, extra || {}));
}
const HEAD = '策略'.padEnd(30) + '   年化   最大回撤   最差1年     期末   成本/年  平均曝險';
function row(name, r) {
  return name.padEnd(28) + pct(r.cagr).padStart(8) + pct(r.mdd, 1).padStart(9) + pct(r.worst1y, 1).padStart(9)
    + (r.final / 1e6).toFixed(2).padStart(8) + 'M'
    + pct(r.costPctPerYr == null ? r.totalCost / 1e6 / r.years : r.costPctPerYr, 2).padStart(8)
    + r.avgLev.toFixed(2).padStart(9) + (r.liquidations ? '  ⚠️斷頭' + r.liquidations : '');
}

function block(title, rows, f0, etfRows) {
  console.log('\n████ ' + title + ' ████');
  console.log('\n=== A. 正二＋現金：掃目標 β（含崩盤加碼＝跌28%拉滿2.0、創新高收回）===');
  console.log(HEAD);
  let best = null;
  for (let b = 1.0; b <= 2.001; b += 0.1) {
    const r = simulateETF({ rows: etfRows, targetBeta: +b.toFixed(2) });
    if (!best || r.cagr > best.cagr) best = r;
    console.log(row('目標 β ' + b.toFixed(2) + (b > 1.95 ? '（全倉正二）' : ''), r));
  }
  console.log('→ 報酬最高的 β ＝ ' + best.targetBeta.toFixed(2) + '（年化 ' + pct(best.cagr) + '）');

  console.log('\n=== B. 期貨：同樣的崩盤加碼規則，掃平時槓桿 ===');
  console.log(HEAD);
  const target13 = simulateETF({ rows: etfRows, targetBeta: 1.3 });
  const target20 = simulateETF({ rows: etfRows, targetBeta: 2.0, crash: false, band: 999 });
  for (let L = 1.0; L <= 2.51; L += 0.25) {
    const r = fut(L, f0, Object.assign({}, CRASH_FUT, { dipAdd: Math.max(0, 2.0 - L) }));
    const flag = (r.cagr > target13.cagr ? ' ✅贏β1.3策略' : '') + (r.cagr > best.cagr ? ' 🏆贏最佳β' : '');
    console.log(row('期貨 ' + L.toFixed(2) + 'x ＋崩盤加碼到2.0', r) + flag);
  }
  console.log('\n=== C. 期貨：不加碼，純固定槓桿 ===');
  console.log(HEAD);
  for (let L = 1.0; L <= 2.51; L += 0.25) {
    const r = fut(L, f0);
    console.log(row('期貨 ' + L.toFixed(2) + 'x', r) + (r.cagr > target13.cagr ? ' ✅贏β1.3策略' : ''));
  }
  return { best, target13, target20 };
}

block('區間 ' + REAL[0].date + ' ~ ' + REAL[REAL.length - 1].date + '（真實 00631L 價格，' + ((new Date(REAL[REAL.length-1].date)-new Date(REAL[0].date))/31557600000).toFixed(1) + ' 年）', null, F_REAL, REAL);
block('區間 2000-01 ~ 2026-08（合成正二，涵蓋網科泡沫與金融海嘯，26.6 年）', null, 0, MODEL);
