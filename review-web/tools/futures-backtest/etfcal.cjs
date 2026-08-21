// etfcal.cjs — 抓真實 00631L 日線，並反解「正二每年到底被拖累多少」
// etf.cjs 的合成正二用這個數字；換一段期間反解出來的值不一樣，所以要看得到區間敏感度。
const fs = require('fs');
const { simulateETF, buildModelled, SPOT, loadYahoo } = require('./etf.cjs');

async function fetchIfMissing() {
  const dest = __dirname + '/y631L.json';
  if (fs.existsSync(dest) && !process.env.REFETCH) return;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/00631L.TW?period1=852000000&period2=9999999999&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('00631L.TW 抓取失敗：HTTP ' + res.status);
  const body = await res.text();
  if (!body.includes('"timestamp"')) throw new Error('00631L.TW 回傳沒有時間序列');
  fs.writeFileSync(dest, body);
  console.log('已下載 00631L.TW → y631L.json');
}

async function main() {
  await fetchIfMissing();
  const L = loadYahoo('y631L.json');
  console.log('原始資料 ' + L.length + ' 筆：' + L[0].date + ' ~ ' + L[L.length - 1].date);
  for (let i = 1; i < L.length; i++) {
    const r = L[i].adj / L[i - 1].adj - 1;
    if (Math.abs(r) > 0.4) console.log('⚠️ 尺度斷點 ' + L[i].date + '：' + (r * 100).toFixed(2) + '%（比例 '
      + (L[i - 1].adj / L[i].adj).toFixed(3) + '），非任何真實除權息，etf.cjs 直接把這天之前整段丟掉');
  }
  const idx = (d) => SPOT.findIndex((r) => r.date >= d);
  console.log('\n起算日      真實 00631L 年化   反解年拖累   （合成正二用這個數字重現真實績效）');
  for (const from of ['2015-01-05', '2016-01-01', '2017-01-01', '2018-01-01', '2020-01-01', '2022-01-01']) {
    const rows = L.filter((r) => r.date >= from);
    const yrs = (new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / 31557600000;
    const real = Math.pow(rows[rows.length - 1].adj / rows[0].adj, 1 / yrs) - 1;
    let lo = 0, hi = 0.15;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const r = simulateETF({ rows: buildModelled(mid), startIdx: idx(from), targetBeta: 2, crash: false, band: 999 });
      if (r.cagr > real) lo = mid; else hi = mid;
    }
    console.log(from + '   ' + (real * 100).toFixed(2).padStart(12) + '%' + ((lo + hi) / 2 * 100).toFixed(2).padStart(12) + '%/年');
  }
  console.log('\n區間差異來自資料噪音與台指期基差的年度變化。etf.cjs 預設取 3.0%/年（偏保守，對正二有利）。');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
