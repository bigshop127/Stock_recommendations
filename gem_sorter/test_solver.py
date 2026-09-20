"""求解器測試：規則單元測試 + 用真實截圖的盤面做端到端模擬（含問號/藍罐的「看不見」處理）。

純邏輯，不開視窗、不碰桌面。
"""

from __future__ import annotations

import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import simgame as SG  # noqa: E402
import solver as S  # noqa: E402
from test_vision import EXPECT  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS {name}")
    else:
        _failed += 1
        print(f"  FAIL {name}  {detail}")


def puzzle_from_expect(name: str) -> S.Puzzle:
    exp = EXPECT[name]
    keys = sorted(exp.keys())
    return S.Puzzle(kinds=[exp[k][0] for k in keys], cells=[list(exp[k][1]) for k in keys])


def world(kinds, tubes, jar_order=(), cap=4, partial=False) -> S.World:
    names = tuple(sorted({c for t in tubes for c in t}))
    return S.World(cap, tuple(kinds), tuple(tuple(t) for t in tubes), tuple(jar_order), names, partial)


# ---------------------------------------------------------------- 1. 規則

def test_rules() -> None:
    print("[1] 規則單元測試")
    # 整串同色一起搬、只搬頂端連續同色
    w = world(["normal"] * 3, [[1, 2, 2], [3, 2], []])
    st = (w.tubes, 0)
    mv = {(s, d): k for s, d, k in S.gen_moves(w, st)}
    check("頂端連續兩顆同色一起搬（搬 2 顆）", mv.get((0, 1)) == 2, str(mv))
    w = world(["normal"] * 3, [[1, 2, 2], [3], []])
    mv = {(s, d) for s, d, k in S.gen_moves(w, (w.tubes, 0))}
    check("只能搬到空管或頂端同色（其餘都不行）", mv == {(0, 2)}, str(mv))
    # 空間不夠放整串就不能搬
    w = world(["normal"] * 3, [[1, 2, 2], [3, 2, 2, 2], []])
    mv = {(s, d) for s, d, k in S.gen_moves(w, (w.tubes, 0))}
    check("目標空間不夠放整串 → 不能搬（partial=False）", (0, 1) not in mv)
    w = world(["normal"] * 3, [[1, 2, 2], [3, 2], []])
    mv = {(s, d, k) for s, d, k in S.gen_moves(w, (w.tubes, 0))}
    check("目標剛好放得下整串 → 可以搬", (0, 1, 2) in mv, str(mv))
    # 湊滿 4 顆 → 合成，管子不能再動
    w = world(["normal"] * 3, [[1, 2, 2], [2, 2], []])
    st = (w.tubes, 0)
    ns = S.apply_move(w, st, (0, 1, 2))
    check("湊滿 4 顆同色 → 那根管子已合成", len(ns[0][1]) == 4 and ns[0][1].count(2) == 4)
    check("已合成的管子不能當來源", all(s != 1 for s, d, k in S.gen_moves(w, ns)))
    # 空管：整根同色搬到空管沒意義
    w = world(["normal"] * 2, [[1, 1], []])
    check("整根同色搬到空管不列入", S.gen_moves(w, (w.tubes, 0)) == [])
    # 固定管：只進不出、只收同色
    w = world(["fixed", "normal", "normal"], [[3, 3], [1, 3], [3]])
    mv = {(s, d) for s, d, k in S.gen_moves(w, (w.tubes, 0))}
    check("固定管只收同色", (1, 0) in mv or (2, 0) in mv)
    check("固定管不能當來源", all(s != 0 for s, d in mv))
    # 鎖罐：解鎖前不能動，合成一組後解鎖一個
    w = world(["normal", "jar", "normal", "normal"], [[1, 1, 1], [3, 2], [1], []], jar_order=(1,))
    st = (w.tubes, 0)
    mv = {(s, d) for s, d, k in S.gen_moves(w, st)}
    check("鎖著的藍罐不能當來源也不能當目標", all(s != 1 and d != 1 for s, d in mv))
    ns = S.apply_move(w, st, (2, 0, 1))
    check("合成一組後，藍罐解鎖（qpos+1）", ns[1] == 1)
    mv2 = {(s, d) for s, d, k in S.gen_moves(w, ns)}
    check("解鎖後藍罐可以當來源", any(s == 1 for s, d in mv2), str(mv2))
    # 鎖球空管一律不用
    w = world(["sealed", "normal", "normal"], [[], [1, 2], [2]])
    mv = {(s, d) for s, d, k in S.gen_moves(w, (w.tubes, 0))}
    check("鎖球空管不當目標", all(d != 0 for s, d in mv))


