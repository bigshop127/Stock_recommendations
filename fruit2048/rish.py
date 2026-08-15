"""手機本地端擷取／操控：透過 Shizuku 的 `rish_auto` 本機殼層直接執行
screencap／input，不用再跨 USB 呼叫 PC 上的 adb.exe。

這支模組只給**跑在手機本身（Termux）**的 Python 用，PC 端的 app.py 用不到它
──兩邊的差別純粹是「screencap/滑動這段指令去哪裡執行」：adb.py 是隔著 USB
線送給電腦上的 adb.exe 轉一手，這支是直接在本機殼層跑，省掉整段 USB 往返，
實測延遲從 400~460ms/幀掉到本機等級。

跟 adb.py 的 AdbGrabber／AdbController 介面刻意保持相容（.grab()／
.virtual_screen()／.play()），vision.py／solver.py 完全不用改一行。

不 import control.py：那支模組在載入時就直接 `ctypes.WinDLL("user32")`，
在 Linux/Android 上一 import 就會炸掉（WinDLL 不存在）。所以 InputError
跟 swipe_points() 這兩個小東西在這裡各自留一份，不是偷懶而是唯一選項。

截圖不走 rish 的 stdout relay：一張全解析度截圖 base64 編碼後動輒 1MB+，
實測這個管道扛不住這個量——不是常常逾時（8 秒），就是回傳的資料在中途被
截斷（跟 base64 字元數對不上 4 的倍數，明顯是傳輸中斷不是編碼錯誤）。改成
請 rish（shell 權限，寫哪都不受一般 App 的儲存空間限制）把截圖直接存成
檔案到共用儲存空間，這邊直接用 Python 的檔案 I/O 讀那個檔案——完全不經過
rish 的指令輸出通道，只有「執行 screencap 這個動作」本身還是靠 rish。
前提是使用者在 Termux 執行過一次 `termux-setup-storage` 並同意權限。
"""

from __future__ import annotations

import io
import os
import subprocess
from typing import Tuple

import numpy as np
from PIL import Image

import vision as V

RISH_BIN = os.environ.get("RISH_BIN", "rish_auto")

# 同一張截圖的兩個視角：DEVICE_SHOT_PATH 是 rish（shell 權限）眼中的路徑，
# TERMUX_SHOT_PATH 是 Termux 這邊讀同一個檔案要用的路徑（走 termux-setup-storage
# 建出來的 ~/storage/shared 符號連結）。
DEVICE_SHOT_PATH = "/sdcard/.fruit2048_shot.png"
TERMUX_SHOT_PATH = os.path.expanduser("~/storage/shared/.fruit2048_shot.png")


class RishError(OSError):
    """rish／Shizuku 相關的錯誤。是 OSError 的子類別，跟呼叫端既有的例外處理相容。"""


class InputError(RuntimeError):
    """送滑動指令失敗（多半是 Shizuku 服務斷了，USB 拔線或手機重開機後常見）。"""


def _run(*args: str, timeout: float = 10.0) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [RISH_BIN, "-c", " ".join(args)], capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise RishError(f"rish 沒回應（{timeout:.0f} 秒逾時）：{' '.join(args)}") from e
    except OSError as e:
        raise RishError(f"執行 {RISH_BIN} 失敗：{e}（Shizuku 環境是不是還沒裝好？）") from e


def swipe_points(region: V.Region, move: int, fraction: float = 0.35) -> Tuple[int, int, int, int]:
    """算出這個方向要從哪滑到哪（手機像素座標）。跟 control.swipe_points 邏輯一致。"""
    cx = region.left + region.width // 2
    cy = region.top + region.height // 2
    short = min(region.width, region.height)
    limit = max(1, short // 2 - 4)
    dist = int(min(max(8, short * fraction / 2), limit))

    import solver as S
    dx, dy = {S.UP: (0, -1), S.DOWN: (0, 1), S.LEFT: (-1, 0), S.RIGHT: (1, 0)}[move]
    return cx - dx * dist, cy - dy * dist, cx + dx * dist, cy + dy * dist


class RishGrabber:
    """跟 vision.ScreenGrabber／adb.AdbGrabber 介面相容，改成本機呼叫 rish。"""

    def __init__(self) -> None:
        self.backend = "rish"

    def _screencap(self) -> np.ndarray:
        proc = _run("screencap", "-p", DEVICE_SHOT_PATH, timeout=8.0)
        if proc.returncode != 0:
            raise RishError(f"screencap 失敗：{proc.stderr.decode('utf-8', 'replace').strip()}")
        try:
            with open(TERMUX_SHOT_PATH, "rb") as f:
                data = f.read()
        except OSError as e:
            raise RishError(
                f"screencap 存檔了，但讀不到（{TERMUX_SHOT_PATH}）：{e}"
                "。是不是還沒在 Termux 執行過 termux-setup-storage 並同意存取權限？"
            ) from e
        try:
            img = Image.open(io.BytesIO(data)).convert("RGB")
        except Exception as e:
            raise RishError(f"screencap 存的檔案不是有效圖片：{e}") from e
        return np.asarray(img)

    def virtual_screen(self) -> V.Region:
        """回傳目前這張截圖實際的寬高（不是問 wm size——理由跟 adb.py 一樣：
        手機轉向玩遊戲時，wm size 報的是面板原生方向，會跟真正截出來的畫面對不上）。
        """
        h, w = self._screencap().shape[:2]
        return V.Region(0, 0, w, h)

    def grab(self, region: V.Region) -> np.ndarray:
        if region.width <= 0 or region.height <= 0:
            raise ValueError(f"擷取範圍不合法：{region}")
        full = self._screencap()
        h, w = full.shape[:2]
        if region.left < 0 or region.top < 0 or region.right > w or region.bottom > h:
            raise ValueError(f"擷取範圍超出手機畫面：{region}（手機畫面 {w}x{h}）")
        return full[region.top:region.bottom, region.left:region.right]


class RishController:
    """跟 control.Controller／adb.AdbController 介面相容，改成本機呼叫 rish。"""

    def __init__(self, duration: float = 0.14, fraction: float = 0.35) -> None:
        self.duration = duration
        self.fraction = fraction

    def play(self, region: V.Region, move: int) -> None:
        x0, y0, x1, y1 = swipe_points(region, move, self.fraction)
        ms = max(50, int(self.duration * 1000))
        proc = _run("input", "swipe", str(x0), str(y0), str(x1), str(y1), str(ms), timeout=8.0)
        if proc.returncode != 0:
            raise InputError(f"rish 送滑動失敗：{proc.stderr.decode('utf-8', 'replace').strip()}")


__all__ = [
    "RishError", "InputError", "RishGrabber", "RishController", "swipe_points",
    "RISH_BIN", "DEVICE_SHOT_PATH", "TERMUX_SHOT_PATH",
]
