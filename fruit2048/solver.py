"""水果 2048（指數版）求解引擎。

盤面用 64-bit bitboard 表示：16 個 nibble，每格存「指數」(0=空格, 1=蘋果, 2=橘子...)。
第 r 列第 c 行的位移量 = 4 * (15 - (4*r + c))，也就是左上角在最高位。

演算法：expectimax（機率期望值搜尋）
  - MAX 節點 = 玩家選方向
  - CHANCE 節點 = 系統在隨機空格長出新水果
評估函式沿用 2048 社群公認最強的 nneonneo 權重（單調性 / 平滑合併數 / 空格數 / 總和懲罰），
以 65536 筆預算表把「一列的分數」查表化，所以整盤評估只要 8 次查表。
"""

from __future__ import annotations

import time
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

# ---------------------------------------------------------------- 常數

UP, DOWN, LEFT, RIGHT = 0, 1, 2, 3
MOVES: Tuple[int, ...] = (UP, DOWN, LEFT, RIGHT)

MOVE_NAME = {UP: "上", DOWN: "下", LEFT: "左", RIGHT: "右"}
MOVE_ARROW = {UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→"}
MOVE_KEY = {UP: "W / ↑", DOWN: "S / ↓", LEFT: "A / ←", RIGHT: "D / →"}

MAX_RANK = 0xF  # 一格最多存到指數 15

# 評估權重（nneonneo, 2048-ai）
W_LOST_PENALTY = 200000.0
W_MONOTONICITY = 47.0
W_SUM = 11.0
W_MERGES = 700.0
W_EMPTY = 270.0
P_MONOTONICITY = 4.0
P_SUM = 3.5


# ---------------------------------------------------------------- 查表建置

def _build_tables() -> Tuple[List[int], List[int], List[float]]:
    """建立 65536 筆的「單列左移 / 右移 / 評估分數」查表。"""
    pow_sum = [float(r) ** P_SUM for r in range(16)]
    pow_mono = [float(r) ** P_MONOTONICITY for r in range(16)]

    row_left = [0] * 65536
    row_right = [0] * 65536
    row_heur = [0.0] * 65536

    for row in range(65536):
        line = [(row >> 12) & 0xF, (row >> 8) & 0xF, (row >> 4) & 0xF, row & 0xF]

        # --- 評估分數 ---
        total = 0.0
        empty = 0
        merges = 0
        prev = 0
        counter = 0
        for rank in line:
            total += pow_sum[rank]
            if rank == 0:
                empty += 1
            else:
                if prev == rank:
                    counter += 1
                elif counter > 0:
                    merges += 1 + counter
                    counter = 0
                prev = rank
        if counter > 0:
            merges += 1 + counter

        mono_left = 0.0
        mono_right = 0.0
        for i in range(1, 4):
            a, b = line[i - 1], line[i]
            if a > b:
                mono_left += pow_mono[a] - pow_mono[b]
            else:
                mono_right += pow_mono[b] - pow_mono[a]

        row_heur[row] = (
            W_LOST_PENALTY
            + W_EMPTY * empty
            + W_MERGES * merges
            - W_MONOTONICITY * min(mono_left, mono_right)
            - W_SUM * total
        )

        # --- 左移 ---
        res = list(line)
        i = 0
        while i < 3:
            j = i + 1
            while j < 4 and res[j] == 0:
                j += 1
            if j == 4:
                break
            if res[i] == 0:
                res[i] = res[j]
                res[j] = 0
                continue  # 同一個 i 再試一次
            if res[i] == res[j]:
                if res[i] != MAX_RANK:
                    res[i] += 1
                res[j] = 0
            i += 1

        moved = (res[0] << 12) | (res[1] << 8) | (res[2] << 4) | res[3]
        row_left[row] = moved
        row_right[_reverse_row(row)] = _reverse_row(moved)

    return row_left, row_right, row_heur


def _reverse_row(row: int) -> int:
    return (
        ((row >> 12) & 0x000F)
        | ((row >> 4) & 0x00F0)
        | ((row << 4) & 0x0F00)
        | ((row << 12) & 0xF000)
    )


ROW_LEFT, ROW_RIGHT, ROW_HEUR = _build_tables()


# ---------------------------------------------------------------- bitboard 操作

def transpose(x: int) -> int:
    """把 4x4 盤面沿主對角線翻轉（列↔行）。"""
    a1 = x & 0xF0F00F0FF0F00F0F
    a2 = x & 0x0000F0F00000F0F0
    a3 = x & 0x0F0F00000F0F0000
    a = a1 | (a2 << 12) | (a3 >> 12)
    b1 = a & 0xFF00FF0000FF00FF
    b2 = a & 0x00FF00FF00000000
    b3 = a & 0x00000000FF00FF00
    return b1 | (b2 >> 24) | (b3 << 24)


def move_left(b: int) -> int:
    return (
        (ROW_LEFT[(b >> 48) & 0xFFFF] << 48)
        | (ROW_LEFT[(b >> 32) & 0xFFFF] << 32)
        | (ROW_LEFT[(b >> 16) & 0xFFFF] << 16)
        | ROW_LEFT[b & 0xFFFF]
    )


def move_right(b: int) -> int:
    return (
        (ROW_RIGHT[(b >> 48) & 0xFFFF] << 48)
        | (ROW_RIGHT[(b >> 32) & 0xFFFF] << 32)
        | (ROW_RIGHT[(b >> 16) & 0xFFFF] << 16)
        | ROW_RIGHT[b & 0xFFFF]
    )


def move_up(b: int) -> int:
    return transpose(move_left(transpose(b)))


def move_down(b: int) -> int:
    return transpose(move_right(transpose(b)))


_MOVE_FN = {UP: move_up, DOWN: move_down, LEFT: move_left, RIGHT: move_right}


def apply_move(board: int, move: int) -> int:
    return _MOVE_FN[move](board)


def heuristic(board: int) -> float:
    t = transpose(board)
    return (
        ROW_HEUR[(board >> 48) & 0xFFFF]
        + ROW_HEUR[(board >> 32) & 0xFFFF]
        + ROW_HEUR[(board >> 16) & 0xFFFF]
        + ROW_HEUR[board & 0xFFFF]
        + ROW_HEUR[(t >> 48) & 0xFFFF]
        + ROW_HEUR[(t >> 32) & 0xFFFF]
        + ROW_HEUR[(t >> 16) & 0xFFFF]
        + ROW_HEUR[t & 0xFFFF]
    )


def empty_slots(board: int) -> List[int]:
    """回傳空格的位移量清單（可直接拿來 OR 上新水果）。"""
    out = []
    shift = 60
    while shift >= 0:
        if not (board >> shift) & 0xF:
            out.append(shift)
        shift -= 4
    return out


def to_list(board: int) -> List[int]:
    """bitboard → 16 格清單（列優先，左上到右下）。"""
    return [(board >> (4 * (15 - i))) & 0xF for i in range(16)]


def from_list(cells: Sequence[int]) -> int:
    """16 格清單 → bitboard。"""
    if len(cells) != 16:
        raise ValueError(f"需要 16 格，收到 {len(cells)} 格")
    board = 0
    for i, v in enumerate(cells):
        if not 0 <= v <= MAX_RANK:
            raise ValueError(f"第 {i} 格的值 {v} 超出 0..{MAX_RANK}")
        board |= v << (4 * (15 - i))
    return board


def format_board(board: int) -> str:
    cells = to_list(board)
    rows = []
    for r in range(4):
        rows.append(" ".join(f"{cells[r * 4 + c]:>2}" if cells[r * 4 + c] else " ." for c in range(4)))
    return "\n".join(rows)


# ---------------------------------------------------------------- 求解器

class MoveScore(NamedTuple):
    move: int
    score: float
    legal: bool


class Result(NamedTuple):
    best: Optional[int]          # 建議方向；None = 已經沒有合法move（遊戲結束）
    scores: List[MoveScore]      # 四個方向的分數（依分數高到低排序）
    depth: int                   # 實際完成搜尋的深度
    elapsed: float               # 花費秒數
    nodes: int


class _Timeout(Exception):
    """搜尋超過時間預算，中止這一輪疊代。"""


class Solver:
    """expectimax 求解器。

    spawn: [(指數, 機率), ...]。這款遊戲只會長 1，所以預設 [(1, 1.0)]。
           若之後發現也會長 2，改成 [(1, 0.9), (2, 0.1)] 即可。
    """

    def __init__(
        self,
        spawn: Sequence[Tuple[int, float]] = ((1, 1.0),),
        prob_cutoff: float = 0.0001,
        min_depth: int = 3,
        max_depth: int = 10,
    ) -> None:
        self.spawn = [(v, p) for v, p in spawn if p > 0]
        if not self.spawn:
            raise ValueError("spawn 不能是空的")
        self.prob_cutoff = prob_cutoff
        self.min_depth = min_depth
        self.max_depth = max_depth
        self._nodes = 0
        self._deadline = 0.0

    # -- 內部：MAX 節點（玩家選方向） --
    def _max_node(self, board: int, depth: int, prob: float, cache: Dict[int, Tuple[int, float]]) -> float:
        if depth <= 0 or prob < self.prob_cutoff:
            return heuristic(board)

        hit = cache.get(board)
        if hit is not None and hit[0] >= depth:
            return hit[1]

        self._nodes += 1
        # 每 1024 個節點檢查一次時鐘：夠密集能即時煞車，又不會讓 perf_counter 拖慢搜尋
        if not (self._nodes & 0x3FF) and time.perf_counter() > self._deadline:
            raise _Timeout

        best = 0.0  # 沒有任何合法 move（遊戲結束）就會停在 0，相對於 heuristic 的百萬級基準等同重罰
        for move in MOVES:
            nb = _MOVE_FN[move](board)
            if nb != board:
                v = self._chance_node(nb, depth - 1, prob, cache)
                if v > best:
                    best = v

        cache[board] = (depth, best)
        return best

    # -- 內部：CHANCE 節點（系統長新水果） --
    def _chance_node(self, board: int, depth: int, prob: float, cache: Dict[int, Tuple[int, float]]) -> float:
        slots = empty_slots(board)
        if not slots:
            return heuristic(board)

        per_slot = 1.0 / len(slots)
        total = 0.0
        for shift in slots:
            for value, vprob in self.spawn:
                weight = per_slot * vprob
                total += weight * self._max_node(
                    board | (value << shift), depth, prob * weight, cache
                )
        return total

    # -- 對外：算出建議 --
    def solve(self, board: int, time_budget: float = 0.30) -> Result:
        """疊代加深，直到超過時間預算，回傳最後一輪「完整跑完」的結果。

        關鍵是每一輪都必須整輪跑完才採用：只算了兩個方向就超時的半套結果會誤導，
        因為沒算到的方向分數是缺的，排序出來的「最佳」可能只是「唯一算完的」。
        """
        started = time.perf_counter()
        self._deadline = started + time_budget
        self._nodes = 0

        legal = {}
        for move in MOVES:
            nb = _MOVE_FN[move](board)
            if nb != board:
                legal[move] = nb

        if not legal:
            return Result(None, [MoveScore(m, float("-inf"), False) for m in MOVES], 0, 0.0, 0)

        best_scores: Dict[int, float] = {}
        reached = 0

        for depth in range(self.min_depth, self.max_depth + 1):
            cache: Dict[int, Tuple[int, float]] = {}
            scores: Dict[int, float] = {}
            try:
                for move, nb in legal.items():
                    scores[move] = self._chance_node(nb, depth - 1, 1.0, cache)
            except _Timeout:
                break
            best_scores = scores
            reached = depth
            # 每加深一層成本大約是前一層的十倍，用掉三成預算就別再往下探了
            if time.perf_counter() - started > time_budget * 0.3:
                break

        if not best_scores:  # 連最淺的一輪都沒跑完 → 退回單層評估
            best_scores = {m: heuristic(nb) for m, nb in legal.items()}
            reached = 1

        ranked = sorted(
            (MoveScore(m, best_scores.get(m, float("-inf")), m in legal) for m in MOVES),
            key=lambda ms: ms.score,
            reverse=True,
        )
        return Result(ranked[0].move, ranked, reached, time.perf_counter() - started, self._nodes)


__all__ = [
    "UP", "DOWN", "LEFT", "RIGHT", "MOVES",
    "MOVE_NAME", "MOVE_ARROW", "MOVE_KEY",
    "Solver", "Result", "MoveScore",
    "apply_move", "heuristic", "to_list", "from_list", "format_board",
    "empty_slots", "transpose", "move_left", "move_right", "move_up", "move_down",
]
