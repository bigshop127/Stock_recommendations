"""因子權重 / 門檻 / 成本「唯一設定物件」（階段 3）。

scoring-model §0.1、§4 與 dev-conventions §4 規定：
**權重是初始值、不寫死、不可散落在計算邏輯裡**——一律集中於此，回測網格挑出最佳後回填這裡。

內容：
- 波段三因子權重（technical/chips/sentiment）與各因子子訊號權重；
- 大盤環境 gate 的輸入權重與非對稱映射參數；
- action 門檻；
- 台股交易成本；
- 正規化視窗（滾動分位數）。

所有 dataclass 皆可由 `dataclasses.replace(...)` 覆寫 → 回測網格用。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace  # noqa: F401  (replace 供回測 import)


# ── 子訊號權重（各因子內部，加總=1）────────────────────────────────────────────
@dataclass(frozen=True)
class TechnicalSubWeights:
    ma_alignment: float = 0.30   # MA 多頭排列
    bias20: float = 0.15         # 乖離率（過熱扣分）
    volume: float = 0.20         # 量能配合
    rsi: float = 0.20            # RSI 動能
    three_red: float = 0.15      # 三陽開泰


@dataclass(frozen=True)
class ChipsSubWeights:
    foreign_streak: float = 0.35   # 外資連買
    trust_streak: float = 0.25     # 投信認養
    margin: float = 0.25           # 融資增減（乾淨度）
    short_squeeze: float = 0.15     # 券資比 / 軋空題材


@dataclass(frozen=True)
class SentimentSubWeights:
    news: float = 0.5            # 輕量新聞極性
    puhui: float = 0.5          # 老王訊號（可選，缺檔則退出重正規化）


# ── 波段三因子權重 ────────────────────────────────────────────────────────────
# v0 初始（scoring-model §1.1）：technical 0.40 / chips 0.40 / sentiment 0.20。
# v1 回填（2026-06-13 階段3 網格，標的 8 檔大型權值股、2024-06~2026-06）：
#   回測排除 sentiment、技術:籌碼最佳比 0.6:0.4 → 保留 sentiment 0.20、其餘按比 → 0.48/0.32/0.20。
#   ⚠️ 單一期間/標的可能過擬合，後續階段需多期/樣本外再驗證。
@dataclass(frozen=True)
class SwingWeights:
    technical: float = 0.48
    chips: float = 0.32
    sentiment: float = 0.20

    def as_dict(self) -> dict[str, float]:
        return {"technical": self.technical, "chips": self.chips, "sentiment": self.sentiment}


# ── 大盤環境 gate（scoring-model §1.2；非對稱分段線性，使用者 2026-06-13 定案）──
@dataclass(frozen=True)
class RegimeConfig:
    # 各環境子訊號 → [-1,+1] 後的加權（會對「可得子訊號」重正規化）
    w_index_trend: float = 0.30    # 0050/加權指數 站上 MA60
    w_foreign_fut: float = 0.25    # TAIFEX 外資期貨淨未平倉方向（A/D proxy 主力）
    w_pc_ratio: float = 0.15       # Put/Call ratio
    w_yield_curve: float = 0.15    # FRED 殖利率倒掛（需 key，缺則退出）
    w_vix: float = 0.15            # VIX（FRED 或 yfinance）
    # 非對稱映射：順風緩獎、逆風重罰（regime_score∈[-1,1] → gate∈[0.5,1.1]）
    gate_up_slope: float = 0.10    # score≥0：gate = 1.0 + 0.10·score → [1.0,1.1]
    gate_down_slope: float = 0.50   # score<0 ：gate = 1.0 + 0.50·score → [0.5,1.0]
    gate_floor: float = 0.5
    gate_cap: float = 1.1


# ── 當沖（佔位，階段3 後段 / 階段4 校準）──────────────────────────────────────
@dataclass(frozen=True)
class DaytradeWeights:
    orderbook: float = 0.45
    intraday_tech: float = 0.35
    market_today: float = 0.20


# ── action 門檻（scoring-model §1.3，回測可調）────────────────────────────────
@dataclass(frozen=True)
class ActionThresholds:
    buy: float = 75.0
    add_watch: float = 60.0
    hold: float = 45.0
    # 回測進出場（與 action 門檻分離，方便獨立網格）
    # v0 初始 75/45 → v1 回填（2026-06-13 網格最佳）70/40：進場稍降、出場放寬抱久一點吃趨勢。
    entry_score: float = 70.0
    exit_score: float = 40.0


# ── 台股交易成本（phase3 §4.4；round-trip≈0.45%）──────────────────────────────
@dataclass(frozen=True)
class CostConfig:
    fee_rate: float = 0.001425     # 手續費（單邊）
    fee_discount: float = 1.0      # 折數（1.0=不打折；如 5 折填 0.5）
    tax_rate: float = 0.003        # 賣出證交稅（單邊）

    @property
    def buy_cost(self) -> float:
        return self.fee_rate * self.fee_discount

    @property
    def sell_cost(self) -> float:
        return self.fee_rate * self.fee_discount + self.tax_rate

    @property
    def round_trip(self) -> float:
        return self.buy_cost + self.sell_cost


# ── 正規化（滾動分位數為主，使用者 2026-06-13 定案）──────────────────────────
@dataclass(frozen=True)
class NormalizeConfig:
    window: int = 252          # 分位數視窗（約一年交易日）
    min_periods: int = 20      # 視窗未滿時的最低樣本（不足回中性 50）


# ── 頂層設定（單一事實來源）──────────────────────────────────────────────────
@dataclass(frozen=True)
class FactorConfig:
    swing: SwingWeights = field(default_factory=SwingWeights)
    technical_sub: TechnicalSubWeights = field(default_factory=TechnicalSubWeights)
    chips_sub: ChipsSubWeights = field(default_factory=ChipsSubWeights)
    sentiment_sub: SentimentSubWeights = field(default_factory=SentimentSubWeights)
    regime: RegimeConfig = field(default_factory=RegimeConfig)
    daytrade: DaytradeWeights = field(default_factory=DaytradeWeights)
    thresholds: ActionThresholds = field(default_factory=ActionThresholds)
    cost: CostConfig = field(default_factory=CostConfig)
    normalize: NormalizeConfig = field(default_factory=NormalizeConfig)


# 預設設定物件（v0 初始權重；回測最佳化後回填此處）
DEFAULT_CONFIG = FactorConfig()