def test_consistency() -> None:
    print("[2] 數量一致性（看不見的寶石 vs 各色缺額）")
    pz = puzzle_from_expect("lvl2-1_start.png")
    cons = S.check_consistency(pz)
    check("2-1：看不見 7 顆，缺額 綠2+紫3+琥珀2 = 7，剛好", cons.ok and cons.deficits == {"green": 2, "violet": 3, "amber": 2},
          f"{cons}")
    pz = puzzle_from_expect("lvl1-3_0_start.png")
    cons = S.check_consistency(pz)
    check("1-3：鎖罐底下那顆＝品紅（唯一缺額）", cons.ok and cons.deficits == {"magenta": 1}, f"{cons}")
    bad = S.Puzzle(kinds=["normal"] * 3, cells=[["a", "a", "a"], ["b"], []])
    check("顏色認錯（a 只有 3 顆又沒有看不見的寶石）→ 偵測到不一致", not S.check_consistency(bad).ok)


# ---------------------------------------------------------------- 3. 使用者實際玩的 15 步

USER_MOVES_1_2 = [(0, 8), (1, 8), (5, 8), (6, 8),          # 藍 ×4
                  (2, 7), (9, 7),                           # 紫 ×2 進固定管
                  (6, 5), (0, 5), (1, 4), (1, 5),           # 火 ×4（含把綠先挪走）
                  (0, 9),                                   # 紅寶石 一串兩顆
                  (4, 1), (3, 1),                           # 綠 ×2
                  (2, 3), (4, 3)]                           # 紫羅蘭 ×2


def test_user_game() -> None:
    print("[3] 用使用者 1-2 關實際的 15 步驗證規則（步數要等於結算畫面的 15）")
    pz = puzzle_from_expect("lvl1-2_0_start.png")
    game = SG.from_puzzle(pz, ["violet"])         # 鎖罐底下那顆是紫羅蘭
    ok = True
    bad = None
    for i, (s, d) in enumerate(USER_MOVES_1_2):
        if not game.move(s, d):
            ok, bad = False, (i + 1, s, d)
            break
        if i + 1 == 4:
            check("走完第 4 步：藍罐（上排第 4 根）解鎖", game.unlocked == 1)
    check("15 步每一步都合法", ok, f"第 {bad} 步不合法" if bad else "")
    check("15 步走完剛好過關", game.solved() and game.steps == 15, f"steps={game.steps} solved={game.solved()}")


# ---------------------------------------------------------------- 4. 端到端（規劃→走一步→重新看→再規劃）

