"""ADB 擷取／操控：跟 vision.ScreenGrabber／control.Controller 介面相容，
換成從 adb 認得到的裝置（USB 接的實體手機）抓畫面、送手勢。

跟 PC 模擬器那條路（mss 截桌面）比，這條路每次擷取都要重新透過 USB 呼叫一次
adb 子行程，實測（Samsung A54，USB 線）一輪 400~460ms，比桌面截圖慢一個數量級。
這是「每一幀都重新啟動 adb」這個機制本身的固有成本，不是這支模組能調的參數；
想要更快只能換掉這個機制（例如常駐裝置端的擷取服務），這版先不做，見 README。
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image

import control as C
import vision as V

# Windows 上跑 subprocess 預設會跳出一個黑色主控台視窗，adb 每次呼叫都跳一下很擾人。
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_DEVICE_LINE = re.compile(r"^(\S+)\s+(\w+)")
_SIZE_LINE = re.compile(r"(\d+)x(\d+)")


class AdbError(OSError):
    """adb 相關的錯誤（找不到 adb、抓不到裝置、screencap 失敗…）。

    是 OSError 的子類別，跟 Engine.step()／_play() 既有的例外處理相容，
    不用另外改那邊的 except 子句。
    """


def find_adb() -> str:
    """找 adb.exe 的路徑：PATH 上有就直接用，沒有就試常見的安裝位置。"""
    found = shutil.which("adb")
    if found:
        return found
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Android\platform-tools\adb.exe"),
        os.path.expandvars(r"%ANDROID_HOME%\platform-tools\adb.exe"),
        os.path.expandvars(r"%ANDROID_SDK_ROOT%\platform-tools\adb.exe"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    raise AdbError(
        "找不到 adb。請安裝 Android SDK Platform-Tools"
        "（https://developer.android.com/tools/releases/platform-tools），"
        "並確定 adb.exe 在 PATH 上。"
    )


def _run(adb_path: str, *args: str, timeout: float = 10.0) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [adb_path, *args], capture_output=True, timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as e:
        raise AdbError(f"adb 沒回應（{timeout:.0f} 秒逾時）：{' '.join(args)}") from e
    except OSError as e:
        raise AdbError(f"執行 adb 失敗：{e}") from e


def list_devices(adb_path: Optional[str] = None) -> List[Tuple[str, str]]:
    """回傳 [(序號, 狀態), ...]。狀態通常是 device／unauthorized／offline。"""
    adb_path = adb_path or find_adb()
    out = _run(adb_path, "devices").stdout.decode("utf-8", "replace")
    devices = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        m = _DEVICE_LINE.match(line)
        if m:
            devices.append((m.group(1), m.group(2)))
    return devices


def pick_device(adb_path: Optional[str] = None, serial: Optional[str] = None) -> str:
    """決定要對哪台裝置下手。

    有指定序號就檢查它在不在、狀態是不是「device」（已授權）；沒指定就在已授權的
    裝置裡挑，剛好一台才自動選——零台或多台都不該用猜的，寧可停下來問清楚。
    """
    adb_path = adb_path or find_adb()
    devices = list_devices(adb_path)
    if serial:
        for s, state in devices:
            if s == serial:
                if state != "device":
                    raise AdbError(f"裝置「{serial}」狀態是「{state}」，不是「device」"
                                   f"（多半要在手機螢幕上按一下允許 USB 偵錯）。")
                return serial
        raise AdbError(f"adb 現在看不到裝置「{serial}」，確認線有接好、手機有開 USB 偵錯。")

    ready = [s for s, state in devices if state == "device"]
    if len(ready) == 1:
        return ready[0]
    if not ready:
        if devices:
            detail = "、".join(f"{s}（{state}）" for s, state in devices)
            raise AdbError(f"adb 看得到裝置但都還沒授權：{detail}。"
                           f"檢查手機螢幕，同意「允許 USB 偵錯」。")
        raise AdbError("adb 沒看到任何裝置。確認手機有接 USB 傳輸線、已開啟「USB 偵錯」。")
    raise AdbError(f"adb 看到 {len(ready)} 台已授權的裝置，"
                   f"請在設定裡指定要用哪一台的序號：{', '.join(ready)}")


def screen_size(adb_path: str, serial: str) -> Tuple[int, int]:
    out = _run(adb_path, "-s", serial, "shell", "wm", "size").stdout.decode("utf-8", "replace")
    m = _SIZE_LINE.search(out)
    if not m:
        raise AdbError(f"讀不到手機解析度（wm size 回傳：{out.strip()!r}）")
    return int(m.group(1)), int(m.group(2))


class AdbGrabber:
    """跟 vision.ScreenGrabber 介面相容，換成從手機抓畫面。

    adb 路徑跟裝置序號都是懶得決定的——建構子只存設定，真正去找 adb.exe、
    挑裝置是在第一次真的要抓畫面時才做，失敗就丟 AdbError（是 OSError），
    Engine.step() 既有的例外處理會接住轉成畫面上的錯誤訊息，不會讓
    Engine.rebuild() 因為手機還沒接上就整個炸掉。
    """

    def __init__(self, serial: Optional[str] = None, adb_path: Optional[str] = None) -> None:
        self.backend = "adb"
        self._adb_path = adb_path
        self._serial = serial
        self._resolved_serial: Optional[str] = None

    def _resolve(self) -> Tuple[str, str]:
        path = self._adb_path or find_adb()
        self._adb_path = path
        if self._resolved_serial is None:
            self._resolved_serial = pick_device(path, self._serial)
        return path, self._resolved_serial

    def virtual_screen(self) -> V.Region:
        path, serial = self._resolve()
        w, h = screen_size(path, serial)
        return V.Region(0, 0, w, h)

    def grab(self, region: V.Region) -> np.ndarray:
        if region.width <= 0 or region.height <= 0:
            raise ValueError(f"擷取範圍不合法：{region}")
        path, serial = self._resolve()
        proc = _run(path, "-s", serial, "exec-out", "screencap", "-p", timeout=8.0)
        if proc.returncode != 0 or not proc.stdout:
            raise AdbError(f"screencap 失敗：{proc.stderr.decode('utf-8', 'replace').strip()}")
        try:
            img = Image.open(io.BytesIO(proc.stdout)).convert("RGB")
        except Exception as e:
            raise AdbError(f"screencap 回傳的資料不是有效圖片：{e}") from e
        full = np.asarray(img)
        h, w = full.shape[:2]
        # 故意不夾住裁切範圍——手機解析度跟校準當下不一樣時（例如換了台裝置、
        # 螢幕轉向），裁出一塊尺寸不對的畫面丟給後面的格線辨識，只會產生一個
        # 看起來詭異的誤判，不如在這裡就直接講清楚「範圍對不上畫面」。
        if region.left < 0 or region.top < 0 or region.right > w or region.bottom > h:
            raise ValueError(f"擷取範圍超出手機畫面：{region}（手機畫面 {w}x{h}）")
        return full[region.top:region.bottom, region.left:region.right]


class AdbController:
    """跟 control.Controller 介面相容，換成用 `adb shell input swipe` 操控。

    起訖點的幾何算法直接借 control.swipe_points（純函式，region 進 region 出，
    不管背後是螢幕座標還是手機像素），失敗一律丟 control.InputError，
    Engine._play() 既有的例外處理會接住。
    """

    def __init__(self, serial: Optional[str] = None, adb_path: Optional[str] = None,
                 duration: float = 0.14, fraction: float = 0.35) -> None:
        self._adb_path = adb_path
        self._serial = serial
        self._resolved_serial: Optional[str] = None
        self.duration = duration
        self.fraction = fraction

    def _resolve(self) -> Tuple[str, str]:
        path = self._adb_path or find_adb()
        self._adb_path = path
        if self._resolved_serial is None:
            self._resolved_serial = pick_device(path, self._serial)
        return path, self._resolved_serial

    def play(self, region: V.Region, move: int) -> None:
        try:
            path, serial = self._resolve()
        except AdbError as e:
            raise C.InputError(str(e)) from e
        x0, y0, x1, y1 = C.swipe_points(region, move, self.fraction)
        ms = max(50, int(self.duration * 1000))
        proc = _run(path, "-s", serial, "shell", "input", "swipe",
                    str(x0), str(y0), str(x1), str(y1), str(ms), timeout=8.0)
        if proc.returncode != 0:
            raise C.InputError(f"adb 送滑動失敗：{proc.stderr.decode('utf-8', 'replace').strip()}")


__all__ = [
    "AdbError", "AdbGrabber", "AdbController",
    "find_adb", "list_devices", "pick_device", "screen_size",
]
