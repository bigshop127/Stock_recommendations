"""寶石排序求解器（純邏輯，不碰畫面、不碰 tkinter）。

規則（使用者 2026-09-20 當面確認 + 1-2 關通關截圖逐步重建驗證過）：
  * 每根管容量 4；搬到「空管」或「頂端同色」的管子上。
  * 點來源管：頂端連續同色的整串一起搬（算 1 步）。目標管空間不夠放整串就不能搬
    （`partial=True` 可改成「能放幾顆放幾顆」——實測若發現遊戲其實可以再切）。
  * 4 顆同色湊齊 → 合成上鎖，管子不能再動（畫面上 4 顆仍留在管內）。每合成一組，解鎖 1 個藍罐。
  * 固定管（粉色光環）：裡面的拿不出來、只能放進去（等於只收同色）。
  * 鎖球空管（sealed）：只有「解鎖空匣」道具能開，一律當它不存在。
  * 黑色問號 / 藍罐鎖頭底下的寶石：**看不見**，但每種顏色總數是 4 的倍數 →
    用「各色缺幾顆」推算它們可能是什麼，抽幾種可能的世界各解一次，投票選第一步。

「世界」＝把看不見的寶石都指定了顏色的完整盤面；在世界裡所有資訊都是已知的，可以放心搜尋。
真的走了一步之後，engine 會重新讀畫面、重新規劃（有新的問號顯現就多知道一點）。
"""

from __future__ import annotations

import heapq
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

GROUP = 4                 # 4 顆同色合成
HIDDEN = "?"
COVERED = "#"
UNKNOWN_CELLS = (HIDDEN, COVERED)

Move = Tuple[int, int]    # (來源管索引, 目標管索引)


# ---------------------------------------------------------------- 題目描述

