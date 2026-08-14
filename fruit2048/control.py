"""Windows 輸入模擬：把建議的方向真的滑到模擬器上。

用 SendInput 而不是舊的 mouse_event / keybd_event，因為 SendInput 送出的事件會走
完整的輸入佇列，模擬器與遊戲比較認得。滑動座標一律用「虛擬桌面絕對座標」，
多螢幕與 DPI 縮放都不會跑掉（前提是行程已宣告 DPI aware，app.py 開頭就做了）。

安全設計：
  * 這個模組只提供動作，不自己決定何時動作。要不要自動玩由 app.py 控制。
  * panic_pressed() 讓呼叫端隨時能問「使用者是不是按了緊急停止鍵」，
    而且用 GetAsyncKeyState，不需要視窗有焦點也讀得到。
  * swipe() 做完會把滑鼠移回原位，不然使用者的游標會被丟在遊戲畫面中間。
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from typing import Dict, Optional, Tuple

import solver as S

user32 = ctypes.WinDLL("user32", use_last_error=True)

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

MAPVK_VK_TO_VSC = 0

# 方向鍵（模擬器有設按鍵對應時可以用）
VK_ARROW = {S.UP: 0x26, S.DOWN: 0x28, S.LEFT: 0x25, S.RIGHT: 0x27}
VK_WASD = {S.UP: 0x57, S.DOWN: 0x53, S.LEFT: 0x41, S.RIGHT: 0x44}

# 緊急停止鍵候選（設定檔用名字指定）
PANIC_KEYS: Dict[str, int] = {
    "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79,
    "F11": 0x7A, "F12": 0x7B, "ESC": 0x1B, "SCROLLLOCK": 0x91,
}
DEFAULT_PANIC_KEY = "F8"


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class _InputUnion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _InputUnion)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class InputError(RuntimeError):
    """SendInput 被擋下來了（多半是遊戲以系統管理員身分執行）。"""


def _send(*inputs: INPUT) -> None:
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), ctypes.byref(array), ctypes.sizeof(INPUT))
    if sent != len(inputs):
        err = ctypes.get_last_error()
        raise InputError(
            f"SendInput 只送出 {sent}/{len(inputs)} 個事件（WinError {err}）。"
            f"如果模擬器是用「以系統管理員身分執行」開的，這個輔助器也要用系統管理員身分開才送得進去。"
        )


def virtual_screen() -> Tuple[int, int, int, int]:
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def _normalize(x: int, y: int) -> Tuple[int, int]:
    """螢幕座標 → SendInput 要的 0..65535 虛擬桌面正規化座標。"""
    vx, vy, vw, vh = virtual_screen()
    nx = int(round((x - vx) * 65535 / max(1, vw - 1)))
    ny = int(round((y - vy) * 65535 / max(1, vh - 1)))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def cursor_position() -> Tuple[int, int]:
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def _mouse(flags: int, x: Optional[int] = None, y: Optional[int] = None) -> INPUT:
    dx, dy = (0, 0)
    if x is not None and y is not None:
        dx, dy = _normalize(x, y)
        flags |= MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(dx, dy, 0, flags, 0, 0)
    return inp


def move_to(x: int, y: int) -> None:
    _send(_mouse(MOUSEEVENTF_MOVE, x, y))


def panic_pressed(key: str = DEFAULT_PANIC_KEY) -> bool:
    """使用者現在有沒有按著緊急停止鍵。不需要視窗焦點。"""
    vk = PANIC_KEYS.get(key.upper())
    if vk is None:
        return False
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def swipe(
    x0: int, y0: int, x1: int, y1: int,
    duration: float = 0.14,
    steps: int = 14,
    restore_cursor: bool = True,
) -> None:
    """從 (x0,y0) 按住拖到 (x1,y1) 再放開。

    按下之後、放開之前都刻意停一下：觸控手勢的辨識通常要看得到「按住 → 移動 → 放開」
    三個階段，太快的話會被當成點擊而不是滑動。
    """
    origin = cursor_position() if restore_cursor else None
    steps = max(2, steps)
    per_step = max(0.0, duration) / steps

    try:
        move_to(x0, y0)
        time.sleep(0.02)
        _send(_mouse(MOUSEEVENTF_LEFTDOWN))
        time.sleep(0.03)

        for i in range(1, steps + 1):
            t = i / steps
            move_to(int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t)))
            time.sleep(per_step)

        time.sleep(0.03)
        _send(_mouse(MOUSEEVENTF_LEFTUP))
    finally:
        if origin is not None:
            try:
                move_to(*origin)
            except InputError:
                pass


def tap_key(vk: int, extended: bool = True, hold: float = 0.04) -> None:
    scan = user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if extended else 0)

    down = INPUT(type=INPUT_KEYBOARD)
    down.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    up = INPUT(type=INPUT_KEYBOARD)
    up.ki = KEYBDINPUT(0, scan, flags | KEYEVENTF_KEYUP, 0, 0)

    _send(down)
    time.sleep(max(0.0, hold))
    _send(up)


# ---------------------------------------------------------------- 對應到盤面

def swipe_points(
    region, move: int, fraction: float = 0.35
) -> Tuple[int, int, int, int]:
    """算出這個方向要從哪滑到哪（螢幕座標）。

    起點固定在盤面正中央：那裡一定是遊戲的操作區，不會不小心壓到旁邊的按鈕。
    滑動距離取盤面短邊的一個比例，太短會被當成點擊、太長會滑出盤面
    （滑出去可能壓到遊戲介面上別的按鈕，所以起訖點一律夾在盤面內）。
    """
    cx = region.left + region.width // 2
    cy = region.top + region.height // 2
    short = min(region.width, region.height)
    limit = max(1, short // 2 - 4)          # 距離邊緣至少留 4px
    dist = int(min(max(8, short * fraction / 2), limit))

    dx, dy = {S.UP: (0, -1), S.DOWN: (0, 1), S.LEFT: (-1, 0), S.RIGHT: (1, 0)}[move]
    return cx - dx * dist, cy - dy * dist, cx + dx * dist, cy + dy * dist


class Controller:
    """把「往哪個方向」翻譯成實際的輸入動作。"""

    METHODS = ("swipe", "arrows", "wasd")

    def __init__(
        self,
        method: str = "swipe",
        fraction: float = 0.35,
        duration: float = 0.14,
        steps: int = 14,
    ) -> None:
        if method not in self.METHODS:
            raise ValueError(f"不認得的操控方式：{method}")
        self.method = method
        self.fraction = fraction
        self.duration = duration
        self.steps = steps

    def play(self, region, move: int) -> None:
        if self.method == "swipe":
            x0, y0, x1, y1 = swipe_points(region, move, self.fraction)
            swipe(x0, y0, x1, y1, self.duration, self.steps)
        elif self.method == "arrows":
            tap_key(VK_ARROW[move], extended=True)
        else:
            tap_key(VK_WASD[move], extended=False)


__all__ = [
    "Controller", "InputError", "swipe", "swipe_points", "tap_key", "move_to",
    "cursor_position", "panic_pressed", "virtual_screen",
    "PANIC_KEYS", "DEFAULT_PANIC_KEY", "VK_ARROW", "VK_WASD",
]
