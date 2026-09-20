"""螢幕擷取 + 寶石盤面辨識：畫面 → 管子位置 → 每格內容 → 顏色分群。

跟水果2048／永夜迷城同一個精神：只認像素、寧可說「認不得」也不亂猜。

這個遊戲的畫面特徵（用使用者給的真實截圖量出來的）：
  * 每根管子有兩道又細又長的亮線（管壁），長度約是管寬的 2.2 倍；底座在管壁下端。
    所以**「找垂直方向連續很長的高亮度線」就能找出所有管子**，不管有幾根、排成幾排、
    畫面縮放多少——第 1-2 關 5+5 根、1-3 關 4+3 根、2-1 關 7+7 根都用同一套。
  * 管壁顏色分管子種類：金色＝一般管、粉白＝固定管（只進不出）、淡藍＝藍罐（解鎖前不能動）。
  * 寶石從管底往上疊，格距≈0.64 倍管寬、最底下一格中心離管壁下端≈0.53 倍管寬。
    所有幾何量都用「管寬」當單位，所以解析度／視窗大小不影響。
  * 「顏色」只需要分得出「誰跟誰是同一種」——求解器不在乎叫什麼名字。
"""

from __future__ import annotations

import colorsys
import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, NamedTuple, Optional, Tuple

import numpy as np
from PIL import Image


# ---------------------------------------------------------------- 螢幕擷取（沿用永夜迷城那套）

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


class ScreenGrabber:
    """包一層 mss，沒裝就退回 Pillow 的 ImageGrab。"""

    def __init__(self) -> None:
        self._backend = "PIL"
        self._mss_factory = None
        try:
            import mss

            # mss 10 起 mss.mss() 標示棄用、改叫 mss.MSS()；舊版沒有 MSS，兩邊都要能用
            self._mss_factory = getattr(mss, "MSS", None) or mss.mss
            self._backend = "mss"
        except ImportError:
            pass

    @property
    def backend(self) -> str:
        return self._backend

    def grab(self, region: Region) -> np.ndarray:
        """回傳 (H, W, 3) 的 uint8 RGB 陣列。"""
        if region.width <= 0 or region.height <= 0:
            raise ValueError(f"擷取範圍不合法：{region}")
        if self._backend == "mss":
            with self._mss_factory() as sct:
                raw = sct.grab(region.to_dict())
                arr = np.frombuffer(raw.rgb, dtype=np.uint8)
                return arr.reshape(raw.height, raw.width, 3)
        from PIL import ImageGrab

        bbox = (region.left, region.top, region.right, region.bottom)
        return np.asarray(ImageGrab.grab(bbox=bbox, all_screens=True).convert("RGB"))


# ---------------------------------------------------------------- 幾何常數（單位＝管寬 w）

SLOT0_OFFSET = 0.53      # 最底下一格中心 = 管壁下端 y1 - 0.53w
SLOT_PITCH = 0.64        # 相鄰兩格中心距
WALL_LEN_RATIO = 2.2     # 亮線（管壁）長度 ≈ 2.2w
WALL_RATIO_MIN, WALL_RATIO_MAX = 1.6, 2.8   # 偵測到的「管子」長寬比容許範圍，超出就當假的
PATCH_HALF_W = 0.20      # 取樣小塊：中心 ± 0.20w 寬
PATCH_HALF_H = 0.20      #            中心 ± 0.20w 高

WALL_THRESH = 0.80       # 管壁亮度門檻（V 通道）
WALL_MIN_FRAC = 0.09     # 亮線最短長度 = 畫面高 * 這個比例


class Tube(NamedTuple):
    cx: float        # 管中心 x
    w: float         # 管寬（兩道管壁中心距）
    y1: float        # 管壁下端 y（≈ 底座上緣）
    row: int         # 第幾排（0 起，由上而下）
    col: int         # 該排第幾根（0 起，由左而右）
    kind: str        # normal / fixed / jar
    wall_len: float  # 偵測到的亮線長度（診斷用）

    def slot_center(self, k: int) -> Tuple[float, float]:
        """第 k 格（0＝最底下）中心座標。"""
        return self.cx, self.y1 - (SLOT0_OFFSET + SLOT_PITCH * k) * self.w

    def click_point(self) -> Tuple[float, float]:
        """點這根管子要點的位置：管子中段（第 2 格）——跟裡面有沒有寶石無關，點到管身就會選到。"""
        return self.slot_center(1)