@dataclass
class Puzzle:
    """由畫面讀出來的題目：每根管的種類與內容（由下往上）。"""
    kinds: List[str]                  # normal / fixed / jar / sealed
    cells: List[List[str]]            # 顏色名 / "?" / "#"
    cap: int = 4
    partial: bool = False             # 目標放不下整串時，能不能搬一部分

    def unknown_slots(self) -> List[Tuple[int, int]]:
        return [(i, j) for i, t in enumerate(self.cells) for j, c in enumerate(t) if c in UNKNOWN_CELLS]

    def color_counts(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for t in self.cells:
            for c in t:
                if c not in UNKNOWN_CELLS:
                    counts[c] = counts.get(c, 0) + 1
        return counts

    def is_solved(self) -> bool:
        """所有寶石都已經在合成完的管子裡（沒有鎖罐裡還剩東西）。"""
        for kind, t in zip(self.kinds, self.cells):
            if kind == "sealed" or not t:
                continue
            if not (len(t) == self.cap and t[0] not in UNKNOWN_CELLS and all(c == t[0] for c in t)):
                return False
        return True


@dataclass
class Consistency:
    ok: bool
    message: str = ""
    deficits: Dict[str, int] = field(default_factory=dict)   # 每色還差幾顆沒看到
    extra_groups: int = 0                                    # 看不見的寶石比缺額多出幾組（新顏色）


def check_consistency(p: Puzzle) -> Consistency:
    """各色可見數 + 看不見的寶石，要能湊成「每色都是 4 的倍數」。"""
    counts = p.color_counts()
    deficits = {c: (-n) % GROUP for c, n in counts.items() if n % GROUP}
    need = sum(deficits.values())
    unknown = len(p.unknown_slots())
    if unknown < need:
        return Consistency(False, f"顏色數量對不上：看不見的寶石只有 {unknown} 顆，但各色還缺 {need} 顆才湊得成 4 的倍數"
                                  f"（{_fmt(deficits)}）——可能有顏色認錯了", deficits)
    if (unknown - need) % GROUP:
        return Consistency(False, f"顏色數量對不上：看不見的寶石 {unknown} 顆、缺額 {need} 顆，"
                                  f"多出的 {unknown - need} 顆湊不成整組", deficits)
    return Consistency(True, "", deficits, (unknown - need) // GROUP)


def _fmt(d: Dict[str, int]) -> str:
    return "、".join(f"{c}缺{n}" for c, n in sorted(d.items())) or "無"


# ---------------------------------------------------------------- 世界（看不見的寶石都指定了顏色）

@dataclass
class World:
    """整數化的完整盤面。所有顏色用小整數表示。"""
    cap: int
    kinds: Tuple[str, ...]
    tubes: Tuple[Tuple[int, ...], ...]
    jar_order: Tuple[int, ...]            # 解鎖順序（依政策）
    names: Tuple[str, ...]                # 顏色編號 → 名稱
    partial: bool = False
    banned: frozenset = frozenset()       # 已知走不通的 (來源, 目標)


def make_world(p: Puzzle, fill: Sequence[str], policy: str = "reading",
               banned: Sequence[Move] = ()) -> World:
    """fill：依 unknown_slots() 順序，每個看不見的寶石指定的顏色名。"""
    slots = p.unknown_slots()
    assert len(slots) == len(fill)
    cells = [list(t) for t in p.cells]
    for (i, j), name in zip(slots, fill):
        cells[i][j] = name
    names = sorted({c for t in cells for c in t})
    idx = {n: k for k, n in enumerate(names)}
    tubes = tuple(tuple(idx[c] for c in t) for t in cells)
    jars = [i for i, k in enumerate(p.kinds) if k == "jar"]
    if policy == "reverse":
        jars.reverse()
    return World(p.cap, tuple(p.kinds), tubes, tuple(jars), tuple(names), p.partial, frozenset(banned))


def _done(t: Tuple[int, ...], cap: int) -> bool:
    return len(t) == cap and t.count(t[0]) == cap


def _chain(t: Tuple[int, ...]) -> int:
    c = t[-1]
    k = 1
    while k < len(t) and t[-1 - k] == c:
        k += 1
    return k


State = Tuple[Tuple[Tuple[int, ...], ...], int]     # (tubes, 已解鎖的藍罐數)


def _locked(w: World, qpos: int) -> frozenset:
    return frozenset(w.jar_order[qpos:])


def gen_moves(w: World, st: State) -> List[Tuple[int, int, int]]:
    """(來源, 目標, 搬幾顆)。"""
    tubes, qpos = st
    n = len(tubes)
    locked = _locked(w, qpos)
    cap = w.cap
    out: List[Tuple[int, int, int]] = []
    forced: Optional[Tuple[int, int, int]] = None
    empty_used = False
    for s in range(n):
        ts = tubes[s]
        if not ts or w.kinds[s] in ("fixed", "sealed") or s in locked:
            continue
        if len(ts) == cap and ts.count(ts[0]) == cap:
            continue                                   # 已合成
        c = ts[-1]
        k = _chain(ts)
        uniform = k == len(ts)
        empty_used = False
        for d in range(n):
            if d == s or w.kinds[d] == "sealed" or d in locked or (s, d) in w.banned:
                continue
            td = tubes[d]
            room = cap - len(td)
            if room <= 0:
                continue
            fixed = w.kinds[d] == "fixed"
            if td:
                if td[-1] != c:
                    continue
                if fixed and td[0] != c:
                    continue
            else:
                if fixed or uniform:
                    continue                           # 空管：整根同色搬過去沒意義
                if empty_used:
                    continue                           # 多根空管是對稱的，只試第一根
                empty_used = True
            move_k = k
            if room < k:
                if not w.partial:
                    if not td:
                        empty_used = False
                    continue
                move_k = room
            mv = (s, d, move_k)
            # 必然有利的一步：湊滿一組，或搬進固定管
            if td and (fixed or (len(td) + move_k == cap and all(x == c for x in td))):
                if forced is None or len(td) + move_k == cap:
                    forced = mv
            out.append(mv)
    if forced is not None:
        return [forced]
    return out


def apply_move(w: World, st: State, mv: Tuple[int, int, int]) -> State:
    tubes, qpos = st
    s, d, k = mv
    ts, td = tubes[s], tubes[d]
    new_s = ts[:len(ts) - k]
    new_d = td + ts[len(ts) - k:]
    lst = list(tubes)
    lst[s], lst[d] = new_s, new_d
    if len(new_d) == w.cap and new_d.count(new_d[0]) == w.cap and qpos < len(w.jar_order):
        qpos += 1                                     # 合成一組 → 解鎖 1 個藍罐
    return tuple(lst), qpos


def is_goal(w: World, st: State) -> bool:
    tubes, _ = st
    for i, t in enumerate(tubes):
        if not t or w.kinds[i] == "sealed":
            continue
        if not _done(t, w.cap):
            return False
    return True


def _key(w: World, st: State) -> tuple:
    """搜尋去重用：位置無關的一般管排序，固定管/鎖罐保留位置。"""
    tubes, qpos = st
    locked = _locked(w, qpos)
    plain = sorted(t for i, t in enumerate(tubes) if w.kinds[i] not in ("fixed", "sealed") and i not in locked)
    special = tuple(t for i, t in enumerate(tubes) if w.kinds[i] == "fixed" or i in locked)
    return (tuple(plain), special, qpos)


def _heuristic(w: World, st: State) -> int:
    """下界估計：每種顏色多出來的「連續同色段」至少要搬一次。"""
    tubes, _ = st
    runs: Dict[int, int] = {}
    total: Dict[int, int] = {}
    for i, t in enumerate(tubes):
        if not t or _done(t, w.cap):
            continue
        prev = -1
        for c in t:
            total[c] = total.get(c, 0) + 1
            if c != prev:
                runs[c] = runs.get(c, 0) + 1
                prev = c
    h = 0
    for c, r in runs.items():
        groups = (total[c] + w.cap - 1) // w.cap
        if r > groups:
            h += r - groups
    return h


@dataclass
class Solution:
    moves: List[Move]
    states: List[State]          # states[i] = 走完前 i 步之後的盤面（states[0] 是起點）


def search(w: World, max_nodes: int = 40000, time_limit: float = 2.0,
           weight: float = 3.0) -> Optional[Solution]:
    """加權 A*：找得到解就好，不追求最少步數。找不到（超過節點/時間上限）回 None。"""
    start: State = (w.tubes, 0)
    if is_goal(w, start):
        return Solution([], [start])
    t0 = time.monotonic()
    counter = 0
    heap: List[tuple] = [(weight * _heuristic(w, start), 0, counter, start)]
    parent: Dict[tuple, Tuple[Optional[tuple], Optional[Move], State]] = {_key(w, start): (None, None, start)}
    best_g: Dict[tuple, int] = {_key(w, start): 0}
    nodes = 0
    while heap:
        _, g, _, st = heapq.heappop(heap)
        k0 = _key(w, st)
        if g > best_g.get(k0, 1 << 30):
            continue
        nodes += 1
        if nodes > max_nodes or (nodes % 256 == 0 and time.monotonic() - t0 > time_limit):
            return None
        for mv in gen_moves(w, st):
            ns = apply_move(w, st, mv)
            nk = _key(w, ns)
            ng = g + 1
            if ng >= best_g.get(nk, 1 << 30):
                continue
            best_g[nk] = ng
            parent[nk] = (k0, (mv[0], mv[1]), ns)
            if is_goal(w, ns):
                return _rebuild(parent, nk)
            counter += 1
            heapq.heappush(heap, (ng + weight * _heuristic(w, ns), ng, counter, ns))
    return None


def _rebuild(parent, key) -> Solution:
    moves: List[Move] = []
    states: List[State] = []
    while key is not None:
        pk, mv, st = parent[key]
        states.append(st)
        if mv is not None:
            moves.append(mv)
        key = pk
    moves.reverse()
    states.reverse()
    return Solution(moves, states)


# ---------------------------------------------------------------- 規劃（含看不見的寶石）

@dataclass
class Plan:
    ok: bool
    message: str = ""
    moves: List[Move] = field(default_factory=list)       # 選中的世界的完整解
    first: Optional[Move] = None
    worlds_total: int = 0
    worlds_solved: int = 0
    votes: int = 0                                         # 支持 first 的世界數
    unknown_count: int = 0
    solved_already: bool = False


def _fills(p: Puzzle, cons: Consistency, samples: int, rng: random.Random) -> List[List[str]]:
    """抽幾種「看不見的寶石各是什麼顏色」的可能。"""
    slots = p.unknown_slots()
    pool: List[str] = []
    for c, n in sorted(cons.deficits.items()):
        pool += [c] * n
    for g in range(cons.extra_groups):
        pool += [f"new{g}"] * GROUP
    if not slots:
        return [[]]
    seen = set()
    out: List[List[str]] = []
    tries = 0
    while len(out) < samples and tries < samples * 8:
        tries += 1
        cand = pool[:]
        rng.shuffle(cand)
        key = tuple(cand)
        if key in seen:
            continue
        seen.add(key)
        out.append(cand)
    return out


def plan(p: Puzzle, samples: int = 4, max_nodes: int = 40000, time_limit: float = 2.0,
         seed: int = 0, avoid: Sequence[Move] = ()) -> Plan:
    """規劃下一步（無狀態版：每次都重新抽世界、重新搜尋）。

    實際使用請用下面的 Planner——它會「黏住」上一次的計畫，沒有新資訊就照計畫走，
    不然每步重抽世界，第 N 步選的搬法第 N+1 步可能被改成搬回去（實測在 2-1 會來回打轉）。
    avoid：已知走不通的 (來源, 目標)（例如點了沒反應），規劃時排除。
    """
    return _plan_full(p, samples, max_nodes, time_limit, seed, avoid)[0]


def _plan_full(p: Puzzle, samples: int, max_nodes: int, time_limit: float, seed: int,
               avoid: Sequence[Move]) -> Tuple[Plan, Optional[World], Optional[Solution]]:
    cons = check_consistency(p)
    if not cons.ok:
        return Plan(False, cons.message, unknown_count=len(p.unknown_slots())), None, None
    if p.is_solved():
        return Plan(True, "所有寶石都已歸位", solved_already=True), None, None
    rng = random.Random(seed)
    fills = _fills(p, cons, samples, rng)
    has_jar = any(k == "jar" for k in p.kinds)
    results: List[Tuple[World, Solution]] = []
    for i, fill in enumerate(fills):
        # 第一個世界照「由左到右、由上到下」的解鎖順序；有藍罐時，其餘世界輪流換成反向，
        # 讓第一步不要押在某個沒驗證過的解鎖順序上
        policy = "reverse" if (has_jar and i % 2 == 1) else "reading"
        w = make_world(p, fill, policy, banned=avoid)
        sol = search(w, max_nodes=max_nodes, time_limit=time_limit)
        if sol is not None and sol.moves:
            results.append((w, sol))
    total = len(fills)
    if not results:
        return (Plan(False, "找不到解（所有可能的世界都走不通）——這關可能需要道具，或某條規則跟遊戲不同",
                     worlds_total=total, unknown_count=len(p.unknown_slots())), None, None)
    tally: Dict[Move, List[Tuple[World, Solution]]] = {}
    for w, sol in results:
        tally.setdefault(sol.moves[0], []).append((w, sol))
    first, cands = max(tally.items(), key=lambda kv: (len(kv[1]), -min(len(c[1].moves) for c in kv[1])))
    world, chosen = min(cands, key=lambda c: len(c[1].moves))
    return (Plan(True, "", moves=chosen.moves, first=first, worlds_total=total,
                 worlds_solved=len(results), votes=len(cands), unknown_count=len(p.unknown_slots())),
            world, chosen)


class Planner:
    """有記憶的規劃：選好一個「世界」與完整解之後，只要畫面跟計畫預期的一致就照著走。

    只有這幾種情況才重新規劃：畫面跟計畫對不上（問號顯現成不同顏色、藍罐解鎖順序不同、
    走出計畫外）、下一步被列入黑名單、計畫走完了畫面卻還沒解完。
    這樣每個「新資訊」最多觸發一次重規劃（看不見的寶石有限），不會來回打轉。
    """

    def __init__(self, samples: int = 4, max_nodes: int = 40000, time_limit: float = 2.0,
                 seed: int = 0) -> None:
        self.samples, self.max_nodes, self.time_limit, self.seed = samples, max_nodes, time_limit, seed
        self.reset()

    def reset(self) -> None:
        self._world: Optional[World] = None
        self._sol: Optional[Solution] = None
        self._i = 0
        self.replans = 0

    def _matches(self, p: Puzzle, st: State) -> bool:
        w = self._world
        tubes, qpos = st
        locked = set(w.jar_order[qpos:])
        if len(p.cells) != len(tubes):
            return False
        for i, (kind, cells) in enumerate(zip(p.kinds, p.cells)):
            exp = "jar" if i in locked else ("normal" if w.kinds[i] == "jar" else w.kinds[i])
            if kind != exp or len(cells) != len(tubes[i]):
                return False
            for j, c in enumerate(cells):
                if c not in UNKNOWN_CELLS and w.names[tubes[i][j]] != c:
                    return False
        return True

    @staticmethod
    def legal_visible(p: Puzzle, mv: Move) -> bool:
        """只看畫面上「看得見的」資訊，這一步合不合法（不靠任何對看不見寶石的假設）。"""
        s, d = mv
        if s == d or not (0 <= s < len(p.cells)) or not (0 <= d < len(p.cells)):
            return False
        ts, td = p.cells[s], p.cells[d]
        if not ts or ts[-1] in UNKNOWN_CELLS:
            return False
        if p.kinds[s] in ("fixed", "sealed", "jar") or p.kinds[d] in ("sealed", "jar"):
            return False
        c = ts[-1]
        k = 1
        while k < len(ts) and ts[-1 - k] == c:
            k += 1
        if len(ts) == p.cap and all(x == c for x in ts):
            return False                                   # 已合成
        room = p.cap - len(td)
        if td:
            if td[-1] != c:
                return False
            if p.kinds[d] == "fixed" and td[0] != c:
                return False
        elif p.kinds[d] == "fixed":
            return False
        return room >= k or (p.partial and room > 0)

    def plan(self, p: Puzzle, avoid: Sequence[Move] = ()) -> Plan:
        if p.is_solved():
            self.reset()
            return Plan(True, "所有寶石都已歸位", solved_already=True)
        if self._world is not None and self._sol is not None:
            for j in range(self._i, len(self._sol.states)):
                if self._matches(p, self._sol.states[j]):
                    if j < len(self._sol.moves) and tuple(self._sol.moves[j]) not in set(map(tuple, avoid))                             and self.legal_visible(p, tuple(self._sol.moves[j])):
                        self._i = j
                        return Plan(True, "", moves=self._sol.moves[j:], first=self._sol.moves[j],
                                    worlds_total=1, worlds_solved=1, votes=1,
                                    unknown_count=len(p.unknown_slots()))
                    break
        plan, world, sol = _plan_full(p, self.samples, self.max_nodes, self.time_limit, self.seed, avoid)
        self.replans += 1
        if plan.ok and world is not None and sol is not None:
            self._world, self._sol, self._i = world, sol, 0
        else:
            self._world = self._sol = None
        return plan


__all__ = ["Puzzle", "Plan", "Planner", "plan", "check_consistency", "Consistency", "make_world", "search",
           "gen_moves", "apply_move", "is_goal", "World", "GROUP", "HIDDEN", "COVERED"]
