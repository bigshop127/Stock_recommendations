import type { MarketBreadth, MarketInstitutional, MarketRegime } from './api';

export interface MarketSummaryInput {
  breadth: MarketBreadth | null;
  institutional: MarketInstitutional | null;
  regime?: MarketRegime | number | null;
  water_level?: number | null;
}

export interface MarketSignal {
  text: string;
  tone: 'bull' | 'bear' | 'neutral';
}

export interface MarketSummary {
  mood: number; // −100 ～ +100，0=中性
  stance: 'bull' | 'neutral' | 'bear';
  headline: string;
  signals: MarketSignal[]; // 2–4 條
  degraded?: boolean;
}

export function buildMarketSummary(input: MarketSummaryInput): MarketSummary {
  if (!input) {
    return {
      mood: 0,
      stance: 'neutral',
      headline: '資料不足',
      signals: [],
      degraded: true,
    };
  }

  const { breadth, institutional } = input;

  // Extract water level (0~1 float)
  let waterLevel: number | null = null;
  if (typeof input.water_level === 'number' && !isNaN(input.water_level)) {
    waterLevel = input.water_level;
  } else if (typeof input.regime === 'number' && !isNaN(input.regime)) {
    waterLevel = input.regime;
  } else if (
    input.regime &&
    typeof input.regime === 'object' &&
    typeof input.regime.score === 'number' &&
    !isNaN(input.regime.score)
  ) {
    waterLevel = input.regime.score;
  }

  // Check if all inputs are missing / degraded
  const hasBreadth =
    breadth !== null &&
    breadth !== undefined &&
    typeof breadth.advancing === 'number' &&
    typeof breadth.declining === 'number';
  const hasInst =
    institutional !== null &&
    institutional !== undefined &&
    institutional.latest &&
    typeof institutional.latest.total === 'number';
  const hasWaterLevel = waterLevel !== null && !isNaN(waterLevel);

  if (!hasBreadth && !hasInst && !hasWaterLevel) {
    return {
      mood: 0,
      stance: 'neutral',
      headline: '資料不足',
      signals: [],
      degraded: true,
    };
  }

  // 1. breadth_score: up/(up+down)*2 - 1
  let breadthScore = 0;
  if (hasBreadth) {
    const up = breadth.advancing || 0;
    const down = breadth.declining || 0;
    const total = up + down;
    if (total > 0) {
      breadthScore = (up / total) * 2 - 1;
    }
  }

  // 2. inst_score: clamp(法人合計億 / 300, -1, 1)
  let instScore = 0;
  if (hasInst) {
    const instYi = (institutional.latest.total || 0) / 1e8;
    instScore = Math.max(-1, Math.min(1, instYi / 300));
  }

  // 3. level_score: water_level*2 - 1
  let levelScore = 0;
  if (hasWaterLevel && waterLevel !== null) {
    levelScore = Math.max(-1, Math.min(1, waterLevel * 2 - 1));
  }

  // 4. Mood calculation
  const rawMood = (0.4 * breadthScore + 0.3 * instScore + 0.3 * levelScore) * 100;
  const mood = Math.max(-100, Math.min(100, Math.round(rawMood)));

  // 5. Stance determination (≥+20 bull, ≤−20 bear, else neutral)
  let stance: 'bull' | 'neutral' | 'bear' = 'neutral';
  if (mood >= 20) {
    stance = 'bull';
  } else if (mood <= -20) {
    stance = 'bear';
  }

  // 6. Headline text
  const moodStr = mood >= 0 ? `+${mood}` : `${mood}`;
  let headline = `盤面氣氛中性 (${moodStr})`;
  if (stance === 'bull') {
    headline = `盤面氣氛偏多 (${moodStr})`;
  } else if (stance === 'bear') {
    headline = `盤面氣氛偏空 (${moodStr})`;
  }

  // 7. Signals construction (2–4 key signals)
  const signals: MarketSignal[] = [];

  // Signal 1: Breadth ratio
  if (hasBreadth) {
    const up = breadth.advancing || 0;
    const down = breadth.declining || 0;
    const total = up + down;
    if (total > 0) {
      const upPct = ((up / total) * 100).toFixed(1);
      if (up / total >= 0.6) {
        signals.push({
          text: `上漲 ${up} 家 (${upPct}%)，盤面偏多`,
          tone: 'bull',
        });
      } else if (up / total <= 0.4) {
        const downPct = ((down / total) * 100).toFixed(1);
        signals.push({
          text: `下跌 ${down} 家 (${downPct}%)，盤面偏空`,
          tone: 'bear',
        });
      } else {
        signals.push({
          text: `上漲 ${up} 家 / 下跌 ${down} 家 (${upPct}%)`,
          tone: 'neutral',
        });
      }
    }
  }

  // Signal 2: Institutional total
  if (hasInst) {
    const instYi = (institutional.latest.total || 0) / 1e8;
    const absYi = Math.abs(instYi).toFixed(1);
    if (Math.abs(instYi) >= 50) {
      if (instYi > 0) {
        signals.push({
          text: `三大法人合計買超 ${absYi} 億`,
          tone: 'bull',
        });
      } else {
        signals.push({
          text: `三大法人合計賣超 ${absYi} 億`,
          tone: 'bear',
        });
      }
    } else {
      signals.push({
        text: `三大法人金額平淡 (淨${instYi >= 0 ? '買' : '賣'}${absYi}億)`,
        tone: 'neutral',
      });
    }
  }

  // Signal 3: Limit up / down
  if (hasBreadth) {
    const limitUp = breadth.limit_up || 0;
    const limitDown = breadth.limit_down || 0;
    if (limitUp >= 20) {
      signals.push({
        text: `漲停 ${limitUp} 家，投機情緒熱`,
        tone: 'bull',
      });
    } else if (limitDown >= 20) {
      signals.push({
        text: `跌停 ${limitDown} 家，恐慌情緒高`,
        tone: 'bear',
      });
    } else if (limitUp > 0 || limitDown > 0) {
      signals.push({
        text: `漲停 ${limitUp} 家 / 跌停 ${limitDown} 家`,
        tone: 'neutral',
      });
    }
  }

  // Signal 4: Water level
  if (hasWaterLevel && waterLevel !== null) {
    const levelPct = Math.round(waterLevel * 100);
    if (waterLevel >= 0.7) {
      signals.push({
        text: `大盤水位高檔 (${levelPct}%)`,
        tone: 'bull',
      });
    } else if (waterLevel <= 0.3) {
      signals.push({
        text: `大盤水位低檔 (${levelPct}%)`,
        tone: 'bear',
      });
    } else {
      signals.push({
        text: `大盤水位中樞 (${levelPct}%)`,
        tone: 'neutral',
      });
    }
  }

  return {
    mood,
    stance,
    headline,
    signals: signals.slice(0, 4),
  };
}