# ---------------------------------------------------------------- 管子偵測

def _rgb01(img: np.ndarray) -> np.ndarray:
    return np.asarray(img, dtype=np.float32) / 255.0


def _vertical_runs(mask: np.ndarray) -> np.ndarray:
    """每個像素 → 以它為終點、向上連續為 True 的長度。"""
    h, w = mask.shape
    run = np.zeros((h, w), dtype=np.int32)
    cur = np.zeros(w, dtype=np.int32)
    for y in range(h):
        cur = np.where(mask[y], cur + 1, 0)
        run[y] = cur
    return run


def _cluster_1d(values: List[float], gap: float) -> List[List[int]]:
    """把數值排序後，相鄰差 ≤ gap 的歸成一群，回傳每群的原始索引。"""
    order = sorted(range(len(values)), key=lambda i: values[i])
    groups: List[List[int]] = []
    for i in order:
        if groups and values[i] - values[groups[-1][-1]] <= gap:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


@dataclass
class _Wall:
    x: float
    y1: float
    length: int


def find_walls(img: np.ndarray, thresh: float = WALL_THRESH, min_frac: float = WALL_MIN_FRAC) -> List[_Wall]:
    """找出所有「垂直長亮線」（管壁候選），每道回傳 (x, 下端 y, 長度)。"""
    a = _rgb01(img)
    h, w = a.shape[:2]
    v = a.max(axis=2)
    run = _vertical_runs(v > thresh)
    lmin = max(12, int(h * min_frac))
    nxt = np.zeros_like(run)
    nxt[:-1] = run[1:]
    ys, xs = np.nonzero((run >= lmin) & (nxt == 0))
    if len(xs) == 0:
        return []
    segs = [(int(x), int(y), int(run[y, x])) for y, x in zip(ys, xs)]   # (x, y_end, length)

    # 先依 x 分群（管壁是好幾條相鄰欄位），每群再依 y_end 分排（上排/下排同 x）
    xg = _cluster_1d([s[0] for s in segs], gap=max(3.0, w * 0.004))
    walls: List[_Wall] = []
    for g in xg:
        members = [segs[i] for i in g]
        yg = _cluster_1d([m[1] for m in members], gap=max(6.0, h * 0.025))
        for gi in yg:
            part = [members[i] for i in gi]
            longest = max(p[2] for p in part)
            good = [p for p in part if p[2] >= longest * 0.6]
            wx = float(np.average([p[0] for p in good], weights=[p[2] for p in good]))
            y1 = float(np.median([p[1] for p in good]))
            walls.append(_Wall(wx, y1, longest))
    return walls


def _wall_kind(img: np.ndarray, x: float, y1: float, length: int) -> str:
    """看管壁顏色分管子種類：金色 normal / 粉白 fixed / 淡藍 jar。"""
    h, w = img.shape[:2]
    xi = int(round(x))
    y_lo = max(0, int(y1 - length * 0.9))
    y_hi = min(h, int(y1) + 1)
    x_lo, x_hi = max(0, xi - 2), min(w, xi + 3)
    patch = _rgb01(img[y_lo:y_hi, x_lo:x_hi]).reshape(-1, 3)
    bright = patch[patch.max(axis=1) > 0.75]
    if len(bright) == 0:
        return "normal"
    r, g, b = bright.mean(axis=0)
    hue, sat, _ = colorsys.rgb_to_hsv(float(r), float(g), float(b))
    hue *= 360.0
    if b > r + 0.02 and b >= g - 0.02 and 170 <= hue <= 260:
        return "jar"
    if sat < 0.30 and r >= g and r >= b * 0.98 and (hue >= 300 or hue <= 20):
        return "fixed"
    return "normal"


