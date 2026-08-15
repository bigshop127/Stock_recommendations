"""adb.py 的驗證。

這支測試全程用假的 `_run`（monkeypatch），不需要真的裝 adb、也不需要接手機——
邏輯本身（裝置狀態怎麼判斷、擷取範圍怎麼裁切、失敗要丟哪種例外）都能在沒有
真實裝置的機器上測。實機（Samsung A54，USB）驗證另外用手動腳本跑過，不放進
這支自動化測試裡，因為別台機器不會接著同一支手機。

    python test_adb.py
"""

from __future__ import annotations

import io
import subprocess
import sys
from typing import List

import numpy as np
from PIL import Image

import adb as ADB
import control as C
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
    """取代 adb._run：依呼叫順序回傳預先排好的結果，順便記錄實際下了什麼指令。"""

    def __init__(self, scripted: List[tuple]) -> None:
        self.scripted = list(scripted)   # [(returncode, stdout_bytes, stderr_bytes), ...]
        self.calls: List[tuple] = []

    def __call__(self, adb_path, *args, timeout=10.0):
        self.calls.append(args)
        if not self.scripted:
            raise AssertionError(f"沒有預先安排的回應了，但又被呼叫：{args}")
        code, out, err = self.scripted.pop(0)
        return subprocess.CompletedProcess(args=list(args), returncode=code,
                                            stdout=out, stderr=err)


