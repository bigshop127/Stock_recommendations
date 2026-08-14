"""螢幕擷取 + 盤面辨識。

辨識刻意不用 OCR。模擬器每次把同一顆水果畫出來的像素幾乎完全一樣，
所以「把每格縮成小圖跟已標記過的樣板比最近鄰」比 OCR 準得多、也不用裝 Tesseract。
代價是第一次要人工標一輪（約 10 次點擊），之後樣板存在 templates.json 裡永久沿用。

特徵設計是拿使用者的真實截圖實測調出來的（見 README 的「辨識調校紀錄」）：

  * 特徵 = [整格縮圖] + [號碼徽章區域縮圖]。只看整格的話蘋果(1) 跟橘子(2) 都是圓形紅橘色
    水果，區隔度只有 9.9；把徽章那一小塊也放進特徵，區隔度拉到 15.8。
  * 每塊各自「減掉自己的色版平均值」。不做這件事的話，畫面亮度 +30 就會讓 16 格錯 5 格；
    做了之後同樣條件下距離只有 5.6、零誤判。
  * 這組特徵對位移很敏感（差 2px 距離就跳到 16）。這是刻意的：校準漂掉時寧可大聲說
    「認不得」要求重新吸附，也不要默默讀出一個錯的盤面去給建議。
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

# 縮圖邊長。整格與徽章各一塊，所以原始特徵長度是 THUMB*THUMB*3*2。
THUMB = 16
BLOCK = THUMB * THUMB * 3
RAW_LEN = BLOCK * 2

# 號碼徽章在一格裡的相對位置（左, 上, 右, 下），量自實際遊戲畫面
BADGE_BOX = (0.28, 0.62, 0.72, 1.00)

# 平均每通道差異超過這個值就當作「不認得」。
# 穩態（含 ±12 雜訊、±30 亮度、±4% 縮放）最差是 3.7，位移 2px 是 16.5，所以 12 兩邊都留了餘裕。
DEFAULT_TOLERANCE = 12.0
# 最佳與「最接近的不同標籤」差距小於這個值就視為分不清，一樣當作不認得。
# 穩態的差距有 13~16，位移 5px 以上會掉到 1 以下，正好卡在誤判開始出現的地方。
DEFAULT_MIN_MARGIN = 2.5
# 兩張連續畫面的平均差異低於這個值，才視為合成動畫已播完、盤面可信
STABLE_TOLERANCE = 3.0


# ---------------------------------------------------------------- 螢幕擷取

class Region(NamedTuple):
    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height

    def to_dict(self) -> Dict[str, int]:
        return {"left": self.left, "top": self.top, "width": self.width, "height": self.height}

    @classmethod
    def from_dict(cls, d: Dict[str, int]) -> "Region":
        return cls(int(d["left"]), int(d["top"]), int(d["width"]), int(d["height"]))

    def expanded(self, pad: int) -> "Region":
        return Region(self.left - pad, self.top - pad, self.width + 2 * pad, self.height + 2 * pad)


class ScreenGrabber:
    """包一層 mss，沒裝就退回 Pillow 的 ImageGrab。"""

    def __init__(self) -> None:
        self._backend = "PIL"
        self._mss_mod = None
        try:
            import mss

            self._mss_mod = mss
            self._backend = "mss"
        except ImportError:
            pass

    @property
    def backend(self) -> str:
        return self._backend

    def virtual_screen(self) -> Region:
        """整個虛擬桌面的範圍（含多螢幕）。校準用。"""
        if self._backend == "mss":
            with self._mss_mod.mss() as sct:
                m = sct.monitors[0]
                return Region(m["left"], m["top"], m["width"], m["height"])
        from PIL import ImageGrab

        img = ImageGrab.grab(all_screens=True)
        return Region(0, 0, img.width, img.height)

    def grab(self, region: Region) -> np.ndarray:
        """回傳 (H, W, 3) 的 uint8 RGB 陣列。"""
        if region.width <= 0 or region.height <= 0:
            raise ValueError(f"擷取範圍不合法：{region}")

        if self._backend == "mss":
            # mss 的 instance 綁執行緒，所以每次抓都開一個（成本很低）
            with self._mss_mod.mss() as sct:
                raw = sct.grab(region.to_dict())
                arr = np.frombuffer(raw.rgb, dtype=np.uint8)
                return arr.reshape(raw.height, raw.width, 3)

        from PIL import ImageGrab

        bbox = (region.left, region.top, region.right, region.bottom)
        return np.asarray(ImageGrab.grab(bbox=bbox, all_screens=True).convert("RGB"))


# ---------------------------------------------------------------- 格線自動吸附

AUTOFIT_PAD = 0.15  # autofit 前建議先把擷取範圍外擴的比例


def _profiles(gray: np.ndarray, axis: int) -> Tuple[np.ndarray, np.ndarray]:
    """回傳沿某個方向的 (邊緣能量, 亮度) 兩條曲線。

    只取畫面中央 60% 的帶狀區域來平均，避免使用者框進來的背景風景與外框裝飾
    在曲線上製造假訊號。
    """
    h, w = gray.shape
    if axis == 0:  # 找垂直格線
        band = gray[int(h * 0.20):int(h * 0.80) or h, :]
        return np.abs(np.diff(band, axis=1)).mean(axis=0), band.mean(axis=0)
    band = gray[:, int(w * 0.20):int(w * 0.80) or w]
    return np.abs(np.diff(band, axis=0)).mean(axis=1), band.mean(axis=1)


def _estimate_pitch(edge: np.ndarray, n: int, length: int) -> float:
    """用邊緣能量的自相關量出格子的週期。"""
    lo = max(4, int(length / (n + 2.5)))
    hi = max(lo + 1, int(length / n))
    q = (edge - edge.mean()).astype(np.float64)
    best_v, best_lag = -np.inf, float(lo)
    for lag in range(lo, hi + 1):
        if lag >= len(q):
            break
        v = float(np.dot(q[:-lag], q[lag:])) / (len(q) - lag)
        if v > best_v:
            best_v, best_lag = v, float(lag)
    return best_lag


def _fit_axis(edge: np.ndarray, bright: np.ndarray, n: int, length: int) -> Tuple[float, float]:
    """回傳 (起點, 格距)。週期靠邊緣能量，相位靠亮度。

    這兩件事必須用不同訊號，是實測逼出來的結論：

      * 週期用邊緣能量的自相關最穩，因為它吃進整條曲線的週期性，不受個別高峰影響。
      * 相位絕對不能用邊緣能量。每條縫在邊緣能量上是「一對」高峰（縫的左緣與右緣
        各一個格子邊框），梳齒會被吸到其中一緣去，實測固定偏掉半條縫寬（約 12px）。
        改用亮度就準了：縫是暗的、格子中心是亮的，「中心亮度 − 格線亮度」在正確的
        相位上會有明確最大值，實測 12 組隨便框的範圍有 10 組誤差 ≤1px。
    """
    pitch0 = _estimate_pitch(edge, n, length)
    sm = np.convolve(bright, np.ones(3, dtype=np.float32) / 3, mode="same")
    limit = len(sm) - 1

    line_off_k = np.arange(n + 1)
    center_off_k = np.arange(n) + 0.5

    best: Optional[Tuple[float, float, float]] = None
    pitch = pitch0 * 0.92
    while pitch <= pitch0 * 1.08:
        span = n * pitch
        if span <= length:
            lines = line_off_k * pitch
            centers = center_off_k * pitch
            for start in range(0, int(length - span) + 1):
                li = np.clip(np.round(start + lines).astype(np.intp), 0, limit)
                ci = np.clip(np.round(start + centers).astype(np.intp), 0, limit)
                score = float(sm[ci].mean() - sm[li].mean())
                if best is None or score > best[0]:
                    best = (score, float(start), pitch)
        pitch += 0.25

    if best is None:
        return 0.0, length / n
    return best[1], best[2]


def autofit(img: np.ndarray, rows: int = 4, cols: int = 4) -> Optional[Region]:
    """在一塊「大致框住盤面」的畫面裡，把格線吸附到真正的格子邊界。

    回傳的 Region 是相對於傳進來這張圖的座標（不是螢幕座標）。

    重要：傳進來的畫面必須「比盤面大」，四周要留白（用 AUTOFIT_PAD 外擴即可）。
    如果框得比盤面還緊，正解根本不在搜尋空間裡，會吸到明顯錯誤的位置。
    """
    if img.ndim != 3 or img.shape[0] < rows * 12 or img.shape[1] < cols * 12:
        return None
    gray = img.mean(axis=2)
    h, w = gray.shape

    edge_x, bright_x = _profiles(gray, 0)
    edge_y, bright_y = _profiles(gray, 1)
    x0, px = _fit_axis(edge_x, bright_x, cols, w)
    y0, py = _fit_axis(edge_y, bright_y, rows, h)

    left = max(0, int(round(x0)))
    top = max(0, int(round(y0)))
    width = int(round(px * cols))
    height = int(round(py * rows))
    if width < cols * 12 or height < rows * 12:
        return None
    return Region(left, top, min(width, w - left), min(height, h - top))


def autofit_screen(
    grabber: "ScreenGrabber",
    rough: Region,
    rows: int = 4,
    cols: int = 4,
    screen: Optional[Region] = None,
) -> Optional[Region]:
    """從使用者隨手框的螢幕範圍吸附出精確的盤面範圍（回傳螢幕座標）。

    會先把範圍外擴一圈再抓圖，因為 autofit 需要盤面四周留白才吸得準。
    """
    pad = max(8, int(AUTOFIT_PAD * max(rough.width, rough.height)))
    padded = rough.expanded(pad)
    if screen is not None:  # 不要抓到桌面範圍外
        left = max(screen.left, padded.left)
        top = max(screen.top, padded.top)
        padded = Region(left, top,
                        min(padded.right, screen.right) - left,
                        min(padded.bottom, screen.bottom) - top)
    if padded.width <= 0 or padded.height <= 0:
        return None

    fit = autofit(grabber.grab(padded), rows, cols)
    if fit is None:
        return None
    return Region(padded.left + fit.left, padded.top + fit.top, fit.width, fit.height)


# ---------------------------------------------------------------- 從四個角落算盤面

class Calibration(NamedTuple):
    region: Region
    inset: float     # 依「使用者框出來的一格有多大」反推的取樣內縮比例
    pitch_x: float
    pitch_y: float
    skew: float      # 上下（或左右）兩側量到的格距差多少 px，越大代表點歪了


def calibration_from_corners(
    top_left_box: Region,
    top_right: Tuple[int, int],
    bottom_right: Tuple[int, int],
    bottom_left: Tuple[int, int],
    rows: int = 4,
    cols: int = 4,
) -> Calibration:
    """用「左上那一格的框」＋「其餘三個角落格子的中心點」算出整個盤面。

    比「一次框住整個盤面」好對的原因：盤面外緣是裝飾外框，邊界本來就模糊；
    但每一格的中心點是眼睛一看就知道的，而且四個角落各量一次還能互相校正。

    top_left_box 提供兩件事：左上格的中心（定位用），以及一格實際有多大
    （拿來反推 inset —— 格距扣掉格線與間隙之後，真正該取樣的範圍有多寬）。
    """
    if rows < 2 or cols < 2:
        raise ValueError("盤面至少要 2x2")

    tl = (top_left_box.left + top_left_box.width / 2.0,
          top_left_box.top + top_left_box.height / 2.0)
    tr = (float(top_right[0]), float(top_right[1]))
    br = (float(bottom_right[0]), float(bottom_right[1]))
    bl = (float(bottom_left[0]), float(bottom_left[1]))

    # 上下兩排各量一次水平格距，左右兩排各量一次垂直格距
    pitch_x_top = (tr[0] - tl[0]) / (cols - 1)
    pitch_x_bottom = (br[0] - bl[0]) / (cols - 1)
    pitch_y_left = (bl[1] - tl[1]) / (rows - 1)
    pitch_y_right = (br[1] - tr[1]) / (rows - 1)

    if min(pitch_x_top, pitch_x_bottom, pitch_y_left, pitch_y_right) <= 0:
        raise ValueError(
            "四個角落的相對位置不合理（右邊的點在左邊、或下面的點在上面）。"
            "請確認有依照「右上 → 右下 → 左下」的順序點選。"
        )

    pitch_x = (pitch_x_top + pitch_x_bottom) / 2.0
    pitch_y = (pitch_y_left + pitch_y_right) / 2.0
    skew = max(abs(pitch_x_top - pitch_x_bottom), abs(pitch_y_left - pitch_y_right))

    # 第 0 行的中心 x 取「左上、左下」平均；第 0 列的中心 y 取「左上、右上」平均
    center_x0 = (tl[0] + bl[0]) / 2.0
    center_y0 = (tl[1] + tr[1]) / 2.0

    region = Region(
        int(round(center_x0 - pitch_x / 2.0)),
        int(round(center_y0 - pitch_y / 2.0)),
        int(round(pitch_x * cols)),
        int(round(pitch_y * rows)),
    )

    # 取樣範圍要貼齊使用者框出來的那一格：格距減掉格子本身，兩邊各留一半
    inset_x = (1.0 - top_left_box.width / pitch_x) / 2.0
    inset_y = (1.0 - top_left_box.height / pitch_y) / 2.0
    inset = min(0.30, max(0.04, (inset_x + inset_y) / 2.0))

    return Calibration(region, inset, pitch_x, pitch_y, skew)


# ---------------------------------------------------------------- 切格與特徵

class Grid(NamedTuple):
    rows: int = 4
    cols: int = 4
    inset: float = 0.10  # 每格四邊各往內縮的比例，用來吃掉格線與微小的校準誤差

    @property
    def size(self) -> int:
        return self.rows * self.cols

    def cell_boxes(self, width: int, height: int) -> List[Tuple[int, int, int, int]]:
        """回傳每格的 (x0, y0, x1, y1)，列優先。"""
        boxes = []
        for r in range(self.rows):
            for c in range(self.cols):
                x0 = c * width / self.cols
                x1 = (c + 1) * width / self.cols
                y0 = r * height / self.rows
                y1 = (r + 1) * height / self.rows
                dx = (x1 - x0) * self.inset
                dy = (y1 - y0) * self.inset
                boxes.append((
                    int(round(x0 + dx)), int(round(y0 + dy)),
                    int(round(x1 - dx)), int(round(y1 - dy)),
                ))
        return boxes

    def crops(self, img: np.ndarray) -> List[np.ndarray]:
        h, w = img.shape[:2]
        return [img[y0:y1, x0:x1] for x0, y0, x1, y1 in self.cell_boxes(w, h)]


def _resize_block(crop: np.ndarray) -> np.ndarray:
    if crop.size == 0 or crop.shape[0] < 2 or crop.shape[1] < 2:
        return np.zeros(BLOCK, dtype=np.uint8)
    small = Image.fromarray(crop).resize((THUMB, THUMB), Image.BILINEAR)
    return np.asarray(small, dtype=np.uint8).reshape(-1)


def raw_feature(crop: np.ndarray) -> np.ndarray:
    """一格 → uint8 原始特徵（前半是整格縮圖，後半是號碼徽章縮圖）。

    存進 templates.json 的就是這個原始版本，方便日後改正規化方式而不用重標。
    """
    h, w = crop.shape[:2] if crop.ndim >= 2 else (0, 0)
    if h < 2 or w < 2:
        return np.zeros(RAW_LEN, dtype=np.uint8)
    bl, bt, br, bb = BADGE_BOX
    badge = crop[int(h * bt):int(h * bb), int(w * bl):int(w * br)]
    return np.concatenate([_resize_block(crop), _resize_block(badge)])


def normalize(raw: np.ndarray) -> np.ndarray:
    """把原始特徵轉成比對用的向量：兩塊各自減掉自己的色版平均值。

    這一步讓比對不受畫面整體亮度 / 色偏影響（實測亮度 +30 的誤判從 5 格降到 0 格）。
    """
    a = np.asarray(raw, dtype=np.float32).reshape(2, THUMB, THUMB, 3)
    a = a - a.mean(axis=(1, 2), keepdims=True)
    return a.reshape(-1)


# ---------------------------------------------------------------- 樣板庫

class Match(NamedTuple):
    label: Optional[int]   # 辨識出的指數；0 = 空格；None = 不認得
    distance: float        # 與最近樣板的平均通道差異
    margin: float          # 與「最接近的不同標籤」差多少，越大越有把握
    rejected: str = ""     # 認不得的原因："" / "distance" / "margin" / "empty"


class TemplateDB:
    """已標記過的格子樣板。同一個標籤可以有多張（例如水果待機動畫的不同幀）。"""

    VERSION = 2

    def __init__(
        self,
        tolerance: float = DEFAULT_TOLERANCE,
        min_margin: float = DEFAULT_MIN_MARGIN,
    ) -> None:
        self.tolerance = tolerance
        self.min_margin = min_margin
        self._labels: List[int] = []
        self._raw: List[np.ndarray] = []
        self._matrix: Optional[np.ndarray] = None  # (N, D) float32 正規化後的快取

    def __len__(self) -> int:
        return len(self._labels)

    @property
    def labels(self) -> List[int]:
        return sorted(set(self._labels))

    def count_for(self, label: int) -> int:
        return sum(1 for x in self._labels if x == label)

    def _matrix_or_build(self) -> Optional[np.ndarray]:
        if not self._raw:
            return None
        if self._matrix is None:
            self._matrix = np.stack([normalize(r) for r in self._raw])
        return self._matrix

    def add(self, label: int, raw: np.ndarray, dedup: float = 4.0) -> bool:
        """加一張樣板。跟同標籤的既有樣板太像就跳過，避免樣板庫無限膨脹。"""
        raw = np.asarray(raw, dtype=np.uint8).reshape(-1)
        if raw.size != RAW_LEN:
            raise ValueError(f"特徵長度應為 {RAW_LEN}，收到 {raw.size}")
        vec = normalize(raw)
        for lbl, existing in zip(self._labels, self._raw):
            if lbl == label and float(np.abs(normalize(existing) - vec).mean()) < dedup:
                return False
        self._labels.append(int(label))
        self._raw.append(raw)
        self._matrix = None
        return True

    def remove_label(self, label: int) -> int:
        keep = [i for i, l in enumerate(self._labels) if l != label]
        removed = len(self._labels) - len(keep)
        self._labels = [self._labels[i] for i in keep]
        self._raw = [self._raw[i] for i in keep]
        self._matrix = None
        return removed

    def clear(self) -> None:
        self._labels.clear()
        self._raw.clear()
        self._matrix = None

    def match(self, raw: np.ndarray) -> Match:
        matrix = self._matrix_or_build()
        if matrix is None:
            return Match(None, float("inf"), 0.0, "empty")

        v = normalize(raw).reshape(1, -1)
        dists = np.abs(matrix - v).mean(axis=1)
        order = np.argsort(dists)

        best_i = int(order[0])
        best_label = self._labels[best_i]
        best_d = float(dists[best_i])

        # 找出第一個「標籤不同」的競爭者，算出把握程度
        margin = float("inf")
        for i in order[1:]:
            if self._labels[int(i)] != best_label:
                margin = float(dists[int(i)]) - best_d
                break

        if best_d > self.tolerance:
            return Match(None, best_d, margin, "distance")
        if margin < self.min_margin:
            return Match(None, best_d, margin, "margin")
        return Match(best_label, best_d, margin)

    # -- 存檔 --
    def save(self, path: str) -> None:
        data = {
            "version": self.VERSION,
            "thumb": THUMB,
            "badge_box": list(BADGE_BOX),
            "tolerance": self.tolerance,
            "min_margin": self.min_margin,
            "templates": [
                {"label": lbl, "px": raw.tolist()}
                for lbl, raw in zip(self._labels, self._raw)
            ],
        }
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)

    @classmethod
    def load(
        cls,
        path: str,
        tolerance: float = DEFAULT_TOLERANCE,
        min_margin: float = DEFAULT_MIN_MARGIN,
    ) -> "TemplateDB":
        db = cls(tolerance, min_margin)
        if not os.path.exists(path):
            return db
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return db
        # 特徵的形狀變過就整批作廢，寧可重標也不要拿舊樣板去比新特徵
        if data.get("thumb") != THUMB or list(data.get("badge_box", [])) != list(BADGE_BOX):
            return db
        db.tolerance = float(data.get("tolerance", tolerance))
        db.min_margin = float(data.get("min_margin", min_margin))
        for item in data.get("templates", []):
            px = np.asarray(item["px"], dtype=np.uint8)
            if px.size == RAW_LEN:
                db._labels.append(int(item["label"]))
                db._raw.append(px)
        db._matrix = None
        return db


# ---------------------------------------------------------------- 辨識

class Reading(NamedTuple):
    cells: List[Optional[int]]      # 每格的指數，None = 不認得
    matches: List[Match]
    crops: List[np.ndarray]
    ok: bool                        # 全部格子都認得
    unknown_indices: List[int]

    @property
    def board_cells(self) -> List[int]:
        """把 None 當空格。只有 ok=True 時才該拿去餵求解器。"""
        return [c if c is not None else 0 for c in self.cells]

    @property
    def looks_misaligned(self) -> bool:
        """一次冒出一大票不認得 → 多半是校準漂掉，而不是同時出現好幾種新水果。"""
        return len(self.unknown_indices) >= max(3, len(self.cells) // 2)


class Recognizer:
    def __init__(self, grid: Grid, db: TemplateDB) -> None:
        self.grid = grid
        self.db = db

    def read(self, img: np.ndarray) -> Reading:
        crops = self.grid.crops(img)
        cells: List[Optional[int]] = []
        matches: List[Match] = []
        unknown: List[int] = []
        for i, crop in enumerate(crops):
            m = self.db.match(raw_feature(crop))
            matches.append(m)
            cells.append(m.label)
            if m.label is None:
                unknown.append(i)
        return Reading(cells, matches, crops, not unknown, unknown)

    def learn(self, crops: Sequence[np.ndarray], labels: Sequence[Optional[int]]) -> int:
        """把使用者標好的格子收進樣板庫，回傳實際新增的張數。"""
        added = 0
        for crop, label in zip(crops, labels):
            if label is None:
                continue
            if self.db.add(int(label), raw_feature(crop)):
                added += 1
        return added


def frame_difference(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> float:
    """兩張畫面的平均像素差異。用來判斷合成動畫是否已經播完。"""
    if a is None or b is None or a.shape != b.shape:
        return float("inf")
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())


__all__ = [
    "Region", "ScreenGrabber", "Grid", "TemplateDB", "Recognizer",
    "Match", "Reading", "raw_feature", "normalize", "frame_difference",
    "autofit", "autofit_screen", "AUTOFIT_PAD",
    "Calibration", "calibration_from_corners",
    "THUMB", "RAW_LEN", "BADGE_BOX",
    "DEFAULT_TOLERANCE", "DEFAULT_MIN_MARGIN", "STABLE_TOLERANCE",
]