def _detect_tubes_at(img: np.ndarray, thresh: float, min_frac: float) -> List[Tube]:
    walls = find_walls(img, thresh, min_frac)
    if len(walls) < 2:
        return []
    h = img.shape[0]

    # 去掉太長（畫面外框）跟太短（雜訊）的：以「最多人共有的長度」當基準
    lens = np.array([wl.length for wl in walls], dtype=np.float32)
    lg = _cluster_1d(list(lens), gap=max(6.0, float(np.median(lens)) * 0.12))
    best = max(lg, key=len)
    base_len = float(np.median(lens[best]))
    walls = [wl for wl in walls if 0.6 * base_len <= wl.length <= 1.3 * base_len]
    if len(walls) < 2:
        return []

    # 依 y1 分排
    rg = _cluster_1d([wl.y1 for wl in walls], gap=max(8.0, h * 0.04))
    rows: List[List[_Wall]] = [sorted([walls[i] for i in g], key=lambda wl: wl.x) for g in rg]
    rows.sort(key=lambda r: np.mean([wl.y1 for wl in r]))

    # 管寬：管壁長度 ≈ 2.2 倍管寬（幾何先驗），據此只看「距離落在預期管寬附近」的管壁對，
    # 再取出現最多次的那一群——中間夾了雜訊亮線（縮小/模糊後常見）也不會影響。
    w0 = base_len / WALL_LEN_RATIO
    dists: List[float] = []
    for r in rows:
        for i in range(len(r)):
            for j in range(i + 1, len(r)):
                d = r[j].x - r[i].x
                if d > 1.3 * w0:
                    break
                if d >= 0.75 * w0:
                    dists.append(d)
    if not dists:
        return []
    dg = _cluster_1d(dists, gap=max(2.0, w0 * 0.08))
    tube_w = float(np.mean([dists[i] for i in max(dg, key=len)]))

    tubes: List[Tube] = []
    for ri, r in enumerate(rows):
        i, col = 0, 0
        while i < len(r) - 1:
            # 從 i 往右找「距離最接近管寬」的管壁配成一對，中間夾的落單線（雜訊）直接跳過
            best_j, best_err = -1, tube_w * 0.12
            for j in range(i + 1, len(r)):
                d = r[j].x - r[i].x
                if d > tube_w * 1.12:
                    break
                if abs(d - tube_w) <= best_err:
                    best_j, best_err = j, abs(d - tube_w)
            if best_j < 0:
                i += 1
                continue
            a, b = r[i], r[best_j]
            d = b.x - a.x
            wall_len = (a.length + b.length) / 2
            kind = _wall_kind(img, a.x, a.y1, a.length)
            if _wall_kind(img, b.x, b.y1, b.length) == "jar":
                kind = "jar"
            i = best_j + 1
            if not (WALL_RATIO_MIN <= wall_len / d <= WALL_RATIO_MAX):
                continue    # 長寬比不像管子（例如結算畫面上的裝飾線）→ 丟掉
            tubes.append(Tube(cx=(a.x + b.x) / 2, w=d, y1=(a.y1 + b.y1) / 2,
                              row=ri, col=col, kind=kind, wall_len=wall_len))
            col += 1
    # 排號重編成連續的 0,1,2…（中間有排被整個丟掉時不留空洞）
    used = sorted({t.row for t in tubes})
    remap = {r: i for i, r in enumerate(used)}
    return [t._replace(row=remap[t.row]) for t in tubes]


def _layout_score(tubes: List[Tube]) -> float:
    """偵測結果像不像一個合理的管子排列：管子多、寬度一致、同排等距——越像分數越高。"""
    if len(tubes) < 2:
        return -1.0
    widths = np.array([t.w for t in tubes])
    score = float(len(tubes))
    score -= 10.0 * float(np.std(widths) / np.mean(widths))          # 寬度不一致扣分
    rows: Dict[int, List[float]] = {}
    for t in tubes:
        rows.setdefault(t.row, []).append(t.cx)
    for xs in rows.values():
        if len(xs) >= 3:
            gaps = np.diff(sorted(xs))
            score -= 5.0 * float(np.std(gaps) / np.mean(gaps))       # 同排間距不等距扣分
    return score


