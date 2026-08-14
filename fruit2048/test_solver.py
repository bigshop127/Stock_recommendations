"""solver.py 的正確性驗證。直接 `python test_solver.py` 執行。"""

import random
import time

import solver as S


def naive_transpose(cells):
    return [cells[c * 4 + r] for r in range(4) for c in range(4)]


def naive_move_left(cells):
    """用最直白的寫法做左移，當作 bitboard 版本的對照組。"""
    out = []
    for r in range(4):
        row = [v for v in cells[r * 4:r * 4 + 4] if v]
        merged = []
        i = 0
        while i < len(row):
            if i + 1 < len(row) and row[i] == row[i + 1]:
                merged.append(min(row[i] + 1, S.MAX_RANK))
                i += 2
            else:
                merged.append(row[i])
                i += 1
        merged += [0] * (4 - len(merged))
        out.extend(merged)
    return out


def naive_move(cells, move):
    if move == S.LEFT:
        return naive_move_left(cells)
    if move == S.RIGHT:
        flip = lambda c: [c[r * 4 + (3 - k)] for r in range(4) for k in range(4)]
        return flip(naive_move_left(flip(cells)))
    if move == S.UP:
        return naive_transpose(naive_move_left(naive_transpose(cells)))
    if move == S.DOWN:
        t = naive_transpose(cells)
        flip = lambda c: [c[r * 4 + (3 - k)] for r in range(4) for k in range(4)]
        return naive_transpose(flip(naive_move_left(flip(t))))
    raise ValueError(move)


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    return ok


def main():
    random.seed(20260813)
    all_ok = True

    print("1) 編碼 / 解碼 round-trip")
    for _ in range(2000):
        cells = [random.choice([0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 11, 15]) for _ in range(16)]
        if S.to_list(S.from_list(cells)) != cells:
            all_ok &= check("to_list(from_list(x)) == x", False)
            break
    else:
        all_ok &= check("to_list(from_list(x)) == x  (2000 組隨機盤面)", True)

    print("2) transpose 與樸素版一致")
    ok = True
    for _ in range(2000):
        cells = [random.randint(0, 15) for _ in range(16)]
        if S.to_list(S.transpose(S.from_list(cells))) != naive_transpose(cells):
            ok = False
            break
    all_ok &= check("transpose", ok)

    print("3) 四個方向的移動與樸素版一致")
    for move in S.MOVES:
        ok = True
        bad = None
        for _ in range(4000):
            cells = [random.choice([0, 0, 0, 1, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 15]) for _ in range(16)]
            got = S.to_list(S.apply_move(S.from_list(cells), move))
            want = naive_move(cells, move)
            if got != want:
                ok = False
                bad = (cells, got, want)
                break
        if bad:
            print(f"      輸入 {bad[0]}\n      得到 {bad[1]}\n      應為 {bad[2]}")
        all_ok &= check(f"move {S.MOVE_NAME[move]}", ok)

    print("4) 15 是天花板（不會再合成）")
    b = S.from_list([15, 15, 0, 0] + [0] * 12)
    all_ok &= check("15+15 仍是 15", S.to_list(S.move_left(b))[:2] == [15, 0])

    print("5) 遊戲結束偵測")
    dead = S.from_list([1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1])
    res = S.Solver().solve(dead)
    all_ok &= check("死局回傳 best=None", res.best is None)

    print("6) 合法性：建議的方向一定要真的能動")
    sv6 = S.Solver()
    ok_legal_flag = True
    ok_best_legal = True
    for _ in range(300):
        cells = [random.choice([0, 1, 1, 2, 2, 3, 3, 4, 5, 6]) for _ in range(16)]
        board = S.from_list(cells)
        want_legal = {m for m in S.MOVES if naive_move(cells, m) != cells}
        res = sv6.solve(board, time_budget=0.02)
        if {ms.move for ms in res.scores if ms.legal} != want_legal:
            ok_legal_flag = False
            break
        if want_legal and res.best not in want_legal:
            ok_best_legal = False
            break
        if not want_legal and res.best is not None:
            ok_best_legal = False
            break
    all_ok &= check("legal 旗標與樸素版一致（300 組隨機盤面）", ok_legal_flag)
    all_ok &= check("建議方向永遠是合法的（死局才回 None）", ok_best_legal)

    print("7) 實測效能（使用者截圖的真實盤面）")
    real = S.from_list([
        1, 1, 5, 2,
        2, 3, 6, 1,
        0, 5, 1, 7,
        0, 0, 0, 1,
    ])
    print(S.format_board(real))
    sv = S.Solver()
    for budget in (0.10, 0.30, 1.00):
        res = sv.solve(real, time_budget=budget)
        ranked = "  ".join(
            f"{S.MOVE_ARROW[m.move]}{S.MOVE_NAME[m.move]}={m.score:,.0f}" if m.legal
            else f"{S.MOVE_ARROW[m.move]}{S.MOVE_NAME[m.move]}=不能動"
            for m in res.scores
        )
        print(f"  預算 {budget:.2f}s → 建議 {S.MOVE_ARROW[res.best]}{S.MOVE_NAME[res.best]} "
              f"| 深度 {res.depth} | {res.nodes:,} nodes | 實耗 {res.elapsed:.3f}s")
        print(f"      {ranked}")

    print("8) 完整自我對局（AI 自己玩到死，只長 1）")
    t0 = time.perf_counter()
    board = 0
    slots = S.empty_slots(board)
    for shift in random.sample(slots, 2):
        board |= 1 << shift
    steps = 0
    while steps < 1500:
        res = sv.solve(board, time_budget=0.03)
        if res.best is None:
            break
        board = S.apply_move(board, res.best)
        slots = S.empty_slots(board)
        if not slots:
            break
        board |= 1 << random.choice(slots)
        steps += 1
    peak = max(S.to_list(board))
    print(S.format_board(board))
    print(f"  {steps} 步後結束，最大水果編號 = {peak}，耗時 {time.perf_counter() - t0:.1f}s")
    all_ok &= check(f"自我對局至少合成到 9 號（實際 {peak}）", peak >= 9)

    print()
    print("全部通過 ✅" if all_ok else "有測試失敗 ❌")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
