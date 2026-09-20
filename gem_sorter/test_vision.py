"""辨識層測試：用使用者給的真實截圖（testdata/）逐張核對盤面。

不開視窗、不碰桌面，純讀圖。期望值是逐張人工對照畫面寫的（由下往上）：
  '#' = 藍罐鎖頭底下看不到的那顆；'?' = 黑色問號寶石。
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vision as V  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata")

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


def load(name: str) -> np.ndarray:
    return np.array(Image.open(os.path.join(DATA, name)).convert("RGB"))


R, F, B, G, M, VI, T, A = "ruby", "fire", "blue", "green", "magenta", "violet", "teal", "amber"

# (排, 根) -> (種類, 內容由下往上)
EXPECT = {
    "lvl1-2_0_start.png": {
        (0, 0): ("normal", [R, R, F, B]), (0, 1): ("normal", [F, G, B]),
        (0, 2): ("normal", [VI, M]), (0, 3): ("jar", ["#", VI, G, G]), (0, 4): ("normal", [VI, G]),
        (1, 0): ("normal", [F, B]), (1, 1): ("normal", [F, B]),
        (1, 2): ("fixed", [M, M]), (1, 3): ("normal", []), (1, 4): ("normal", [R, R, M]),
    },
    "lvl1-2_1_blue_done_jar_unlocked.png": {
        (0, 0): ("normal", [R, R, F]), (0, 1): ("normal", [F, G]),
        (0, 2): ("normal", [VI, M]), (0, 3): ("normal", [VI, VI, G, G]), (0, 4): ("normal", [VI, G]),
        (1, 0): ("normal", [F]), (1, 1): ("normal", [F]),
        (1, 2): ("fixed", [M, M]), (1, 3): ("normal", [B, B, B, B]), (1, 4): ("normal", [R, R, M]),
    },
    "lvl1-2_2_purple_done.png": {
        (0, 0): ("normal", [R, R, F]), (0, 1): ("normal", [F, G]),
        (0, 2): ("normal", [VI]), (0, 3): ("normal", [VI, VI, G, G]), (0, 4): ("normal", [VI, G]),
        (1, 0): ("normal", [F]), (1, 1): ("normal", [F]),
        (1, 2): ("fixed", [M, M, M, M]), (1, 3): ("normal", [B, B, B, B]), (1, 4): ("normal", [R, R]),
    },
    "lvl1-2_3_fire_done_banner.png": {
        (0, 0): ("normal", [R, R]), (0, 1): ("normal", []),
        (0, 2): ("normal", [VI]), (0, 3): ("normal", [VI, VI, G, G]), (0, 4): ("normal", [VI, G, G]),
        (1, 0): ("normal", [F, F, F, F]), (1, 1): ("normal", []),
        (1, 2): ("fixed", [M, M, M, M]), (1, 3): ("normal", [B, B, B, B]), (1, 4): ("normal", [R, R]),
    },
    "lvl1-3_0_start.png": {
        (0, 0): ("normal", [F, F, M]), (0, 1): ("normal", []),
        (0, 2): ("jar", ["#", G, G, B]), (0, 3): ("normal", [M, G, B]),
        (1, 0): ("normal", [F, M, G]), (1, 1): ("normal", []), (1, 2): ("normal", [F, B, B]),
    },
    # 9/20 實機卡住的那一幀（走了 2 步後）：藍罐裡的綠讀 128°，夾在真綠 115° 跟暫存假色 142° 中間
    "lvl1-3_1_jar_green_glow.png": {
        (0, 0): ("normal", [F, F, M]), (0, 1): ("normal", []),
        (0, 2): ("jar", ["#", G, G, B]), (0, 3): ("normal", [M]),
        (1, 0): ("normal", [F, M, G, G]), (1, 1): ("normal", []), (1, 2): ("normal", [F, B, B, B]),
    },
    # 9/20 實機（1-6 一開場就卡住）：藍罐裡有問號寶石 [鎖, ?, 紫, 紫]。霜光把黑色問號洗成灰色，
    # 舊版讀成「空」→ 「寶石中間有空隙」。看不見 4 顆＝缺紅1、火1、紫羅蘭2，剛好對上
    "lvl1-6_0_start_jar_hidden.png": {
        (0, 0): ("normal", [G, B]), (0, 1): ("jar", ["#", "?", M, M]), (0, 2): ("normal", [R, F, G]),
        (0, 3): ("normal", ["?", "?", M, M]), (0, 4): ("normal", [R, F, G, B]),
        (1, 0): ("fixed", [B]), (1, 1): ("normal", [R, B]), (1, 2): ("normal", [VI, VI, G]),
        (1, 3): ("normal", []), (1, 4): ("normal", [F]),
    },
    # 9/20 實機（1-6 走到第 17 步）：[?, 紫, 紫, 紫]——問號被上面三顆壓著、其實也是紫，但遊戲不會自動合成，
    # 要先把上面三顆搬去空管、問號顯現後再湊（使用者當面確認）。舊求解器把 ? 代入紫就當成已合成 → 「找不到解」
    "lvl1-6_1_hidden_bottom_under_three.png": {
        (0, 0): ("normal", [M, M, M, M]), (0, 1): ("normal", []), (0, 2): ("normal", [R, R, R, R]),
        (0, 3): ("normal", ["?", VI, VI, VI]), (0, 4): ("normal", []),
        (1, 0): ("fixed", [B, B, B, B]), (1, 1): ("normal", [G, G, G, G]), (1, 2): ("normal", [F, F, F, F]),
        (1, 3): ("normal", []), (1, 4): ("normal", []),
    },
    "lvl2-1_start.png": {
        (0, 0): ("fixed", [G, G]), (0, 1): ("normal", [VI, A, G, G]),
        (0, 2): ("normal", [T, "?", R, R]), (0, 3): ("normal", [G, "?", F, B]),
        (0, 4): ("fixed", [M]), (0, 5): ("normal", ["?", T, VI, M]), (0, 6): ("normal", ["?", VI, G]),
        (1, 0): ("sealed", []), (1, 1): ("jar", ["#", VI]),
        (1, 2): ("jar", ["#", VI, F, B]), (1, 3): ("normal", []),
        (1, 4): ("jar", ["#", F, M, B]), (1, 5): ("normal", [T, T, A, R]),
        (1, 6): ("normal", [R, F, M, B]),
    },
}


def test_boards() -> None:
    print("[1] 六種畫面的盤面逐格核對")
    for name, expect in EXPECT.items():
        img = load(name)
        t0 = time.perf_counter()
        board = V.build_board(img, V.Palette())
        dt = (time.perf_counter() - t0) * 1000
        check(f"{name}: 讀得到盤面（{dt:.0f} ms）", board is not None)
        if board is None:
            continue
        got = {(t.row, t.col): (t.kind, t.cells) for t in board.tubes}
        check(f"{name}: 管子數量 {len(expect)}", len(got) == len(expect), f"讀到 {len(got)}")
        bad = []
        for pos, (kind, cells) in expect.items():
            g = got.get(pos)
            if g is None or g[0] != kind or g[1] != cells:
                bad.append(f"{pos}: 期望 {kind}{cells} 讀到 {g}")
        check(f"{name}: 每根管種類與內容全對", not bad, "; ".join(bad))
        check(f"{name}: 沒有疑點", board.ok, "; ".join(board.problems))


def test_non_level_screens() -> None:
    print("[2] 結算畫面不會被當成關卡")
    for name in ("lvl1-2_4_clear_reward.png", "lvl1-2_5_clear_result.png"):
        board = V.build_board(load(name), V.Palette())
        check(f"{name}: 不是關卡（沒有盤面）", board is None)


def test_scale_invariance() -> None:
    print("[3] 縮放不影響（模擬使用者框的範圍大小不同）")
    for name in ("lvl1-2_0_start.png", "lvl1-3_0_start.png"):
        base = V.build_board(load(name), V.Palette())
        for scale in (0.75, 1.3):
            im = Image.open(os.path.join(DATA, name)).convert("RGB")
            im2 = im.resize((int(im.width * scale), int(im.height * scale)), Image.BILINEAR)
            board = V.build_board(np.array(im2), V.Palette())
            same = (board is not None and base is not None
                    and [(t.row, t.col, t.kind, t.cells) for t in board.tubes]
                    == [(t.row, t.col, t.kind, t.cells) for t in base.tubes])
            check(f"{name} 縮放 {scale}：結果不變", same,
                  "" if board is None else "; ".join(f"{t.row},{t.col}:{t.kind}{t.cells}" for t in board.tubes))


def test_crop_margins() -> None:
    print("[4] 框選範圍多包一圈黑邊／左側道具欄也不影響")
    for name in ("lvl1-2_0_start.png", "lvl2-1_start.png"):
        base = V.build_board(load(name), V.Palette())
        img = load(name)
        h, w = img.shape[:2]
        padded = np.zeros((h + 80, w + 120, 3), dtype=np.uint8)
        padded[40:40 + h, 60:60 + w] = img
        board = V.build_board(padded, V.Palette())
        same = (board is not None and base is not None
                and [(t.row, t.col, t.kind, t.cells) for t in board.tubes]
                == [(t.row, t.col, t.kind, t.cells) for t in base.tubes])
        check(f"{name} 外加黑邊：結果不變", same)
        # 只框盤面（裁掉左側道具欄與標題列）
        cropped = img[int(h * 0.18):int(h * 0.92), int(w * 0.14):int(w * 0.94)]
        board2 = V.build_board(cropped, V.Palette())
        same2 = (board2 is not None and base is not None
                 and [(t.row, t.col, t.kind, t.cells) for t in board2.tubes]
                 == [(t.row, t.col, t.kind, t.cells) for t in base.tubes])
        check(f"{name} 只框盤面（裁掉側欄標題）：結果不變", same2)


def test_screens() -> None:
    print("[5] 畫面分類：關卡／獎勵／結算／認不得，以及要點的位置")
    pal = V.Palette()
    for name in ("lvl1-2_0_start.png", "lvl1-2_3_fire_done_banner.png", "lvl1-3_0_start.png", "lvl2-1_start.png"):
        info = V.analyze(load(name), pal)
        check(f"{name}: 關卡", info.kind == "level" and info.board is not None, info.kind)
    img = load("lvl1-2_4_clear_reward.png")
    info = V.analyze(img, pal)
    check("獎勵畫面（按鈕是暗的）→ reward", info.kind == "reward", info.kind)
    if info.target:
        h, w = img.shape[:2]
        tx, ty = info.target[0] / w, info.target[1] / h
        check("獎勵畫面：點在按鈕上方的空白處（不會誤點按鈕）", 0.3 < tx < 0.7 and 0.45 < ty < 0.75, f"({tx:.2f},{ty:.2f})")
    img = load("lvl1-2_5_clear_result.png")
    info = V.analyze(img, pal)
    check("結算畫面（按鈕是亮的）→ result", info.kind == "result", info.kind)
    if info.target:
        h, w = img.shape[:2]
        tx, ty = info.target[0] / w, info.target[1] / h
        # 「下一關」按鈕實測在 (0.682, 0.849) 附近；誤點到「分享」(0.50) 或「返回」(0.32) 就出事了
        check("結算畫面：點在右邊那顆黃鈕「下一關」上", abs(tx - 0.682) < 0.03 and abs(ty - 0.849) < 0.03, f"({tx:.3f},{ty:.3f})")
    black = np.zeros((600, 1000, 3), dtype=np.uint8)
    check("全黑畫面 → unknown", V.analyze(black, pal).kind == "unknown")
    noise = np.random.default_rng(0).integers(0, 255, (600, 1000, 3), dtype=np.uint8)
    check("雜訊畫面 → unknown（不會被當成關卡或按鈕）", V.analyze(noise, pal).kind == "unknown")
    for scale in (0.7, 1.4):
        im = Image.open(os.path.join(DATA, "lvl1-2_5_clear_result.png")).convert("RGB")
        im2 = np.array(im.resize((int(im.width * scale), int(im.height * scale)), Image.BILINEAR))
        i2 = V.analyze(im2, pal)
        ok = i2.kind == "result" and abs(i2.target[0] / im2.shape[1] - 0.682) < 0.03
        check(f"結算畫面縮放 {scale} 仍認得、按鈕位置對", ok, f"{i2.kind} {i2.target}")


def test_robustness() -> None:
    print("[6] 抗干擾：雜訊、亮度 ±8%、輕微模糊、縮放（模擬器視窗大小不同/縮放平滑）")
    rng = np.random.default_rng(1)

    def variants(img):
        a = img.astype(np.float32)
        yield "雜訊 σ6", np.clip(a + rng.normal(0, 6, a.shape), 0, 255).astype(np.uint8)
        yield "亮度 ×0.92", np.clip(a * 0.92, 0, 255).astype(np.uint8)
        yield "亮度 ×1.08", np.clip(a * 1.08, 0, 255).astype(np.uint8)
        im = Image.fromarray(img)
        yield "模糊 1px", np.array(im.filter(ImageFilter.GaussianBlur(1.0)))
        for sc in (0.6, 0.5):
            yield f"縮放 {sc}", np.array(im.resize((int(im.width * sc), int(im.height * sc)), Image.BILINEAR))

    bad = []
    total = 0
    for name in EXPECT:
        img = load(name)
        base = [(t.row, t.col, t.kind, t.cells) for t in V.build_board(img, V.Palette()).tubes]
        for label, v in variants(img):
            total += 1
            b = V.build_board(v, V.Palette())
            got = None if b is None else [(t.row, t.col, t.kind, t.cells) for t in b.tubes]
            if got != base:
                bad.append(f"{name}/{label}")
    check(f"{total} 種干擾組合，盤面全部跟原圖一致", not bad, "; ".join(bad))


def test_palette_pollution() -> None:
    print("[7] 色盤汙染回歸：暫存假色不跨畫面、藍罐不學新色（9/20 實機卡死）")
    img = load("lvl1-3_1_jar_green_glow.png")

    # 前一張畫面留下的暫存假色 h142：舊版會讓藍罐的綠(128°)在 115°/142° 之間「分不清」而卡死
    pal = V.Palette()
    pal._pending["h142"] = 142.0
    pal._pending["h276"] = 275.7
    board = V.build_board(img, pal)
    check("暫存假色不帶進下一張畫面：盤面讀得準", board is not None and board.ok,
          "" if board is None else "; ".join(board.problems))
    check("讀完後暫存區只剩這一張畫面自己的新色（沒有假色殘留）",
          "h142" not in pal._pending and "h276" not in pal._pending, str(pal._pending))

    # 藍罐（有霜）：色相偏移範圍內照常歸類；偏過頭時只說「分不清」，絕不學成新顏色
    pal = V.Palette()
    check("藍罐綠 128° → green、不含糊", pal.classify(128.0, frosted=True) == ("green", False))
    name, amb = pal.classify(142.0, frosted=True)
    check("藍罐綠偏到 142° → 分不清但不開新色", amb and name == "green" and not pal._pending, f"{name} {amb} {pal._pending}")
    pal = V.Palette()
    pal.hues = {"green": 115.0}
    n2, _ = pal.classify(210.0, frosted=True)
    check("藍罐裡離所有已知色 ≥45° 的顏色仍學得到（只有綠的色盤遇到 210°）", n2.startswith("h") and n2 in pal._pending, n2)

    # 一般管子的新顏色照舊：同一張畫面內認得出來、commit 後寫進去
    pal = V.Palette()
    n3, a3 = pal.classify(276.0)
    n4, a4 = pal.classify(277.0)
    check("一般管子新顏色：同一張畫面內第二顆歸到同一個新色", n3 == n4 and not a3 and not a4, f"{n3} {n4}")
    pal.commit()
    check("commit 後轉正", n3 in pal.hues and not pal._pending)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    test_boards()
    test_non_level_screens()
    test_scale_invariance()
    test_crop_margins()
    test_screens()
    test_robustness()
    test_palette_pollution()
    print(f"\n{_passed} 項通過，{_failed} 項失敗")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
