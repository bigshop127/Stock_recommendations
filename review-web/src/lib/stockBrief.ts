import type { StockSignal, OhlcvRow, StockChips, StockFundamentals, StockNews } from './api';

export interface StockBriefInput {
  blended: StockSignal | null;            // signalState.data?.blended
  dailyOhlcv: OhlcvRow[] | null;          // 日K還原價快照（與分K切換隔離）
  chips: StockChips | null;               // 既有 20 日籌碼
  fundamentals: StockFundamentals | null; // 既有基本面
  news: StockNews | null;                 // 既有新聞輿情
}

export interface ForceScore {
  key: 'momentum' | 'technical' | 'chips' | 'fundamental' | 'sentiment';
  label: string;
  score: number | null;
  source: 'factor' | 'derived';
}

export interface BriefBullet {
  text: string;
  provenance: string;
  tone: 'plus' | 'minus';
  category: 'chips' | 'fundamental' | 'momentum' | 'sentiment';
  strength: number;
}

export interface Checkpoint {
  label: string;
  pass: boolean;
  current: string;
  target: string;
}

export interface StockBrief {
  overall: number | null;
  action: string | null;
  stateLabel: string;
  headline: string;
  forces: ForceScore[];        // 固定 5 筆、順序固定：動能/技術/籌碼/基本面/情緒
  plus: BriefBullet[];
  minus: BriefBullet[];        // 每側最多 4 條
  checkpoints: Checkpoint[];
  invalidation: string[];
  asOf: string | null;
  degraded: boolean;          // blended 整包缺 → true（整卡灰態）
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function calculateSMA(rows: OhlcvRow[], period: number): number | null {
  if (rows.length < period) return null;
  const slice = rows.slice(rows.length - period);
  const sum = slice.reduce((acc, r) => acc + r.close, 0);
  return sum / period;
}

function calculateVolumeSMA(rows: OhlcvRow[], period: number): number | null {
  if (rows.length < period) return null;
  const slice = rows.slice(rows.length - period);
  let hasValidVol = false;
  let sum = 0;
  for (const r of slice) {
    if (r.volume !== undefined && r.volume !== null && !isNaN(r.volume)) {
      sum += r.volume;
      hasValidVol = true;
    }
  }
  return hasValidVol ? sum / period : null;
}

export function buildStockBrief(input: StockBriefInput): StockBrief {
  const { blended, dailyOhlcv, chips, fundamentals, news } = input;

  // Degraded check
  const degraded = !blended || blended.unavailable === true || blended.score == null;

  const overall = blended && blended.score != null && !isNaN(blended.score)
    ? Math.round(blended.score)
    : null;
  const action = blended?.action || null;
  const asOf = blended?.date || fundamentals?.as_of || chips?.as_of || null;

  // Sort daily OHLCV ascending by date
  const sortedDaily = dailyOhlcv
    ? [...dailyOhlcv].sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const dailyCount = sortedDaily.length;
  const lastDaily = dailyCount > 0 ? sortedDaily[dailyCount - 1] : null;

  const ma5 = calculateSMA(sortedDaily, 5);
  const ma20 = calculateSMA(sortedDaily, 20);
  const ma60 = calculateSMA(sortedDaily, 60);

  let ret20: number | null = null;
  if (dailyCount >= 20 && lastDaily) {
    const close20Ago = sortedDaily[dailyCount - 20].close;
    if (close20Ago > 0) {
      ret20 = ((lastDaily.close - close20Ago) / close20Ago) * 100;
    }
  }

  const vol5 = calculateVolumeSMA(sortedDaily, 5);
  const vol20 = calculateVolumeSMA(sortedDaily, 20);
  let volr: number | null = null;
  if (vol5 !== null && vol20 !== null && vol20 > 0) {
    volr = vol5 / vol20;
  }

  // 1. Calculate Momentum Force
  let momentumScore: number | null = null;
  if (dailyCount >= 20 && lastDaily && ma5 !== null && ma20 !== null) {
    let ma_part = 0;
    if (dailyCount >= 60 && ma60 !== null) {
      ma_part = (lastDaily.close > ma5 ? 25 : 0)
        + (ma5 > ma20 ? 25 : 0)
        + (ma20 > ma60 ? 25 : 0)
        + (lastDaily.close > ma60 ? 25 : 0);
    } else {
      ma_part = (lastDaily.close > ma5 ? 50 : 0)
        + (ma5 > ma20 ? 50 : 0);
    }

    const ret_part = ret20 !== null ? clamp(50 + ret20 * 2.5, 0, 100) : 50;

    if (volr !== null) {
      const vol_part = clamp(50 + (volr - 1) * 50, 0, 100);
      momentumScore = Math.round(0.4 * ma_part + 0.4 * ret_part + 0.2 * vol_part);
    } else {
      momentumScore = Math.round(0.5 * ma_part + 0.5 * ret_part);
    }
  }

  // 2. Calculate Fundamental Force
  let rev_part: number | null = null;
  if (fundamentals?.revenue && fundamentals.revenue.length > 0) {
    const sortedRev = [...fundamentals.revenue].sort((a, b) => a.month.localeCompare(b.month));
    const latestRev = sortedRev.filter(r => r.yoy !== null && r.yoy !== undefined).pop();
    if (latestRev && latestRev.yoy !== null) {
      rev_part = clamp(50 + latestRev.yoy * 1.25, 0, 100);
    }
  }

  let eps_part: number | null = null;
  let latestFinQuarter: string | null = null;
  let epsQoq: number | null = null;
  if (fundamentals?.financials && fundamentals.financials.length >= 2) {
    const sortedFin = [...fundamentals.financials].sort((a, b) => a.quarter.localeCompare(b.quarter));
    const latestFin = sortedFin[sortedFin.length - 1];
    const prevFin = sortedFin[sortedFin.length - 2];
    latestFinQuarter = latestFin.quarter;
    if (prevFin.eps !== null && prevFin.eps > 0 && latestFin.eps !== null) {
      epsQoq = ((latestFin.eps - prevFin.eps) / prevFin.eps) * 100;
      eps_part = clamp(50 + epsQoq * 1.25, 0, 100);
    }
  }

  let fundamentalScore: number | null = null;
  if (rev_part !== null && eps_part !== null) {
    fundamentalScore = Math.round((rev_part + eps_part) / 2);
  } else if (rev_part !== null) {
    fundamentalScore = Math.round(rev_part);
  } else if (eps_part !== null) {
    fundamentalScore = Math.round(eps_part);
  }

  // 3. Extract Technical, Chips, Sentiment Factor Scores
  const factors = blended?.factors || [];
  const getFactorScore = (key: string): number | null => {
    const f = factors.find(item => item.key === key);
    return f && f.score != null && !isNaN(f.score) ? Math.round(f.score) : null;
  };

  const technicalScore = getFactorScore('technical');
  const chipsScore = getFactorScore('chips');
  const sentimentScore = getFactorScore('sentiment');

  const forces: ForceScore[] = [
    { key: 'momentum', label: '動能', score: momentumScore, source: 'derived' },
    { key: 'technical', label: '技術', score: technicalScore, source: 'factor' },
    { key: 'chips', label: '籌碼', score: chipsScore, source: 'factor' },
    { key: 'fundamental', label: '基本面', score: fundamentalScore, source: 'derived' },
    { key: 'sentiment', label: '情緒', score: sentimentScore, source: 'factor' },
  ];

  // 4. Generate Plus and Minus Bullets
  const plusCandidates: BriefBullet[] = [];
  const minusCandidates: BriefBullet[] = [];

  // Chips Rules
  const sortedChips = chips?.data
    ? [...chips.data].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  if (sortedChips.length >= 5) {
    const last5 = sortedChips.slice(sortedChips.length - 5);
    const hasNull = last5.some(c => c.total_net_buy_qty === null || c.total_net_buy_qty === undefined);
    if (!hasNull) {
      const sum5 = last5.reduce((acc, c) => acc + (c.total_net_buy_qty || 0), 0);
      if (sum5 >= 500) {
        plusCandidates.push({
          text: `法人 5 日累積買超 +${sum5.toLocaleString('en-US')} 張`,
          provenance: `籌碼 · 近5日 total_net_buy_qty 合計`,
          tone: 'plus',
          category: 'chips',
          strength: Math.min(100, Math.abs(sum5) / 100),
        });
      } else if (sum5 <= -500) {
        minusCandidates.push({
          text: `法人 5 日累積賣超 ${Math.abs(sum5).toLocaleString('en-US')} 張`,
          provenance: `籌碼 · 近5日 total_net_buy_qty 合計`,
          tone: 'minus',
          category: 'chips',
          strength: Math.min(100, Math.abs(sum5) / 100),
        });
      }
    }
  }

  // Foreign & IT consecutive buy/sell
  if (sortedChips.length >= 3) {
    // Foreign
    let foreignBuyDays = 0;
    let foreignSellDays = 0;
    for (let i = sortedChips.length - 1; i >= 0; i--) {
      const qty = sortedChips[i].foreign_net_buy_qty;
      if (qty > 0 && foreignSellDays === 0) foreignBuyDays++;
      else if (qty < 0 && foreignBuyDays === 0) foreignSellDays++;
      else break;
    }
    if (foreignBuyDays >= 3) {
      plusCandidates.push({
        text: `外資 ${foreignBuyDays} 日連買`,
        provenance: `籌碼 · /stocks/:code/chips 逐日`,
        tone: 'plus',
        category: 'chips',
        strength: foreignBuyDays * 10,
      });
    } else if (foreignSellDays >= 3) {
      minusCandidates.push({
        text: `外資 ${foreignSellDays} 日連賣`,
        provenance: `籌碼 · /stocks/:code/chips 逐日`,
        tone: 'minus',
        category: 'chips',
        strength: foreignSellDays * 10,
      });
    }

    // Investment Trust
    let itBuyDays = 0;
    let itSellDays = 0;
    for (let i = sortedChips.length - 1; i >= 0; i--) {
      const qty = sortedChips[i].investment_trust_net_buy_qty;
      if (qty > 0 && itSellDays === 0) itBuyDays++;
      else if (qty < 0 && itBuyDays === 0) itSellDays++;
      else break;
    }
    if (itBuyDays >= 3) {
      plusCandidates.push({
        text: `投信 ${itBuyDays} 日連買`,
        provenance: `籌碼 · /stocks/:code/chips 逐日`,
        tone: 'plus',
        category: 'chips',
        strength: itBuyDays * 10,
      });
    } else if (itSellDays >= 3) {
      minusCandidates.push({
        text: `投信 ${itSellDays} 日連賣`,
        provenance: `籌碼 · /stocks/:code/chips 逐日`,
        tone: 'minus',
        category: 'chips',
        strength: itSellDays * 10,
      });
    }
  }

  // Fundamental Rules
  if (fundamentals?.revenue && fundamentals.revenue.length > 0) {
    const sortedRev = [...fundamentals.revenue].sort((a, b) => a.month.localeCompare(b.month));
    const latestRev = sortedRev.filter(r => r.yoy !== null && r.yoy !== undefined).pop();
    if (latestRev && latestRev.yoy !== null) {
      if (latestRev.yoy >= 20) {
        plusCandidates.push({
          text: `月營收年增 +${latestRev.yoy.toFixed(1)}%`,
          provenance: `基本面 · monthly_revenue ${latestRev.month}`,
          tone: 'plus',
          category: 'fundamental',
          strength: latestRev.yoy,
        });
      } else if (latestRev.yoy <= -10) {
        minusCandidates.push({
          text: `月營收年減 ${Math.abs(latestRev.yoy).toFixed(1)}%`,
          provenance: `基本面 · monthly_revenue ${latestRev.month}`,
          tone: 'minus',
          category: 'fundamental',
          strength: Math.abs(latestRev.yoy),
        });
      }
    }
  }

  if (latestFinQuarter && epsQoq !== null) {
    if (epsQoq >= 15) {
      plusCandidates.push({
        text: `EPS 季增 +${epsQoq.toFixed(1)}%`,
        provenance: `基本面 · 季報 EPS ${latestFinQuarter}`,
        tone: 'plus',
        category: 'fundamental',
        strength: epsQoq,
      });
    } else if (epsQoq <= -15) {
      minusCandidates.push({
        text: `EPS 季減 ${Math.abs(epsQoq).toFixed(1)}%`,
        provenance: `基本面 · 季報 EPS ${latestFinQuarter}`,
        tone: 'minus',
        category: 'fundamental',
        strength: Math.abs(epsQoq),
      });
    }
  }

  // Momentum Rules
  if (dailyCount >= 60 && ma5 !== null && ma20 !== null && ma60 !== null) {
    if (ma5 > ma20 && ma20 > ma60) {
      plusCandidates.push({
        text: `均線多頭排列（MA5>MA20>MA60）`,
        provenance: `動能 · 日K還原價 MA5/20/60`,
        tone: 'plus',
        category: 'momentum',
        strength: 80,
      });
    } else if (ma5 < ma20 && ma20 < ma60) {
      minusCandidates.push({
        text: `均線空頭排列（MA5<MA20<MA60）`,
        provenance: `動能 · 日K還原價 MA5/20/60`,
        tone: 'minus',
        category: 'momentum',
        strength: 80,
      });
    }
  }

  if (ret20 !== null) {
    if (ret20 >= 10) {
      plusCandidates.push({
        text: `近20日漲幅 +${ret20.toFixed(1)}%`,
        provenance: `動能 · 日K還原價`,
        tone: 'plus',
        category: 'momentum',
        strength: ret20,
      });
    } else if (ret20 <= -10) {
      minusCandidates.push({
        text: `近20日跌幅 ${Math.abs(ret20).toFixed(1)}%`,
        provenance: `動能 · 日K還原價`,
        tone: 'minus',
        category: 'momentum',
        strength: Math.abs(ret20),
      });
    }
  }

  if (volr !== null) {
    if (volr >= 1.5) {
      plusCandidates.push({
        text: `成交量顯著放大（量比 ${volr.toFixed(1)}×）`,
        provenance: `動能 · 日K還原價`,
        tone: 'plus',
        category: 'momentum',
        strength: volr * 20,
      });
    } else if (volr <= 0.5) {
      minusCandidates.push({
        text: `成交量明顯萎縮（量比 ${volr.toFixed(1)}×）`,
        provenance: `動能 · 日K還原價`,
        tone: 'minus',
        category: 'momentum',
        strength: (1 - volr) * 20,
      });
    }
  }

  // Sentiment Rules
  if (news?.summary && news.summary.total >= 3) {
    const sScore = news.summary.overall_score;
    if (sScore >= 70) {
      plusCandidates.push({
        text: `新聞輿情偏多（情緒分 ${Math.round(sScore)}）`,
        provenance: `情緒 · /stocks/:code/news 近${news.summary.total}則`,
        tone: 'plus',
        category: 'sentiment',
        strength: sScore,
      });
    } else if (sScore <= 30) {
      minusCandidates.push({
        text: `新聞輿情偏空（情緒分 ${Math.round(sScore)}）`,
        provenance: `情緒 · /stocks/:code/news 近${news.summary.total}則`,
        tone: 'minus',
        category: 'sentiment',
        strength: 100 - sScore,
      });
    }
  }

  if (blended) {
    const dateStr = blended.date || '最新';
    if (blended.agreement === 'aligned') {
      const act = blended.action || '訊號';
      plusCandidates.push({
        text: `老王 ${act} 與量化同向`,
        provenance: `情緒 · 老王 ${dateStr}`,
        tone: 'plus',
        category: 'sentiment',
        strength: 75,
      });
    }
    if (blended.conflict === true) {
      minusCandidates.push({
        text: `量化與老王方向背離`,
        provenance: `情緒 · 老王 ${dateStr}`,
        tone: 'minus',
        category: 'sentiment',
        strength: 75,
      });
    }
  }

  // Filter candidates: sort by strength desc, max 2 per category, top 4 total
  const filterBullets = (bullets: BriefBullet[]): BriefBullet[] => {
    const sorted = [...bullets].sort((a, b) => b.strength - a.strength);
    const catCount: Record<string, number> = {};
    const result: BriefBullet[] = [];
    for (const b of sorted) {
      const c = catCount[b.category] || 0;
      if (c < 2) {
        catCount[b.category] = c + 1;
        result.push(b);
        if (result.length >= 4) break;
      }
    }
    return result;
  };

  const plus = filterBullets(plusCandidates);
  const minus = filterBullets(minusCandidates);

  // 5. State Label
  let stateLabel = '訊號中性';
  if (degraded) {
    stateLabel = '資料不足';
  } else if (plus.length >= 3 && minus.length === 0) {
    stateLabel = '多項利多訊號並存';
  } else if (minus.length >= 3 && plus.length === 0) {
    stateLabel = '多項利空訊號並存';
  } else if (plus.length >= 1 && minus.length >= 1) {
    stateLabel = '多空訊號並存';
  }

  // 6. Headline Generation
  const name = blended?.name || fundamentals?.name || chips?.name || news?.name || '個股';
  const code = blended?.code || input.blended?.code || '—';

  let headline = '';
  if (degraded) {
    headline = '訊號資料不足，僅顯示可用區塊';
  } else {
    const validForces = forces.filter(f => f.score !== null);
    if (validForces.length > 0) {
      const strongest = [...validForces].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      const matchingBullet = [...plus, ...minus].find(b => b.category === strongest.key);
      const keyObs = matchingBullet
        ? matchingBullet.text
        : '詳見下方因素列表';

      headline = `${name}（${code}）目前資料訊號為「${stateLabel}」，五力綜合分數 ${overall ?? '—'}。當下${strongest.label}面向最突出（${strongest.score} 分），關鍵觀察點：${keyObs}。`;
    } else {
      headline = `${name}（${code}）目前資料訊號為「${stateLabel}」，五力綜合分數 ${overall ?? '—'}。`;
    }
  }

  // 7. Checkpoints
  const checkpoints: Checkpoint[] = [];
  const invalidation: string[] = [];

  if (dailyCount >= 60 && lastDaily && ma60 !== null) {
    const close = lastDaily.close;
    const diffPct = ((close - ma60) / ma60) * 100;
    const currentStr = `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
    checkpoints.push({
      label: '守住 60 日均線',
      pass: close >= ma60,
      current: currentStr,
      target: `≥ ${ma60.toFixed(2)}`,
    });
    invalidation.push(`跌破 60 日均線（收盤 < ${ma60.toFixed(2)}）`);
  }

  if (dailyCount >= 20 && lastDaily && ma20 !== null) {
    const close = lastDaily.close;
    const diffPct = ((close - ma20) / ma20) * 100;
    const currentStr = `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
    checkpoints.push({
      label: '維持 20 日均線上方',
      pass: close >= ma20,
      current: currentStr,
      target: `≥ ${ma20.toFixed(2)}`,
    });
  }

  if (dailyCount >= 20 && volr !== null) {
    checkpoints.push({
      label: '5 日均量維持 1× 以上',
      pass: volr >= 1.0,
      current: `${volr.toFixed(2)}×`,
      target: '≥ 1.0×',
    });
  }

  if (sortedChips.length >= 5) {
    const last5 = sortedChips.slice(sortedChips.length - 5);
    const hasNull = last5.some(c => c.total_net_buy_qty === null || c.total_net_buy_qty === undefined);
    if (!hasNull) {
      const sum5 = last5.reduce((acc, c) => acc + (c.total_net_buy_qty || 0), 0);
      checkpoints.push({
        label: '法人 5 日累積保持淨買進',
        pass: sum5 >= 0,
        current: `${sum5 >= 0 ? '+' : ''}${sum5.toLocaleString('en-US')} 張`,
        target: '≥ 0',
      });
      invalidation.push('法人轉為連續賣超（5 日累積轉為負值）');
    }
  }

  return {
    overall,
    action,
    stateLabel,
    headline,
    forces,
    plus,
    minus,
    checkpoints,
    invalidation,
    asOf,
    degraded,
  };
}