def png_bytes(w: int, h: int, fill=(30, 60, 90)) -> bytes:
    img = Image.new("RGB", (w, h), fill)
    # 塗一格看得出方向的標記，裁切測試才有辦法驗證裁對了地方
    for x in range(min(5, w)):
        for y in range(min(5, h)):
            img.putpixel((x, y), (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main():
    print("1) list_devices：解析 `adb devices` 的輸出")
    real_run = ADB._run
    try:
        ADB._run = FakeRun([
            (0, b"List of devices attached\nABC123\tdevice\nXYZ999\tunauthorized\n\n", b""),
        ])
        devices = ADB.list_devices("adb")
        check("解析出兩台裝置", devices == [("ABC123", "device"), ("XYZ999", "unauthorized")],
              f"{devices}")

        ADB._run = FakeRun([(0, b"List of devices attached\n", b"")])
        check("沒有裝置回空清單", ADB.list_devices("adb") == [])
    finally:
        ADB._run = real_run

    print("2) pick_device：怎麼決定要對哪台裝置下手")
    def with_devices(pairs):
        return FakeRun([(0, ("List of devices attached\n" +
                             "\n".join(f"{s}\t{st}" for s, st in pairs)).encode(), b"")])

    try:
        ADB._run = with_devices([("ABC123", "device")])
        check("剛好一台已授權 → 自動選中", ADB.pick_device("adb") == "ABC123")

        ADB._run = with_devices([("ABC123", "device"), ("DEF456", "device")])
        try:
            ADB.pick_device("adb")
            check("多台已授權要停下來問，不能亂猜", False)
        except ADB.AdbError as e:
            check("多台已授權要停下來問，不能亂猜", "2 台" in str(e), str(e))

        ADB._run = with_devices([("XYZ999", "unauthorized")])
        try:
            ADB.pick_device("adb")
            check("只有未授權裝置要講清楚原因", False)
        except ADB.AdbError as e:
            check("只有未授權裝置要講清楚原因", "授權" in str(e), str(e))

        ADB._run = with_devices([])
        try:
            ADB.pick_device("adb")
            check("完全沒裝置要講清楚原因", False)
        except ADB.AdbError as e:
            check("完全沒裝置要講清楚原因", "沒看到任何裝置" in str(e), str(e))

        ADB._run = with_devices([("ABC123", "device"), ("DEF456", "device")])
        check("有指定序號就用指定的，不管還有誰在", ADB.pick_device("adb", "DEF456") == "DEF456")

        ADB._run = with_devices([("ABC123", "unauthorized")])
        try:
            ADB.pick_device("adb", "ABC123")
            check("指定的序號狀態不是 device 要擋下來", False)
        except ADB.AdbError as e:
            check("指定的序號狀態不是 device 要擋下來", "unauthorized" in str(e), str(e))

        ADB._run = with_devices([("ABC123", "device")])
        try:
            ADB.pick_device("adb", "NOPE")
            check("指定的序號根本不存在要講清楚", False)
        except ADB.AdbError as e:
            check("指定的序號根本不存在要講清楚", "NOPE" in str(e), str(e))
    finally:
        ADB._run = real_run

    print("3) screen_size：解析 `wm size`")
    try:
        ADB._run = FakeRun([(0, b"Physical size: 1080x2340\n", b"")])
        check("解析出手機解析度", ADB.screen_size("adb", "ABC123") == (1080, 2340))

        ADB._run = FakeRun([(0, b"???\n", b"")])
        try:
            ADB.screen_size("adb", "ABC123")
            check("格式不對要講清楚，不要裝沒事", False)
        except ADB.AdbError:
            check("格式不對要講清楚，不要裝沒事", True)
    finally:
        ADB._run = real_run

    # AdbGrabber/AdbController 是懶得解析裝置的：第一次真的呼叫 grab()/play() 時
    # 才會內部呼叫一次 pick_device()（也就是多打一次 `adb devices`），解析出來的
    # 序號會快取住，同一個物件之後就不會再問一次。每個新物件的第一次呼叫都要
    # 多排一組「裝置清單」的回應在最前面，之後的呼叫才只需要排真正要測的那個回應。
    DEVICES_ONE = (0, b"List of devices attached\nABC123\tdevice\n", b"")

    print("4) AdbGrabber：擷取＋裁切")
    try:
        png = png_bytes(200, 150)
        g = ADB.AdbGrabber(serial="ABC123", adb_path="adb")

        ADB._run = FakeRun([DEVICES_ONE, (0, png, b"")])
        full = g.grab(V.Region(0, 0, 200, 150))
        check("整張抓下來大小對", full.shape[:2] == (150, 200), f"{full.shape}")
        check("紅色標記在左上角，裁切方向沒錯", tuple(full[0, 0]) == (255, 0, 0), f"{full[0,0]}")

        ADB._run = FakeRun([(0, png, b"")])   # 序號已經快取了，這次不用再問一次裝置清單
        cropped = g.grab(V.Region(50, 40, 60, 30))
        check("裁切出來的大小對", cropped.shape[:2] == (30, 60), f"{cropped.shape}")
        check("裁切出來的內容對得上原圖同一個位置",
              np.array_equal(cropped, full[40:70, 50:110]))

        try:
            g.grab(V.Region(0, 0, -5, 10))
            check("非法範圍（負寬）擋下來", False)
        except ValueError:
            check("非法範圍（負寬）擋下來", True)

        ADB._run = FakeRun([(1, b"", b"Error: something broke")])
        try:
            g.grab(V.Region(0, 0, 10, 10))
            check("screencap 失敗要轉成清楚的錯誤", False)
        except ADB.AdbError as e:
            check("screencap 失敗要轉成清楚的錯誤", "something broke" in str(e), str(e))
            check("AdbError 是 OSError，跟 Engine 既有的例外處理相容", isinstance(e, OSError))

        ADB._run = FakeRun([(0, b"not a png at all", b"")])
        try:
            g.grab(V.Region(0, 0, 10, 10))
            check("回傳的不是圖片要講清楚，不要整個炸掉", False)
        except ADB.AdbError:
            check("回傳的不是圖片要講清楚，不要整個炸掉", True)

        g2 = ADB.AdbGrabber(serial="ABC123", adb_path="adb")
        ADB._run = FakeRun([DEVICES_ONE, (0, png_bytes(50, 50), b"")])
        try:
            g2.grab(V.Region(0, 0, 999, 999))
            check("要求的範圍超出手機畫面要擋下來", False)
        except ValueError as e:
            check("要求的範圍超出手機畫面要擋下來", "超出" in str(e), str(e))
    finally:
        ADB._run = real_run

    print("5) AdbController：滑動指令組得對、失敗轉成 control.InputError")
    try:
        ctl = ADB.AdbController(serial="ABC123", adb_path="adb", duration=0.2, fraction=0.35)
        region = V.Region(0, 0, 400, 400)

        runner = FakeRun([DEVICES_ONE, (0, b"", b"")])
        ADB._run = runner
        import solver as S
        ctl.play(region, S.RIGHT)
        cmd = runner.calls[-1]
        check("指令是 shell input swipe", cmd[:4] == ("-s", "ABC123", "shell", "input"),
              f"{cmd}")
        check("滑動時間換算成毫秒", cmd[-1] == "200", f"{cmd}")
        x0, y0, x1, y1 = C.swipe_points(region, S.RIGHT, 0.35)
        check("起訖點座標跟 swipe_points 算的一樣",
              cmd[5:9] == (str(x0), str(y0), str(x1), str(y1)), f"{cmd}")

        ADB._run = FakeRun([(1, b"", b"device offline")])
        try:
            ctl.play(region, S.RIGHT)
            check("送滑動失敗要轉成 control.InputError（Engine._play 只接這個）", False)
        except C.InputError as e:
            check("送滑動失敗要轉成 control.InputError（Engine._play 只接這個）",
                  "device offline" in str(e), str(e))
    finally:
        ADB._run = real_run

    print("6) find_adb：PATH 上找得到就直接用")
    import shutil as _shutil
    real_which = _shutil.which
    try:
        _shutil.which = lambda name: "C:\\fake\\adb.exe" if name == "adb" else None
        check("PATH 上有就回傳那個路徑", ADB.find_adb() == "C:\\fake\\adb.exe")
    finally:
        _shutil.which = real_which

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