# 亮度門檻／最短長度的嘗試順序：第一組是用真實截圖調好的，其餘是「畫面偏亮/偏暗/縮很小」時的備案
_DETECT_TRIES = ((WALL_THRESH, WALL_MIN_FRAC), (0.88, WALL_MIN_FRAC), (0.72, WALL_MIN_FRAC),
                 (0.93, WALL_MIN_FRAC), (0.64, WALL_MIN_FRAC), (WALL_THRESH, 0.05), (0.88, 0.05),
                 (0.72, 0.05), (WALL_THRESH, 0.03))


def detect_tubes(img: np.ndarray) -> List[Tube]:
    """從畫面找出所有管子（沒找到回空清單）。

    先用調好的參數；結果不像合理的管子排列就換一組亮度門檻再試（畫面偏亮、偏暗、模糊時），
    全部試完取最像的那組。"""
    best: List[Tube] = []
    best_score = -1.0
    for thresh, frac in _DETECT_TRIES:
        tubes = _detect_tubes_at(img, thresh, frac)
        score = _layout_score(tubes)
        if score > best_score:
            best, best_score = tubes, score
        if len(tubes) >= 2 and score >= 0.8 * len(tubes):   # 夠整齊：不用再試了
            return tubes
    return best


# ---------------------------------------------------------------- 每格內容

CAP = 4                 # 每根管容量（使用者確認）
HIDDEN = "?"            # 黑色問號寶石（上方寶石移開後才顯現）
COVERED = "#"           # 藍罐鎖頭底下看不到的那一顆

GEM_MIN_SAT = 0.35      # 寶石本體像素：飽和度、亮度下限
GEM_MIN_VAL = 0.40
GEM_FRAC = 0.30         # 取樣小塊裡寶石像素占比達這個就算「有寶石」（空格 < 0.12、有寶石 > 0.5）
DARK_VAL = 0.15         # 問號寶石是黑的
DARK_FRAC = 0.35
MARK_VAL = 0.66         # 鎖球（亮白圓）平均亮度下限；空管背景約 0.4~0.6、鎖球約 0.83


class SlotObs(NamedTuple):
    kind: str            # empty / gem / hidden / mark（鎖球那種亮白圓）
    hue: float = -1.0    # gem 才有：加權色相 0~360
    sat: float = 0.0
    val: float = 0.0


def _hsv(p: np.ndarray):
    """p: (...,3) float 0~1 → (h 0~360, s, v)。"""
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    mx = p.max(axis=-1)
    mn = p.min(axis=-1)
    d = mx - mn
    safe = np.maximum(d, 1e-6)
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0.0)
    rc, gc, bc = (mx - r) / safe, (mx - g) / safe, (mx - b) / safe
    h = np.where(mx == r, bc - gc, np.where(mx == g, 2.0 + rc - bc, 4.0 + gc - rc))
    h = np.where(d > 1e-6, (h / 6.0) % 1.0 * 360.0, 0.0)
    return h, s, mx


