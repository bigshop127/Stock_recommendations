"""rish.py 的驗證。

跟 test_adb.py 同一套手法：monkeypatch `rish.subprocess.run`，不需要真的裝
Termux/Shizuku 就能測邏輯本身（指令組得對不對、截圖裁切、失敗要轉成哪種例外）。
跟 adb.py 的測試比起來少了「挑裝置」那一段——本機只有一支手機，沒有序號可選。

    python test_rish.py
"""

from __future__ import annotations

import io
import subprocess
import sys
from typing import List

import numpy as np
from PIL import Image

import rish as R
import vision as V

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_failures = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)
    return ok


class FakeRun:
    """取代 subprocess.run：依呼叫順序回傳預先排好的結果，記錄實際下了什麼指令。"""

    def __init__(self, scripted: List[tuple]) -> None:
        self.scripted = list(scripted)  # [(returncode, stdout_bytes, stderr_bytes), ...]
        self.calls: List[list] = []

    def __call__(self, cmd, capture_output=True, timeout=10.0):
        self.calls.append(cmd)
        if not self.scripted:
            raise AssertionError(f"沒有預先安排的回應了，但又被呼叫：{cmd}")
        code, out, err = self.scripted.pop(0)
        return subprocess.CompletedProcess(args=cmd, returncode=code, stdout=out, stderr=err)


def png_bytes(w: int, h: int, fill=(30, 60, 90)) -> bytes:
    img = Image.new("RGB", (w, h), fill)
    for x in range(min(5, w)):
        for y in range(min(5, h)):
            img.putpixel((x, y), (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main():
    real_run = subprocess.run

    print("1) _run：組出來的指令是 rish_auto -c \"<整串指令>\"")
    try:
        fake = FakeRun([(0, b"hello", b"")])
        subprocess.run = fake
        R._run("screencap", "-p")
        check("透過 rish_auto 呼叫，一整串指令合成單一參數",
              fake.calls[-1] == [R.RISH_BIN, "-c", "screencap -p"], f"{fake.calls[-1]}")
    finally:
        subprocess.run = real_run

    print("2) RishGrabber：擷取＋裁切")
    try:
        png = png_bytes(200, 150)
        g = R.RishGrabber()

        subprocess.run = FakeRun([(0, png, b"")])
        full = g.grab(V.Region(0, 0, 200, 150))
        check("整張抓下來大小對", full.shape[:2] == (150, 200), f"{full.shape}")
        check("紅色標記在左上角，裁切方向沒錯", tuple(full[0, 0]) == (255, 0, 0), f"{full[0,0]}")

        # 跟 adb.py 一樣的坑：手機橫向玩遊戲時，wm size 報的是面板原生方向，
        # 會跟真正截出來的畫面對不上，所以 virtual_screen() 得直接量截圖。
        landscape = png_bytes(2340, 1080)
        subprocess.run = FakeRun([(0, landscape, b"")])
        vs = g.virtual_screen()
        check("virtual_screen 用真的截圖量尺寸", (vs.width, vs.height) == (2340, 1080), f"{vs}")

        subprocess.run = FakeRun([(0, png, b"")])
        cropped = g.grab(V.Region(50, 40, 60, 30))
        check("裁切出來的大小對", cropped.shape[:2] == (30, 60), f"{cropped.shape}")
        check("裁切出來的內容對得上原圖同一個位置",
              np.array_equal(cropped, full[40:70, 50:110]))

        try:
            g.grab(V.Region(0, 0, -5, 10))
            check("非法範圍（負寬）擋下來", False)
        except ValueError:
            check("非法範圍（負寬）擋下來", True)

        subprocess.run = FakeRun([(1, b"", b"Error: something broke")])
        try:
            g.grab(V.Region(0, 0, 10, 10))
            check("screencap 失敗要轉成清楚的錯誤", False)
        except R.RishError as e:
            check("screencap 失敗要轉成清楚的錯誤", "something broke" in str(e), str(e))
            check("RishError 是 OSError，跟呼叫端既有的例外處理相容", isinstance(e, OSError))

        subprocess.run = FakeRun([(0, b"not a png at all", b"")])
        try:
            g.grab(V.Region(0, 0, 10, 10))
            check("回傳的不是圖片要講清楚，不要整個炸掉", False)
        except R.RishError:
            check("回傳的不是圖片要講清楚，不要整個炸掉", True)

        subprocess.run = FakeRun([(0, png_bytes(50, 50), b"")])
        try:
            g.grab(V.Region(0, 0, 999, 999))
            check("要求的範圍超出手機畫面要擋下來", False)
        except ValueError as e:
            check("要求的範圍超出手機畫面要擋下來", "超出" in str(e), str(e))
    finally:
        subprocess.run = real_run

    print("3) swipe_points：跟 control.swipe_points 邏輯一致")
    import solver as S
    region = V.Region(0, 0, 400, 400)
    x0, y0, x1, y1 = R.swipe_points(region, S.RIGHT, 0.35)
    check("往右滑：起訖點對稱分布在中央兩側、終點在右邊",
          x0 < 200 < x1 and y0 == 200 == y1, f"{(x0,y0,x1,y1)}")

    print("4) RishController：滑動指令組得對、失敗轉成 rish.InputError")
    try:
        ctl = R.RishController(duration=0.2, fraction=0.35)
        region = V.Region(0, 0, 400, 400)

        runner = FakeRun([(0, b"", b"")])
        subprocess.run = runner
        ctl.play(region, S.RIGHT)
        cmd = runner.calls[-1]
        check("指令是 rish_auto -c \"input swipe ...\"", cmd[0] == R.RISH_BIN and cmd[1] == "-c", f"{cmd}")
        check("滑動時間換算成毫秒", cmd[2].endswith(" 200"), f"{cmd}")
        check("起訖點座標跟 swipe_points 算的一樣",
              cmd[2] == f"input swipe {x0} {y0} {x1} {y1} 200", f"{cmd}")

        subprocess.run = FakeRun([(1, b"", b"device offline")])
        try:
            ctl.play(region, S.RIGHT)
            check("送滑動失敗要轉成 rish.InputError", False)
        except R.InputError as e:
            check("送滑動失敗要轉成 rish.InputError", "device offline" in str(e), str(e))
    finally:
        subprocess.run = real_run

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
