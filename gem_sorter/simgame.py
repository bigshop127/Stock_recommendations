"""遊戲模擬器（只給測試用）：照使用者確認的規則跑一局，讓求解器/引擎能做端到端驗證。

不是求解器的一部分——求解器的搜尋世界（solver.py）只在乎規則；這裡多模擬了
「看不見的寶石什麼時候顯現」「藍罐哪一個先解鎖」，用來測「看不見 → 規劃 → 走一步 →
新資訊出現 → 重新規劃」整條迴圈會不會走進死路。
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

import solver as S
import vision as V


class SimGame:
    def __init__(self, kinds: Sequence[str], colors: Sequence[Sequence[str]],
                 hidden: Sequence[Sequence[bool]], cap: int = 4,
                 jar_order: Optional[Sequence[int]] = None, partial: bool = False) -> None:
        """colors[i][j]＝第 i 根管第 j 格（由下往上）的真實顏色；hidden[i][j]＝是不是問號寶石。
        jar_order＝藍罐實際解鎖順序（None＝由左到右、由上到下）。"""
        self.kinds = list(kinds)
        self.cap = cap
        self.partial = partial
        self.gems: List[List[list]] = [[[c, bool(h)] for c, h in zip(col, hid)]
                                       for col, hid in zip(colors, hidden)]
        jars = [i for i, k in enumerate(self.kinds) if k == "jar"]
        self.jar_order = list(jar_order) if jar_order is not None else jars
        self.unlocked = 0
        self.steps = 0
        self._reveal()

    # ---- 規則 ----
    def locked_jars(self) -> set:
        return set(self.jar_order[self.unlocked:])

    def _reveal(self) -> None:
        for i, t in enumerate(self.gems):
            if t and t[-1][1]:
                t[-1][1] = False            # 最上面的問號寶石顯現，之後一直是看得見的
            if self.is_done_tube(i):
                for g in t:
                    g[1] = False            # 合成完的管子：4 顆都攤開（截圖上合成完的管子全是看得見的同色寶石）

    def is_done_tube(self, i: int) -> bool:
        t = self.gems[i]
        return len(t) == self.cap and all(g[0] == t[0][0] for g in t)

    def can_move(self, s: int, d: int) -> Optional[int]:
        """可以的話回傳會搬幾顆，否則 None。"""
        if s == d or not self.gems[s]:
            return None
        locked = self.locked_jars()
        if self.kinds[s] in ("fixed", "sealed") or s in locked or self.is_done_tube(s):
            return None
        if self.kinds[d] == "sealed" or d in locked:
            return None
        ts, td = self.gems[s], self.gems[d]
        c = ts[-1][0]
        k = 1
        while k < len(ts) and ts[-1 - k][0] == c:
            k += 1
        if td:
            if td[-1][0] != c:
                return None
            if self.kinds[d] == "fixed" and td[0][0] != c:
                return None
        elif self.kinds[d] == "fixed":
            return None
        room = self.cap - len(td)
        if room < k:
            if not self.partial or room <= 0:
                return None
            k = room
        return k

    def move(self, s: int, d: int) -> bool:
        k = self.can_move(s, d)
        if k is None:
            return False
        moved = self.gems[s][-k:]
        del self.gems[s][-k:]
        self.gems[d].extend(moved)
        self.steps += 1
        if self.is_done_tube(d) and self.unlocked < len(self.jar_order):
            self.unlocked += 1
        self._reveal()
        return True

    def solved(self) -> bool:
        return all((not t) or self.is_done_tube(i) for i, t in enumerate(self.gems)
                   if self.kinds[i] != "sealed")

    # ---- 玩家看得到的 ----
    def observe(self) -> S.Puzzle:
        locked = self.locked_jars()
        cells: List[List[str]] = []
        for i, t in enumerate(self.gems):
            row = []
            for j, (c, hid) in enumerate(t):
                if hid:
                    row.append(S.HIDDEN)
                elif i in locked and j == 0:
                    row.append(S.COVERED)
                else:
                    row.append(c)
            cells.append(row)
        kinds = [("jar" if i in locked else ("normal" if k == "jar" else k)) for i, k in enumerate(self.kinds)]
        return S.Puzzle(kinds=kinds, cells=cells, cap=self.cap, partial=self.partial)

    def observe_board(self) -> V.Board:
        """給 engine 測試用：把觀察結果包成 vision.Board（位置用假座標，第 i 根在 x=100*i）。"""
        pz = self.observe()
        tubes = []
        for i, (k, cells) in enumerate(zip(pz.kinds, pz.cells)):
            tubes.append(V.TubeState(idx=i, row=0 if i < (len(pz.kinds) + 1) // 2 else 1,
                                     col=i if i < (len(pz.kinds) + 1) // 2 else i - (len(pz.kinds) + 1) // 2,
                                     kind=k, cells=cells, px=100.0 * (i + 1), py=200.0, w=60.0))
        return V.Board(tubes=tubes, cap=self.cap, width=1200, height=600)


def from_puzzle(pz: S.Puzzle, fill: Sequence[str], jar_order: Optional[Sequence[int]] = None,
                partial: bool = False) -> SimGame:
    """把「畫面上看到的題目」＋「看不見的寶石真實顏色」變成一局遊戲。
    hidden 旗標：'?' 與 '#'（鎖罐底下）。'#' 在遊戲裡不是問號寶石，而是被鎖頭蓋住，
    解鎖後就看得見——模擬器用 locked 狀態處理，所以 hidden=False。"""
    slots = pz.unknown_slots()
    colors = [list(t) for t in pz.cells]
    hidden = [[False] * len(t) for t in pz.cells]
    for (i, j), name in zip(slots, fill):
        colors[i][j] = name
        hidden[i][j] = pz.cells[i][j] == S.HIDDEN
    kinds = list(pz.kinds)
    return SimGame(kinds, colors, hidden, pz.cap, jar_order, partial)