def robust_hue(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> Optional[float]:
    """寶石的代表色相：先找色相直方圖的峰值，再只平均峰值附近 ±14° 的像素。

    寶石有很多切面，亮面偏黃/偏青、暗面偏藍——直接平均色相會隨著「哪些像素被亮度門檻切掉」
    而飄移（實測綠色寶石亮度 -8% 就從 112° 飄到 129°，被當成另一種顏色）。
    取峰值附近的像素就不受這件事影響（同樣情況最大飄移 < 6°）。"""
    m = (s > GEM_MIN_SAT) & (v > 0.30)
    if int(m.sum()) < 5:
        m = (s > GEM_MIN_SAT) & (v > 0.20)
        if int(m.sum()) < 5:
            return None
    hh, ww = h[m], (s * v)[m]
    bins = np.bincount((hh // 5).astype(int) % 72, weights=ww, minlength=72)
    smooth = np.convolve(np.concatenate([bins[-2:], bins, bins[:2]]), np.ones(5) / 5.0, mode="valid")
    peak = float(np.argmax(smooth)) * 5.0 + 2.5
    d = ((hh - peak + 180.0) % 360.0) - 180.0
    sel = np.abs(d) <= 14.0
    ang = np.deg2rad(hh[sel])
    w = ww[sel]
    return float(np.rad2deg(np.arctan2((np.sin(ang) * w).sum(), (np.cos(ang) * w).sum())) % 360.0)


def read_slot(img: np.ndarray, tube: Tube, k: int) -> SlotObs:
    """讀第 k 格（0＝最底下）：空／寶石（附色相）／問號／鎖球標記。"""
    ih, iw = img.shape[:2]
    cx, cy = tube.slot_center(k)
    hw, hh = PATCH_HALF_W * tube.w, PATCH_HALF_H * tube.w
    x0, x1 = max(0, int(round(cx - hw))), min(iw, int(round(cx + hw)) + 1)
    y0, y1 = max(0, int(round(cy - hh))), min(ih, int(round(cy + hh)) + 1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return SlotObs("empty")
    p = _rgb01(img[y0:y1, x0:x1])
    h, s, v = _hsv(p)
    if float((v < DARK_VAL).mean()) > DARK_FRAC:
        return SlotObs("hidden")
    body = (s > GEM_MIN_SAT) & (v > GEM_MIN_VAL)
    if float(body.mean()) >= GEM_FRAC:
        hue = robust_hue(h, s, v)
        if hue is not None:
            return SlotObs("gem", hue, float(s[body].mean()), float(v[body].mean()))
    if float(v.mean()) > MARK_VAL and float(s.mean()) < 0.30:
        return SlotObs("mark", -1.0, float(s.mean()), float(v.mean()))
    return SlotObs("empty")


# ---------------------------------------------------------------- 顏色色盤

# 名稱只是給人看的；求解器只在乎「同一個名字＝同一種寶石」。
# 色相中心是用 robust_hue() 從使用者截圖量出來的（每種寶石的色相分布都很窄，
# 同色 ±3°；最近兩色 ruby/fire 也差 21°；藍罐裡有霜的寶石會偏 ±6°，綠色最多偏 13°）。
DEFAULT_PALETTE: Dict[str, float] = {
    "green": 115.0, "teal": 170.0, "blue": 206.0, "violet": 256.0,
    "magenta": 300.0, "ruby": 344.0, "fire": 6.0, "amber": 31.0,
}
HUE_TOL = 16.0          # 離最近的色盤顏色多遠以內算同色
HUE_TOL_FROST = 26.0    # 藍罐裡的寶石有霜（色相會偏 ±12°），放寬
HUE_MARGIN = 6.0        # 最近跟次近的距離至少差這麼多，不然算「分不清」
HUE_NEW_MIN_FROST = 45.0   # 藍罐裡的寶石離所有已知色都超過這麼遠，才敢當「沒見過的新顏色」


def hue_dist(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


class Palette:
    """已知的寶石顏色（色相中心）。遇到沒見過的顏色就開新項目（名稱 h<色相>），
    但只有 commit() 才會存檔——避免轉場動畫的髒畫面把假顏色永久寫進去。

    暫存的新顏色只活在「同一張畫面」裡（build_board 開頭會清掉）：留到下一張畫面的話，
    它會跟真的顏色搶同一顆寶石（實測藍罐裡的綠 128° 落在真綠 115° 跟暫存假色 142° 中間 → 判成分不清），
    而盤面一直讀不準就永遠走不到 commit/丟棄，卡死。"""

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path
        self.hues: Dict[str, float] = dict(DEFAULT_PALETTE)
        self._pending: Dict[str, float] = {}
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for name, hue in (data.get("hues") or {}).items():
                    if isinstance(hue, (int, float)):
                        self.hues[str(name)] = float(hue) % 360.0
            except (OSError, ValueError, UnicodeDecodeError):
                pass

    def classify(self, hue: float, frosted: bool = False) -> Tuple[str, bool]:
        """回傳 (顏色名, 分不清?)。離所有已知色都太遠就建立新顏色（暫存）。"""
        tol = HUE_TOL_FROST if frosted else HUE_TOL
        cands = sorted((hue_dist(hue, c), n) for n, c in {**self.hues, **self._pending}.items())
        d1, n1 = cands[0]
        if d1 > tol:
            if frosted and d1 <= HUE_NEW_MIN_FROST:
                # 有霜的色相會隨藍罐光暈脈動偏移，這個距離可能只是「真色偏過頭」：不學新色、只說分不清
                return n1, True
            name = f"h{int(round(hue)) % 360}"
            self._pending[name] = hue
            return name, False
        ambiguous = len(cands) > 1 and (cands[1][0] - d1) < HUE_MARGIN and cands[1][0] <= tol
        return n1, ambiguous

    def commit(self) -> None:
        """把暫存的新顏色轉正並存檔（呼叫端確認盤面通過檢查、連續穩定才呼叫）。"""
        if not self._pending:
            return
        self.hues.update(self._pending)
        self._pending = {}
        self.save()

    def discard_pending(self) -> None:
        self._pending = {}

    def save(self) -> None:
        if not self.path:
            return
        extra = {n: round(h, 1) for n, h in self.hues.items() if n not in DEFAULT_PALETTE}
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "hues": extra}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)


# ---------------------------------------------------------------- 盤面

@dataclass
class TubeState:
    idx: int                          # 在 Board.tubes 的位置（也是點擊用的編號）
    row: int
    col: int
    kind: str                         # normal / fixed / jar（鎖著）/ sealed（鎖球空管）
    cells: List[str]                  # 由下往上：顏色名 / HIDDEN / COVERED
    px: float = 0.0                   # 點擊位置（畫面像素）
    py: float = 0.0
    w: float = 0.0

    def label(self) -> str:
        return f"第{self.row + 1}排第{self.col + 1}根"


@dataclass
class Board:
    tubes: List[TubeState]
    cap: int = CAP
    problems: List[str] = field(default_factory=list)
    ambiguous: bool = False
    width: int = 0
    height: int = 0

    def signature(self) -> tuple:
        """給「連續兩次讀到一樣」用：每根管的（位置、種類、內容）。位置取整數避免抖動。"""
        return tuple((t.row, t.col, t.kind, tuple(t.cells), int(round(t.px / 4)), int(round(t.py / 4)))
                     for t in self.tubes)

    def layout_signature(self) -> tuple:
        """每根管的（排、根、點擊位置、管寬）。要比對請用 layouts_match，不要直接 ==。"""
        return tuple((t.row, t.col, t.px, t.py, t.w) for t in self.tubes)

    @property
    def ok(self) -> bool:
        return not self.problems and not self.ambiguous


LAYOUT_TOL_X = 0.35      # 兩幀之間管子中心 x 偏多少（管寬倍數）以內算同一種排列
LAYOUT_TOL_Y = 0.60      # y 的容許值；動畫（管子升起、完成的光環）實測會讓管底偏 2~14px（≈0.25 管寬）


def layouts_match(a: tuple, b: tuple) -> bool:
    """兩張畫面的管子排列是不是同一種：管子數、排/根編號一致，位置差在動畫抖動的範圍內。
    換關（管數或排列不同）跟視窗大幅改變才會判不同。"""
    if len(a) != len(b):
        return False
    for (r1, c1, x1, y1, w1), (r2, c2, x2, y2, w2) in zip(a, b):
        w = max(w1, w2, 1.0)
        if r1 != r2 or c1 != c2 or abs(x1 - x2) > LAYOUT_TOL_X * w or abs(y1 - y2) > LAYOUT_TOL_Y * w:
            return False
        if abs(w1 - w2) > 0.25 * w:
            return False
    return True


def _lab(t: Tube) -> str:
    return f"第{t.row + 1}排第{t.col + 1}根"


def build_board(img: np.ndarray, palette: Optional[Palette] = None,
                tubes: Optional[List[Tube]] = None) -> Optional[Board]:
    """畫面 → 盤面。找不到（少於 2 根管子）回 None。盤面有疑點會寫進 board.problems，不會丟例外。"""
    palette = palette or Palette()
    palette.discard_pending()       # 上一張畫面暫存的新顏色不帶進這一張（見 Palette 說明）
    tubes = tubes if tubes is not None else detect_tubes(img)
    if len(tubes) < 2:
        return None
    ih, iw = img.shape[:2]
    board = Board(tubes=[], width=iw, height=ih)
    for i, t in enumerate(tubes):
        cells: List[str] = []
        ended = False
        sealed = False
        for k in range(CAP):
            if t.kind == "jar" and k == 0:
                cells.append(COVERED)          # 鎖頭正好蓋在最底下那格
                continue
            obs = read_slot(img, t, k)
            if obs.kind == "mark" and t.kind == "jar":
                obs = SlotObs("empty")      # 藍罐的霜光讓空格也偏亮偏白，不是鎖球
            if obs.kind == "mark":
                sealed = True
                ended = True
                continue
            if obs.kind == "empty":
                ended = True
                continue
            if ended:
                board.problems.append(f"{_lab(t)}：寶石中間有空隙（動畫中？）")
                break
            if obs.kind == "hidden":
                cells.append(HIDDEN)
            else:
                name, amb = palette.classify(obs.hue, frosted=(t.kind == "jar"))
                board.ambiguous = board.ambiguous or amb
                if amb:
                    board.problems.append(f"{_lab(t)}第{k + 1}格顏色分不清（色相 {obs.hue:.0f}°）")
                cells.append(name)
        kind = t.kind
        if sealed and not cells:
            kind = "sealed"
        elif sealed:
            board.problems.append(f"{_lab(t)}：鎖球標記跟寶石同時出現")
        # 問號寶石一定被別的寶石壓著；在最上面代表畫面被遮住／轉場中
        if cells and cells[-1] == HIDDEN:
            board.problems.append(f"{_lab(t)}：最上面是問號寶石（畫面被遮住或轉場中）")
        px, py = t.click_point()
        board.tubes.append(TubeState(idx=i, row=t.row, col=t.col, kind=kind, cells=cells,
                                     px=px, py=py, w=t.w))
    return board


# ---------------------------------------------------------------- 過關結算畫面

# 過關後兩段畫面（使用者 1-2 關截圖）：
#   ①「挑戰成功／恭喜」＋獎勵，底下「點擊任意區域繼續」，此時下方三顆按鈕是暗的（還不能按）
#   ②結算（消耗步數…）＋三顆亮的按鈕：藍「返回」、黃「分享」、黃「下一關」（要花 1 顆鑽石）
# 兩段畫面共通：暗紅色背景 + 底部一排「藍、黃、黃」按鈕。用顏色與形狀找，不吃固定座標，
# 所以使用者框的範圍大小/位置不同也認得。

RED_DARK_MIN = 0.08          # 暗紅色像素占比下限（關卡畫面約 0.05、結算畫面 0.12~0.29）
BTN_ACTIVE_VAL = 0.80        # 黃色按鈕平均亮度達這個 = 按鈕是亮的（第②段）


@dataclass
class Blob:
    x: float                 # 中心（畫面像素）
    y: float
    w: float
    h: float
    val: float               # 平均亮度


def _label(mask: np.ndarray) -> List[List[Tuple[int, int]]]:
    """4 連通元件標記（純 Python，遮罩很小所以夠快）。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps: List[List[Tuple[int, int]]] = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if seen[y0, x0]:
            continue
        stack = [(y0, x0)]
        seen[y0, x0] = True
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        comps.append(comp)
    return comps


def _button_blobs(mask: np.ndarray, val: np.ndarray, f: int, y_off: int, frame_w: int) -> List[Blob]:
    out: List[Blob] = []
    for comp in _label(mask):
        arr = np.array(comp)
        y0, y1 = arr[:, 0].min(), arr[:, 0].max()
        x0, x1 = arr[:, 1].min(), arr[:, 1].max()
        bw, bh = (x1 - x0 + 1) * f, (y1 - y0 + 1) * f
        if not (0.06 * frame_w <= bw <= 0.25 * frame_w) or not (1.8 <= bw / bh <= 6.0):
            continue
        if len(comp) < 0.6 * (x1 - x0 + 1) * (y1 - y0 + 1):
            continue
        out.append(Blob(x=((x0 + x1 + 1) / 2) * f, y=((y0 + y1 + 1) / 2) * f + y_off, w=bw, h=bh,
                        val=float(val[arr[:, 0], arr[:, 1]].mean())))
    return out


def find_result_buttons(img: np.ndarray) -> Optional[dict]:
    """找底部「藍、黃、黃」三顆按鈕。找得到回 {"blue","yellows","active","red"}，找不到 None。"""
    ih, iw = img.shape[:2]
    a = _rgb01(img)
    mx = a.max(axis=2)
    red_dark = float((((a[..., 0] > a[..., 1] * 1.6) & (a[..., 0] > a[..., 2] * 1.6)
                       & (mx > 0.2) & (mx < 0.7))).mean())
    if red_dark < RED_DARK_MIN:
        return None
    f = max(1, iw // 300)
    y_off = int(ih * 0.6) // f * f
    sub = img[y_off:, :]
    h2, w2 = (sub.shape[0] // f) * f, (iw // f) * f
    if h2 < f or w2 < f:
        return None
    small = _rgb01(sub[:h2, :w2]).reshape(h2 // f, f, w2 // f, f, 3).mean(axis=(1, 3))
    hue, sat, val = _hsv(small)
    blue = (hue >= 190) & (hue <= 222) & (sat >= 0.35) & (sat <= 0.75) & (val >= 0.30)
    yellow = (hue >= 36) & (hue <= 52) & (sat >= 0.45) & (sat <= 0.80) & (val >= 0.30)
    blues = _button_blobs(blue, val, f, y_off, iw)
    yellows = _button_blobs(yellow, val, f, y_off, iw)
    for b in blues:
        row = sorted((yb for yb in yellows if abs(yb.y - b.y) <= 0.04 * ih and yb.x > b.x
                      and 0.7 <= yb.w / b.w <= 1.4), key=lambda q: q.x)
        if len(row) >= 2:
            row = row[:2]
            active = float(np.mean([yb.val for yb in row])) >= BTN_ACTIVE_VAL
            return {"blue": b, "yellows": row, "active": active, "red": red_dark}
    return None


@dataclass
class ScreenInfo:
    kind: str                                   # level / reward / result / unknown
    board: Optional[Board] = None
    target: Optional[Tuple[float, float]] = None   # reward/result 要點的位置（畫面像素）
    detail: str = ""


def analyze(img: np.ndarray, palette: Optional[Palette] = None) -> ScreenInfo:
    """一張畫面 → 它是什麼畫面、要看/點哪裡。"""
    board = build_board(img, palette)
    if board is not None:
        return ScreenInfo("level", board=board)
    btn = find_result_buttons(img)
    if btn is not None:
        ih, iw = img.shape[:2]
        if btn["active"]:
            nxt = btn["yellows"][1]                       # 最右邊那顆黃鈕＝下一關
            return ScreenInfo("result", target=(nxt.x, nxt.y), detail="結算畫面（點「下一關」）")
        mid = btn["yellows"][0]
        return ScreenInfo("reward", target=(mid.x, mid.y - 0.22 * ih), detail="獎勵畫面（點任意處繼續）")
    return ScreenInfo("unknown", detail="不是關卡也不是結算畫面")