def play(game: SG.SimGame, max_steps: int = 120, samples: int = 4, avoid_loops: bool = True):
    """模擬 engine 的迴圈：看畫面 → 規劃 → 走第一步 → 重複。遊戲不接受的一步 → 列入黑名單、重新規劃
    （跟 engine 一樣）。回傳 (是否過關, 步數, 最慢一次規劃秒數, 訊息, 被拒絕的次數)。"""
    slowest = 0.0
    seen = {}
    banned = set()
    rejected = 0
    planner = S.Planner(samples=samples)
    while not game.solved() and game.steps < max_steps:
        pz = game.observe()
        t0 = time.perf_counter()
        plan = planner.plan(pz, avoid=tuple(banned))
        slowest = max(slowest, time.perf_counter() - t0)
        if not plan.ok or plan.first is None:
            return False, game.steps, slowest, plan.message, rejected
        key = (tuple(tuple(t) for t in pz.cells), plan.first)
        seen[key] = seen.get(key, 0) + 1
        if avoid_loops and seen[key] > 3:
            return False, game.steps, slowest, "來回打轉", rejected
        if not game.move(*plan.first):
            rejected += 1
            banned.add(tuple(plan.first))
            if rejected > 30:
                return False, game.steps, slowest, f"被拒絕太多次（最後一次 {plan.first}）", rejected
            continue
        banned.clear()                     # 走成功了：黑名單只針對「當時那個盤面」
    return game.solved(), game.steps, slowest, "", rejected


def test_real_boards() -> None:
    print("[4] 真實盤面端到端（含看不見的寶石，多種真相）")
    rng = random.Random(7)
    for name in ("lvl1-2_0_start.png", "lvl1-3_0_start.png", "lvl2-1_start.png"):
        pz = puzzle_from_expect(name)
        cons = S.check_consistency(pz)
        pool = []
        for c, n in cons.deficits.items():
            pool += [c] * n
        runs = 40 if name.startswith("lvl2-1") else 3
        wins, worst_t, worst_steps, fails, total_rej = 0, 0.0, 0, [], 0
        for r in range(runs):
            fill = pool[:]
            rng.shuffle(fill)
            order = None
            jars = [i for i, k in enumerate(pz.kinds) if k == "jar"]
            if len(jars) > 1 and r % 2 == 1:
                order = list(reversed(jars))            # 一半的局，藍罐實際解鎖順序跟預設猜的相反
            game = SG.from_puzzle(pz, fill, jar_order=order)
            ok, steps, slow, msg, rej = play(game)
            total_rej += rej
            wins += ok
            worst_t = max(worst_t, slow)
            worst_steps = max(worst_steps, steps)
            if not ok:
                fails.append(f"真相{r}: {msg} (走了{steps}步)")
        check(f"{name}: {runs} 種真相全部過關（最多 {worst_steps} 步，單次規劃最慢 {worst_t:.2f}s，"
              f"遊戲拒絕過 {total_rej} 次）", wins == runs, "; ".join(fails))
        check(f"{name}: 單次規劃 < 6 秒", worst_t < 6.0, f"{worst_t:.2f}s")


def test_random_boards() -> None:
    print("[5] 隨機盤面（沒有看不見的寶石）：解得出來的比例與速度")
    rng = random.Random(11)
    solved = 0
    tried = 0
    worst = 0.0
    for trial in range(12):
        ncol = rng.choice([4, 5, 6, 7])
        gems = [c for c in range(ncol) for _ in range(4)]
        rng.shuffle(gems)
        ntube = ncol + 2
        tubes = [[] for _ in range(ntube)]
        i = 0
        for g in gems:
            while len(tubes[i % ntube]) >= 3 and False:
                i += 1
            tubes[i % (ntube - 2)].append(g)
            i += 1
        # 每根最多 4 顆
        if any(len(t) > 4 for t in tubes):
            continue
        pz = S.Puzzle(kinds=["normal"] * ntube, cells=[[f"c{g}" for g in t] for t in tubes])
        tried += 1
        game = SG.from_puzzle(pz, [])
        ok, steps, slow, msg, rej = play(game, samples=1)
        solved += ok
        worst = max(worst, slow)
    check(f"隨機 {tried} 盤（2 根空管）幾乎都解得出來（{solved}/{tried}，單次規劃最慢 {worst:.2f}s）",
          tried > 0 and solved >= tried - 1, f"{solved}/{tried}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    test_rules()
    test_consistency()
    test_user_game()
    test_real_boards()
    test_random_boards()
    print(f"\n{_passed} 項通過，{_failed} 項失敗")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
