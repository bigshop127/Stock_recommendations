"""control.py 的驗證。

注意：這支測試會真的動一下滑鼠游標（移動幾十個 pixel 再移回來），
因為「SendInput 到底有沒有被系統擋掉」只有真的送一次才知道。
但它**不會按任何鍵或按鈕**，所以不會誤觸到任何東西。

    python test_control.py
"""

import sys
import time

import control as C
import solver as S
from vision import Region

# 中文版 Windows 的主控台預設是 cp950，印不出結尾那個 ✅/❌ 就會整支噴
# UnicodeEncodeError —— 測試明明全過，看起來卻像壞了。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_failures = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)
    return ok


def main():
    if sys.platform != "win32":
        print("這個模組只在 Windows 上有意義")
        return 0

    print("1) 滑動起訖點的幾何")
    region = Region(100, 200, 400, 400)
    cx, cy = 300, 400
    expect = {
        S.UP: "起點在下、終點在上",
        S.DOWN: "起點在上、終點在下",
        S.LEFT: "起點在右、終點在左",
        S.RIGHT: "起點在左、終點在右",
    }
    for move, desc in expect.items():
        x0, y0, x1, y1 = C.swipe_points(region, move)
        if move == S.UP:
            ok = x0 == x1 == cx and y0 > cy > y1
        elif move == S.DOWN:
            ok = x0 == x1 == cx and y0 < cy < y1
        elif move == S.LEFT:
            ok = y0 == y1 == cy and x0 > cx > x1
        else:
            ok = y0 == y1 == cy and x0 < cx < x1
        check(f"{S.MOVE_NAME[move]}：{desc}", ok, f"({x0},{y0}) → ({x1},{y1})")

    print("2) 起訖點一定要留在盤面內（滑出去會壓到遊戲別的按鈕）")
    cases = [
        Region(0, 0, 400, 400), Region(100, 200, 400, 460),
        Region(50, 50, 120, 400), Region(0, 0, 40, 40), Region(0, 0, 24, 24),
    ]
    all_in = True
    for r in cases:
        for frac in (0.1, 0.35, 0.6, 0.9):
            for move in S.MOVES:
                x0, y0, x1, y1 = C.swipe_points(r, move, frac)
                for x, y in ((x0, y0), (x1, y1)):
                    if not (r.left <= x <= r.right and r.top <= y <= r.bottom):
                        all_in = False
                        print(f"      超出：{tuple(r)} frac={frac} "
                              f"{S.MOVE_NAME[move]} → ({x},{y})")
    check("各種盤面大小 × 各種距離比例都在範圍內", all_in)

    print("3) 距離比例越大，滑得越遠")
    d = []
    for frac in (0.15, 0.35, 0.7):
        x0, _, x1, _ = C.swipe_points(Region(0, 0, 600, 600), S.RIGHT, frac)
        d.append(abs(x1 - x0))
    check("單調遞增", d[0] < d[1] < d[2], f"{d}")

    print("4) Controller 設定檢查")
    for method in C.Controller.METHODS:
        try:
            C.Controller(method=method)
            check(f"接受 {method}", True)
        except ValueError as e:
            check(f"接受 {method}", False, str(e))
    try:
        C.Controller(method="teleport")
        check("擋掉不認得的方式", False)
    except ValueError:
        check("擋掉不認得的方式", True)

    print("5) 座標正規化")
    vx, vy, vw, vh = C.virtual_screen()
    print(f"      虛擬桌面 {vw}x{vh} @ ({vx},{vy})")
    nx, ny = C._normalize(vx, vy)
    check("左上角 → (0,0)", (nx, ny) == (0, 0), f"({nx},{ny})")
    nx, ny = C._normalize(vx + vw - 1, vy + vh - 1)
    check("右下角 → (65535,65535)", (nx, ny) == (65535, 65535), f"({nx},{ny})")
    nx, ny = C._normalize(vx - 5000, vy - 5000)
    check("超出範圍會夾住不會變負數", (nx, ny) == (0, 0), f"({nx},{ny})")

    print("6) 緊急停止鍵")
    check("沒按著就是 False", C.panic_pressed("F8") is False)
    check("不認得的鍵名回 False 而不是炸掉", C.panic_pressed("NOT_A_KEY") is False)
    check("所有候選鍵都查得到", all(k in C.PANIC_KEYS for k in
                                     ("F7", "F8", "F9", "F10", "F11", "F12", "ESC")))

    print("7) SendInput 真的送得出去（只移動游標，不按任何鍵）")
    # 先確認沒有別的程式在搶滑鼠。全螢幕遊戲的視角控制會不斷把游標拉回中央，
    # 那種情況下「移回原位」本來就會對不上，不是 move_to 的問題。
    probe = C.cursor_position()
    time.sleep(0.15)
    hijacked = C.cursor_position() != probe
    if hijacked:
        print("      偵測到游標自己在動（多半有全螢幕遊戲在搶滑鼠），只做寬鬆檢查")

    origin = C.cursor_position()
    print(f"      目前游標 {origin}")
    target = (max(vx + 2, origin[0] - 60), max(vy + 2, origin[1] - 60))
    try:
        C.move_to(*target)
        time.sleep(0.08)
        moved = C.cursor_position()
        if hijacked:
            check("SendInput 沒被系統擋掉", True, f"送出後游標在 {moved}")
        else:
            check("游標有移動到指定位置",
                  abs(moved[0] - target[0]) <= 2 and abs(moved[1] - target[1]) <= 2,
                  f"目標 {target}，實際 {moved}")
            C.move_to(*origin)
            time.sleep(0.08)
            back = C.cursor_position()
            check("移得回原位",
                  abs(back[0] - origin[0]) <= 2 and abs(back[1] - origin[1]) <= 2, f"{back}")
    except C.InputError as e:
        check("SendInput 沒被擋掉", False, str(e))
    finally:
        try:
            C.move_to(*origin)
        except C.InputError:
            pass

    print()
    if _failures:
        print(f"有 {len(_failures)} 項失敗 ❌")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("全部通過 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
