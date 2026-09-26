/**
 * twse_credit.js — 證交所「臺股儀表板」資料的純解析層（不發請求，方便測試）。
 *
 * 來源都是 https://www.twse.com.tw/rwd/zh/... 的公開 JSON（免金鑰），儀表板頁面自己在用：
 *   marginTrading/BFIJ3U_TREND    全市場擔保維持率、維持率<130% 戶數、追繳金額、處分戶數/金額
 *                                 ——只從 2026-08-03 起有資料，沒辦法拿來回測
 *   marginTrading/MI_MARGN_TREND  上市融資金額/張數、融券張數、上市市值（最多約 60 個交易日）
 *   marginTrading/MI_MARGN_HISTORY 2000 年起每年的融資占市值比、信用交易占成交比
 *   announcement/BFIGTU           違約金額，以及「個股達違約資訊揭露標準」名單
 *
 * 口徑提醒（畫面上也要講清楚）：
 *   - keepRate 是官方「融資＋融券合併」算的全市場擔保維持率，跟媒體常講只算融資的
 *     「大盤融資維持率」不是同一個數字，130%～140% 那種經驗門檻不能直接套。
 *   - 維持率／追繳／處分是「全市場」（上市＋上櫃）；融資融券餘額與市值是「上市」。
 */
'use strict';

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** '20260924' → '2026-09-24' */
function ymdToIso(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 民國年 '115.09.21' 或 '115/09/21' → '2026-09-21' */
function rocToIso(s) {
  const m = /^(\d{2,3})[./](\d{1,2})[./](\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const isOk = (body) => !!body && String(body.stat).toUpperCase() === 'OK';

/**
 * 把兩條每日趨勢併成一條以日期為鍵的序列，單位統一成「元」與「張」。
 * 兩邊的起訖日不同（維持率 8/3 起、融資最多 60 天），缺的欄位留 null，不補值。
 */
function parseCreditSeries(keepTrend, marginTrend) {
  const byDate = new Map();
  const row = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        keep_rate: null,
        below_130_accounts: null,
        call_amount: null,
        disposal_accounts: null,
        disposal_amount: null,
        credit_turnover: null,
        margin_balance: null,
        margin_shares: null,
        short_shares: null,
        market_value: null,
      });
    }
    return byDate.get(date);
  };

  if (isOk(keepTrend) && Array.isArray(keepTrend.data)) {
    for (const r of keepTrend.data) {
      const date = ymdToIso(r.date);
      if (!date) continue;
      const o = row(date);
      o.keep_rate = numOrNull(r.keepRate);
      // 儀表板把 belowAccNum 標成「追繳戶數」，官方說明是「整戶擔保維持率低於130%之戶數」
      o.below_130_accounts = numOrNull(r.belowAccNum);
      o.call_amount = numOrNull(r.callAmt);            // 元
      o.disposal_accounts = numOrNull(r.exeAccNum);    // 次一營業日要被處分（斷頭）的戶數
      o.disposal_amount = numOrNull(r.exeAmt);         // 元
      o.credit_turnover = numOrNull(r.crdAmt);         // 元
    }
  }

  if (isOk(marginTrend) && Array.isArray(marginTrend.data)) {
    for (const r of marginTrend.data) {
      const date = ymdToIso(r.date);
      if (!date) continue;
      const o = row(date);
      const amtThousand = numOrNull(r.marginAmt);      // 千元
      const mvYi = numOrNull(r.marketValue);           // 億元
      o.margin_balance = amtThousand === null ? null : amtThousand * 1000;
      o.margin_shares = numOrNull(r.marginShr);
      o.short_shares = numOrNull(r.shortShr);
      o.market_value = mvYi === null ? null : mvYi * 1e8;
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 年度歷史：每年最後一個營業日的融資占市值比（%），當年度是「前月底」 */
function parseCreditHistory(history) {
  if (!isOk(history) || !Array.isArray(history.data)) return [];
  return history.data
    .map((r) => ({
      year: String(r.year || ''),
      label: String(r.label || r.year || ''),
      period_end: String(r.periodEnd || ''),
      margin_ratio: numOrNull(r.marginRatio),
      credit_ratio: numOrNull(r.creditRatio),
    }))
    .filter((r) => r.year && r.margin_ratio !== null);
}

/**
 * 違約揭露。BFIGTU 回兩張表：每日違約金額，與「個股達違約資訊揭露標準」名單。
 * 靠欄位名認表，不靠順序——證交所改版時順序最容易動。
 * 名單裡每筆後面會跟一列「總計」（證券代號空白），要略過；
 * 券商名稱是多家用換行串起來、中間還夾排版用的空白（'北    城'）。
 */
function parseDefaultDisclosures(body) {
  if (!isOk(body) || !Array.isArray(body.tables)) {
    return { items: [], daily: [] };
  }
  const hasField = (t, name) => Array.isArray(t.fields) && t.fields.some((f) => String(f).includes(name));

  const items = [];
  const stockTable = body.tables.find((t) => hasField(t, '證券代號'));
  if (stockTable && Array.isArray(stockTable.data)) {
    for (const r of stockTable.data) {
      const [rawDate, rawCode, rawName, rawBrokers, rawAmount] = r;
      const code = String(rawCode || '').trim();
      const date = rocToIso(rawDate);
      if (!code || !date) continue;
      items.push({
        date,
        code,
        name: String(rawName || '').trim(),
        brokers: String(rawBrokers || '')
          .split('\n')
          .map((s) => s.replace(/\s+/g, ''))
          .filter(Boolean),
        amount: numOrNull(rawAmount),                   // 元
      });
    }
  }

  const daily = [];
  const dailyTable = body.tables.find((t) => t !== stockTable && hasField(t, '申報日期'));
  if (dailyTable && Array.isArray(dailyTable.data)) {
    for (const r of dailyTable.data) {
      const date = rocToIso(r[0]);
      if (!date) continue;
      daily.push({
        date,
        total_amount: numOrNull(r[1]),                  // 元，違約買進＋賣出合計
        net_amount: numOrNull(r[2]),                    // 元，買賣相抵後
        people: numOrNull(r[3]),
      });
    }
  }

  items.sort((a, b) => b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return { items, daily };
}

module.exports = {
  numOrNull,
  ymdToIso,
  rocToIso,
  parseCreditSeries,
  parseCreditHistory,
  parseDefaultDisclosures,
};
