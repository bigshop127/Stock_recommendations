"""寶石排序輔助器 —— 主程式。

跟水果2048／永夜迷城輔助器同一種用法：一個永遠置頂的小面板，停靠在螢幕右邊，模擬器留在左邊。

    python app.py

流程：
  ① 框選畫面範圍  在桌面上拖曳，框出模擬器裡的遊戲畫面（整個盤面在裡面就好，多包一點邊不影響）。
                   之後所有辨識與點擊都只發生在這個範圍裡，範圍外的東西程式完全看不到。
  ▶ 開始自動      程式讀懂盤面、規劃好就自己一步一步點；過關後自動點完「獎勵 → 下一關」連闖。
                   F8 隨時停止。**預設關閉**——第一次請先不開自動，看預覽圖上程式讀的盤面（每格
                   一個色點）跟建議的這一步（紅圈＝來源、綠圈＝目標）對不對，再開自動。
"""

from __future__ import annotations

import ctypes
import gc
import os
import queue
import sys
import threading
import time
import traceback
from ctypes import wintypes
from typing import List, Optional, Tuple

HEADLESS = bool(os.environ.get("GEMSORT_HEADLESS"))   # 測試用：視窗建立後立刻隱藏，不會出現在桌面上


def enable_dpi_awareness() -> None:
    """必須在建立任何 Tk 視窗之前呼叫。

    Windows 顯示縮放不是 100% 時，tkinter 回報的是邏輯座標、螢幕擷取拿到的是實體像素，
    兩者對不起來會讓框選出來的範圍整個歪掉。宣告 per-monitor DPI aware 之後兩邊就一致了。
    """
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
        return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


enable_dpi_awareness()

import numpy as np  # noqa: E402
from PIL import ImageTk  # noqa: E402

import tkinter as tk  # noqa: E402
from tkinter import messagebox  # noqa: E402

import control as C  # noqa: E402
import engine as E  # noqa: E402
import render as R  # noqa: E402
import vision as V  # noqa: E402

# ---------------------------------------------------------------- 外觀（跟前兩個輔助器同一套）

UI_FONT = "Microsoft JhengHei UI"
BG = "#1c1f24"
BG_PANEL = "#262a31"
FG = "#e8eaed"
FG_DIM = "#9aa0a8"
ACCENT = "#5ac36a"
WARN = "#e0a33e"
ERROR = "#e05c5c"

PREVIEW_W, PREVIEW_H = 372, 224    # 面板裡的即時預覽框；範圍等比例縮進去
LOG_LINES = 6                      # 「最近動作」一次看得到幾行
LOG_KEEP = 300                     # 最多保留幾則（可以往上捲回去看）
GC_EVERY = 3.0                     # 主執行緒多久手動回收一次垃圾（秒），原因見 AssistApp.__init__


def btn_style(bg: str = BG_PANEL, fg: str = FG) -> dict:
    return dict(bg=bg, fg=fg, font=(UI_FONT, 10), relief="flat", bd=0,
                padx=12, pady=6, activebackground="#39404a", activeforeground=FG,
                cursor="hand2", highlightthickness=0)


def work_area() -> Tuple[int, int, int, int]:
    """主螢幕扣掉工作列之後的可用範圍 (left, top, right, bottom)。"""
    rect = wintypes.RECT()
    if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):   # SPI_GETWORKAREA
        return rect.left, rect.top, rect.right, rect.bottom
    return 0, 0, ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1)


class _Tee:
    """輸出同時寫到原本的 stream 跟 log 檔並立刻 flush。

    用 pythonw 啟動時沒有主控台，錯誤訊息會直接消失；出事只能靠這個檔案事後對照。"""

    def __init__(self, *streams) -> None:
        self._streams = [s for s in streams if s is not None]

    def write(self, data: str) -> int:
        for s in self._streams:
            try:
                s.write(data)
                s.flush()
            except Exception:
                pass
        return len(data)

    def flush(self) -> None:
        for s in self._streams:
            try:
                s.flush()
            except Exception:
                pass


def setup_log() -> None:
    path = os.path.join(E.APP_DIR, "app_log.txt")
    try:
        if os.path.exists(path) and os.path.getsize(path) > 300_000:
            os.remove(path)     # 純診斷用，太大就砍掉重來
        f = open(path, "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    f.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 啟動 =====\n")
    sys.stdout = _Tee(sys.stdout, f)
    sys.stderr = _Tee(sys.stderr, f)


# ---------------------------------------------------------------- 框選範圍

class RegionOverlay(tk.Toplevel):
    """蓋滿整個桌面的半透明遮罩，讓使用者拖曳框出「模擬器裡的遊戲畫面」。

    拖出框之後不會馬上結束：框還留著，可以用方向鍵微調（Shift＝改大小、Ctrl＝一次 10px），
    按 Enter 確定，或直接重新拖曳重框。面板（AssistApp）刻意浮在遮罩上面，讓使用者全程看得到它。
    """

    MIN_SIZE = 40

    def __init__(self, master: tk.Misc, screen: V.Region, on_done) -> None:
        super().__init__(master)
        self.screen = screen
        self.on_done = on_done
        self.drag_start: Optional[Tuple[int, int]] = None
        self.sel: Optional[List[int]] = None       # 畫布座標 [x0, y0, x1, y1]

        self.overrideredirect(True)
        self.geometry(f"{screen.width}x{screen.height}+{screen.left}+{screen.top}")
        self.attributes("-topmost", True)
        self.attributes("-alpha", 0.4)
        self.configure(bg="#000000")

        self.canvas = tk.Canvas(self, bg="#000000", highlightthickness=0, cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)
        mid = screen.width // 2
        self.canvas.create_text(mid, 54, fill="#ffffff", font=(UI_FONT, 24, "bold"),
                                text="拖曳框出「模擬器裡的遊戲畫面」")
        self.hint_id = self.canvas.create_text(mid, 96, fill="#c8ccd2", font=(UI_FONT, 14), text="")
        self.error_id = self.canvas.create_text(mid, 132, fill="#ff8a8a", font=(UI_FONT, 14, "bold"), text="")
        self._hint()

        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._drag)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.bind("<Key>", self._key)
        self.bind("<Escape>", lambda _e: self.cancel())
        self.bind("<Return>", lambda _e: self.confirm())
        try:
            self.focus_force()
        except tk.TclError:
            pass

    def _hint(self, error: str = "") -> None:
        if self.sel is None:
            text = "整個寶石盤面（所有管子）要在框裡，多包一點邊沒關係　　Esc 取消"
        else:
            text = "方向鍵微調位置（Shift＝改大小，Ctrl＝一次 10px）　Enter 確定　重新拖曳可重框　Esc 取消"
        self.canvas.itemconfig(self.hint_id, text=text)
        self.canvas.itemconfig(self.error_id, text=error)

    def _redraw(self) -> None:
        self.canvas.delete("sel")
        if self.sel is None:
            return
        x0, y0, x1, y1 = self.sel
        self.canvas.create_rectangle(x0, y0, x1, y1, outline="#5ac36a", width=2, tags="sel")
        label = f"{x1 - x0} × {y1 - y0}"
        ty = y1 + 16 if y1 + 34 < self.screen.height else y0 - 16
        self.canvas.create_text((x0 + x1) // 2, ty, text=label, fill="#5ac36a",
                                font=(UI_FONT, 13, "bold"), tags="sel")

    def _press(self, ev) -> None:
        self.focus_force()
        self.drag_start = (ev.x, ev.y)
        self.sel = None
        self._redraw()
        self._hint()

    def _drag(self, ev) -> None:
        if self.drag_start is None:
            return
        x0, y0 = self.drag_start
        self.sel = [min(x0, ev.x), min(y0, ev.y), max(x0, ev.x), max(y0, ev.y)]
        self._redraw()

    def _release(self, ev) -> None:
        if self.drag_start is None:
            return
        self.drag_start = None
        if self.sel is None or (self.sel[2] - self.sel[0] < self.MIN_SIZE
                                or self.sel[3] - self.sel[1] < self.MIN_SIZE):
            self.sel = None
            self._redraw()
            self._hint("框太小了，請沿著遊戲畫面的邊緣重新拖一次")
            return
        self._hint()

    def _key(self, ev) -> None:
        if self.sel is None:
            return
        step = 10 if ev.state & 0x4 else 1
        dx = {"Left": -step, "Right": step}.get(ev.keysym, 0)
        dy = {"Up": -step, "Down": step}.get(ev.keysym, 0)
        if not (dx or dy):
            return
        x0, y0, x1, y1 = self.sel
        if ev.state & 0x1:      # Shift：動右下角＝改大小，左上角固定
            x1 = max(x0 + self.MIN_SIZE, x1 + dx)
            y1 = max(y0 + self.MIN_SIZE, y1 + dy)
        else:
            x0, x1, y0, y1 = x0 + dx, x1 + dx, y0 + dy, y1 + dy
        self.sel = [x0, y0, x1, y1]
        self._redraw()

    def confirm(self) -> None:
        if self.sel is None:
            self._hint("還沒框出範圍——請先拖曳")
            return
        x0, y0, x1, y1 = self.sel
        region = V.Region(self.screen.left + x0, self.screen.top + y0, x1 - x0, y1 - y0)
        self.destroy()
        self.on_done(region)

    def cancel(self) -> None:
        self.destroy()
        self.on_done(None)


# ---------------------------------------------------------------- 主面板

class AssistApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        if HEADLESS:
            self.withdraw()
        self.cfg = E.Config.load()
        self.engine = E.Engine(self.cfg, guard=self._guard_click_target)
        self.lock = threading.Lock()
        self.queue: "queue.Queue[E.Status]" = queue.Queue()
        self.worker = E.Worker(self.engine, self.lock, self.queue)
        self.overlay: Optional[RegionOverlay] = None
        self.last_status: Optional[E.Status] = None
        self._flash_until = 0.0
        self._photo: Optional[ImageTk.PhotoImage] = None
        self._last_note = ""             # 上一則狀態訊息（同一句連續重複只記一次）

        # 垃圾回收只准在主執行緒做。對話框、遮罩關掉後留下的 Tk 物件（StringVar、PhotoImage）
        # 會互相參照成循環垃圾，等循環 GC 來收；而循環 GC 是「誰剛好配置記憶體就在誰的執行緒
        # 觸發」——背景偵測執行緒每輪都在配置畫面陣列，常常就是它。這樣 Variable.__del__ 會在
        # 背景執行緒裡呼叫 Tcl：輕則卡住等主執行緒回應，重則死結（永夜迷城端到端測試實際抓到）。
        # 所以關掉自動 GC，改由 _pump 每 GC_EVERY 秒在主執行緒手動 gc.collect()。
        gc.disable()
        self._next_gc = time.monotonic() + GC_EVERY

        self.title("寶石排序輔助器")
        self.configure(bg=BG)
        if not HEADLESS:
            self.attributes("-topmost", True)
        self.attributes("-alpha", self.cfg.opacity)
        self.resizable(False, False)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<Escape>", lambda _e: self.overlay.cancel() if self.overlay else None)
        icon = os.path.join(E.APP_DIR, "icon.ico")
        if os.path.exists(icon):
            try:
                self.iconbitmap(icon)
            except tk.TclError:
                pass

        self._build_ui()
        if not HEADLESS:
            self._force_normal_window()
            self.update()      # 先讓視窗真的顯示出來，dock() 才量得到標題列與邊框的寬度
            self.dock()
        else:
            self.update_idletasks()
        self.worker.start()
        self._pump_job = self.after(80, self._pump)

    # -- 視窗 --
    def _force_normal_window(self) -> None:
        """不管是被什麼方式啟動的，都確保視窗是正常大小、看得到。

        桌面捷徑本身是「最小化」啟動（用來壓掉 PowerShell 黑視窗），這個顯示狀態會經由
        STARTUPINFO 一路繼承到這裡；被壓成最小化的話 Tk 不會完成初始版面計算，還原之後會變成
        一個小殘塊。所以這裡明確還原狀態，再把 geometry 清掉讓 Tk 依內容重新量一次尺寸。
        """
        try:
            self.update_idletasks()
            if self.state() != "normal":
                self.state("normal")
            self.deiconify()
            self.geometry("")
            self.update_idletasks()
        except tk.TclError:
            pass

    def _panel_rect(self, x: int, y: int) -> Tuple[int, int, int, int]:
        w, h = self.winfo_reqwidth(), self.winfo_reqheight()
        return x, y, x + w, y + h + 40      # 標題列不算在 reqheight 裡，多算一點

    def dock(self) -> None:
        """停靠在螢幕右邊、貼著工作區頂端。範圍剛好被右邊的面板蓋到才改停左邊。"""
        self.update_idletasks()
        left, top, right, bottom = work_area()
        w = self.winfo_reqwidth()
        border = max(0, self.winfo_rootx() - self.winfo_x())
        x_right = right - w - border
        x_left = left - border
        y = top
        x = x_right
        region, _ = self.engine.tracker.current()
        if region is not None:
            def hits(px: int) -> bool:
                l, t, r, b = self._panel_rect(px, y)
                return not (r <= region.left or l >= region.right or b <= region.top or t >= region.bottom)
            if hits(x_right) and not hits(x_left):
                x = x_left
        self.geometry(f"+{x}+{y}")

    def _overlaps_region(self) -> bool:
        """面板（含標題列）有沒有蓋在遊戲畫面範圍上。蓋住的話不只點擊會點到自己，
        擷取到的畫面也會被面板本身汙染，辨識就全歪了。"""
        region, _ = self.engine.tracker.current()
        if region is None:
            return False
        self.update_idletasks()
        l, r = self.winfo_rootx(), self.winfo_rootx() + self.winfo_width()
        t, b = self.winfo_rooty() - 40, self.winfo_rooty() + self.winfo_height()
        return not (r <= region.left or l >= region.right or b <= region.top or t >= region.bottom)

    def _guard_click_target(self, x: int, y: int) -> Optional[str]:
        """點擊前最後一道檢查（在背景執行緒跑，只用 ctypes，不碰 Tk）：目標點最上層必須是
        遊戲，不能是自己的視窗，也不能是別的程式壓在模擬器上面的視窗。"""
        who = self.engine.tracker.blocker(x, y)
        if who is None:
            return None
        return f"{who}蓋在遊戲畫面上，自動操控已停止。請把它移開（或把模擬器拉到最上層）再開始。"

    # -- 版面 --
    def _build_ui(self) -> None:
        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=16, pady=(14, 0))
        self.dot = tk.Label(head, text="●", bg=BG, fg=FG_DIM, font=(UI_FONT, 14))
        self.dot.pack(side="left")
        self.state_name = tk.Label(head, text="尚未框選範圍", bg=BG, fg=FG_DIM,
                                   font=(UI_FONT, 20, "bold"), anchor="w")
        self.state_name.pack(side="left", padx=(8, 0))
        self.state_hint = tk.Label(self, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 10), anchor="w",
                                   wraplength=PREVIEW_W, justify="left")
        self.state_hint.pack(fill="x", padx=16, pady=(0, 6))

        self.preview = tk.Canvas(self, width=PREVIEW_W, height=PREVIEW_H, bg="#12141a",
                                 highlightthickness=0)
        self.preview.pack(padx=14)
        self.region_info = tk.Label(self, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 9), anchor="w",
                                    wraplength=PREVIEW_W, justify="left")
        self.region_info.pack(fill="x", padx=16, pady=(4, 0))

        self.status = tk.Label(self, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 9),
                               wraplength=PREVIEW_W, justify="left", anchor="w")
        self.status.pack(fill="x", padx=16, pady=(6, 0))

        auto = tk.Frame(self, bg=BG)
        auto.pack(fill="x", padx=16, pady=(10, 0))
        self.auto_btn = tk.Button(auto, text="▶ 開始自動", command=self.toggle_autoplay,
                                  **btn_style(bg="#2f6b38", fg="#dff5e2"))
        self.auto_btn.pack(side="left")
        self.auto_note = tk.Label(auto, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 9))
        self.auto_note.pack(side="left", padx=(10, 0))

        lim = tk.Frame(self, bg=BG)
        lim.pack(fill="x", padx=16, pady=(6, 0))
        tk.Label(lim, text="連闖上限", bg=BG, fg=FG_DIM, font=(UI_FONT, 9)).pack(side="left")
        self.max_var = tk.StringVar(value=str(self.cfg.max_levels))
        self.max_spin = tk.Spinbox(lim, from_=0, to=999, width=4, textvariable=self.max_var,
                                   command=self._on_max_levels, bg=BG_PANEL, fg=FG,
                                   buttonbackground=BG_PANEL, relief="flat", font=(UI_FONT, 9),
                                   insertbackground=FG, highlightthickness=0)
        self.max_spin.pack(side="left", padx=(6, 0))
        self.max_spin.bind("<Return>", lambda _e: self._on_max_levels())
        self.max_spin.bind("<FocusOut>", lambda _e: self._on_max_levels())
        tk.Label(lim, text="關（0＝不限；「下一關」每關花 1 顆鑽石）", bg=BG, fg=FG_DIM,
                 font=(UI_FONT, 9)).pack(side="left", padx=(6, 0))

        tk.Label(self, text="最近動作", bg=BG, fg=FG_DIM, font=(UI_FONT, 9), anchor="w").pack(
            fill="x", padx=16, pady=(10, 0))
        # 可捲動的 Text（滑鼠滾輪／右邊捲軸），新訊息進來若本來就停在最底下就自動捲到最新。
        # 舊版是固定高度的 Label：長訊息一折行就把最新的擠出畫面、又沒辦法捲。
        log_wrap = tk.Frame(self, bg="#15181d")
        log_wrap.pack(fill="x", padx=16, pady=(2, 0))
        self.log_text = tk.Text(log_wrap, height=LOG_LINES, bg="#15181d", fg=FG_DIM, font=("Consolas", 9),
                                wrap="char", relief="flat", bd=0, padx=8, pady=4, highlightthickness=0,
                                state="disabled", cursor="arrow", takefocus=0)
        log_bar = tk.Scrollbar(log_wrap, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_bar.set)
        log_bar.pack(side="right", fill="y")
        self.log_text.pack(side="left", fill="x", expand=True)

        bar = tk.Frame(self, bg=BG)
        bar.pack(fill="x", padx=12, pady=12)
        tk.Button(bar, text="① 框選畫面範圍", command=self.start_select, **btn_style()).pack(side="left", padx=2)
        self.pause_btn = tk.Button(bar, text="暫停", command=self.toggle_pause, **btn_style())
        self.pause_btn.pack(side="left", padx=2)

        self.footer = tk.Label(self, text="", bg=BG, fg="#5c626b", font=("Consolas", 8))
        self.footer.pack(fill="x", padx=16, pady=(0, 8))

        self._draw_preview(None, None, None)
        self._sync_region_info()
        self._sync_auto_note()

    # -- 事件迴圈 --
    def _pump(self) -> None:
        # 緊急停止在 UI 執行緒也檢查一次：背景執行緒點擊的那一瞬間不會回頭看，
        # 這裡每 60ms 檢查一次，按下去的反應快得多。
        if C.panic_pressed(self.cfg.panic_key) and self.engine.autoplay:
            self.engine.stop_autoplay()
            self._sync_auto_note()
            self.flash(f"已按下 {self.cfg.panic_key}，自動操控已停止")

        self._sync_pause_btn()
        if time.monotonic() >= self._next_gc:
            gc.collect()
            self._next_gc = time.monotonic() + GC_EVERY

        latest: Optional[E.Status] = None
        try:
            while True:
                latest = self.queue.get_nowait()
        except queue.Empty:
            pass
        if latest is not None:
            self._render(latest)
        self._pump_job = self.after(60, self._pump)

    def _sync_pause_btn(self) -> None:
        want = "繼續" if self.worker.paused else "暫停"
        if self.pause_btn.cget("text") != want:
            self.pause_btn.config(text=want)

    def _sync_auto_note(self) -> None:
        on = self.engine.autoplay
        self.auto_btn.config(text="■ 停止自動" if on else "▶ 開始自動",
                             bg="#7a3030" if on else "#2f6b38",
                             fg="#f7dede" if on else "#dff5e2")
        moves, levels = self.engine.moves_done, self.engine.levels_done
        if on:
            self.auto_note.config(text=f"執行中 · 已走 {moves} 步 · 連闖 {levels} 關 · 按 {self.cfg.panic_key} 停止",
                                  fg=ACCENT)
        else:
            self.auto_note.config(
                text=f"開啟後程式會自己點滑鼠（已走 {moves} 步 · 連闖 {levels} 關）" if moves or levels
                else "開啟後程式會自己點滑鼠", fg=FG_DIM)

    def _on_max_levels(self) -> None:
        try:
            n = max(0, min(999, int(self.max_var.get())))
        except ValueError:
            n = self.cfg.max_levels
        self.max_var.set(str(n))
        if n != self.cfg.max_levels:
            with self.lock:
                self.cfg.max_levels = n
                self.cfg.save()
            self.flash("連闖不設上限" if n == 0 else f"連闖上限 {n} 關（到了會停手等你）", 5)

    def _sync_region_info(self) -> None:
        region = self.engine.region
        if region is None and self.cfg.region:
            region = V.Region.from_dict(self.cfg.region)
        if region is None:
            self.region_info.config(text="範圍：尚未框選")
            return
        lock = ""
        if self.cfg.window_anchor:
            lock = f" · 已鎖定視窗「{self.cfg.window_anchor['title']}」"
        self.region_info.config(
            text=f"範圍 {region.width}×{region.height}　左上 ({region.left}, {region.top}){lock}")

    def _draw_preview(self, image: Optional[np.ndarray], board: Optional[V.Board],
                      move: Optional[Tuple[int, int]]) -> None:
        c = self.preview
        c.delete("all")
        if image is None:
            self._photo = None
            c.create_text(PREVIEW_W // 2, PREVIEW_H // 2, fill=FG_DIM, font=(UI_FONT, 11), justify="center",
                          text="程式看到的畫面會顯示在這裡\n（只有你框選的範圍）\n\n"
                               "色點＝程式讀到的每顆寶石\n紅圈＝要點的來源管、綠圈＝目標管")
            return
        pil = R.draw_preview(image, board, move, self.engine.palette, PREVIEW_W, PREVIEW_H)
        self._photo = ImageTk.PhotoImage(pil)
        c.create_image(PREVIEW_W // 2, PREVIEW_H // 2, image=self._photo)

    def _push_log(self, text: str, dedupe: bool = False) -> None:
        """加一則到「最近動作」。dedupe＝跟上一則狀態訊息一模一樣就不重複記
        （停手後引擎每輪都會回報同一句，會把真正的動作洗掉）。"""
        if dedupe:
            if text == self._last_note:
                return
            self._last_note = text
        t = self.log_text
        t.update_idletasks()                        # 上一則的行高要先算完，yview 才準（連續幾則進來時會讀到舊值）
        at_bottom = t.yview()[1] >= 0.999          # 使用者正往上翻舊訊息時，不要硬把畫面拉走
        first = t.index("end-1c") == "1.0"
        t.config(state="normal")
        t.insert("end", ("" if first else "\n") + f"{time.strftime('%H:%M:%S')} {text}")
        lines = int(t.index("end-1c").split(".")[0])
        if lines > LOG_KEEP:
            t.delete("1.0", f"{lines - LOG_KEEP + 1}.0")
        t.config(state="disabled")
        if at_bottom:
            t.yview_moveto(1.0)                     # 比 see("end") 可靠（行高還沒算完時 see 會偏）

    def log_contents(self) -> str:
        return self.log_text.get("1.0", "end-1c")

    def _render(self, st: E.Status) -> None:
        self.last_status = st
        self._sync_auto_note()
        self._sync_region_info()
        if st.image is not None:
            self._draw_preview(st.image, st.board, st.move)
        elif st.kind == "waiting":
            self._draw_preview(None, None, None)
        if st.acted:
            self._push_log(st.acted)

        if st.screen == "level" and st.kind in ("ok", "settling"):
            self.dot.config(fg=ACCENT if st.kind == "ok" else FG_DIM)
            self.state_name.config(text=("關卡中" if st.kind == "ok" else "畫面變動中…"),
                                   fg=FG if st.kind == "ok" else FG_DIM)
            self.state_hint.config(text=st.message, fg=ACCENT if st.kind == "ok" and st.move else FG_DIM)
        else:
            text, color = {
                "solved": ("這關完成了", ACCENT),
                "overlay": ("獎勵畫面" if st.screen == "reward" else "結算畫面", ACCENT),
                "settling": ("畫面變動中…", FG_DIM),
                "stuck": ("找不到解", WARN),
                "unknown": ("認不得這個畫面", WARN),
                "waiting": ("等待中" if self.cfg.region else "尚未框選範圍", FG_DIM),
                "stopped": ("已停止", WARN),
                "error": ("出錯了", ERROR),
            }.get(st.kind, ("等待中", FG_DIM))
            self.dot.config(fg=color)
            self.state_name.config(text=text, fg=color if st.kind != "waiting" else FG_DIM)
            self.state_hint.config(text=st.message if st.kind in ("solved", "overlay", "settling") else "",
                                   fg=FG_DIM)

        if st.kind in ("stopped", "error", "stuck"):
            self._push_log(st.message, dedupe=True)
        else:
            self._last_note = ""                # 狀態恢復了，下次再出現同一句就是新事件
        if time.time() >= self._flash_until:
            color = {"error": ERROR, "stopped": WARN, "unknown": WARN, "stuck": WARN}.get(st.kind, FG_DIM)
            self.status.config(text=st.message if st.kind not in ("ok",) else "", fg=color)
        pal = self.engine.palette
        self.footer.config(text=f"顏色 {len(pal.hues)} 種　擷取 {self.engine.grabber.backend}"
                                f"　本關已走 {st.level_moves} 步")

    def flash(self, text: str, seconds: float = 4.0, color: str = ACCENT) -> None:
        self.status.config(text=text, fg=color)
        self._flash_until = time.time() + seconds

    def report_callback_exception(self, exc, val, tb) -> None:
        traceback.print_exception(exc, val, tb)     # 有 tee，會進 app_log.txt
        try:
            self.flash(f"內部錯誤：{exc.__name__}: {val}", 20, ERROR)
        except Exception:
            pass

    # -- ① 框選 --
    def start_select(self) -> None:
        if self.overlay is not None:
            return
        self.engine.stop_autoplay()
        self._sync_auto_note()
        self.worker.pause()
        screen = V.Region(*C.virtual_screen())
        self.flash("在桌面上拖曳，框出模擬器裡的遊戲畫面（Esc 取消）", 999)

        def done(region: Optional[V.Region]) -> None:
            self.overlay = None
            if region is None:
                self.worker.resume()
                self.flash("已取消框選")
                return
            self.apply_region(region)

        self.overlay = RegionOverlay(self, screen, done)
        self.after(60, self.lift)      # 面板浮在遮罩上面，全程看得到

    def apply_region(self, region: V.Region) -> None:
        anchor = E.RegionTracker.make_anchor(region)
        with self.lock:
            self.cfg.region = region.to_dict()
            self.cfg.window_anchor = anchor
            self.cfg.save()
            self.engine.rebuild()
        self.dock()      # 範圍剛好落在面板底下的話，面板會自己讓開
        self.worker.resume()
        self._sync_region_info()

        note = (f" 順便鎖定了視窗「{anchor['title']}」，搬動它不用重框（改變視窗大小要重框）。"
                if anchor else "")
        head = f"範圍存好了（{region.width}×{region.height}）。"
        if self._overlaps_region():
            self.flash(head + f"但右邊的面板蓋到這個範圍了。請把模擬器視窗縮小、擺到螢幕左邊"
                              f"（右邊留約 {self.winfo_width()}px 給面板），再按一次「① 框選畫面範圍」重框。", 20, WARN)
        else:
            self.flash(head + "先別開自動，看預覽圖上的色點跟建議的這一步對不對。" + note, 12)

    # -- 自動操控 --
    def toggle_autoplay(self) -> None:
        if self.engine.autoplay:
            self.engine.stop_autoplay()
            self._sync_auto_note()
            self.flash("自動操控已停止")
            return
        region, err = self.engine.tracker.current()
        if region is None:
            self.flash(err or "請先框選畫面範圍", 8, WARN)
            return
        if self._overlaps_region():
            messagebox.showwarning(
                "面板擋住畫面了",
                "這個面板正蓋在遊戲畫面範圍上。\n\n點擊會點到面板自己，而且擷取到的畫面也會被面板汙染。\n\n"
                "請把模擬器視窗縮小、擺到螢幕左邊（右邊留給面板），再重新框選範圍。", parent=self)
            return
        lim = self.cfg.max_levels
        cost = ("過關後會自動連闖，「下一關」每關花 1 顆鑽石"
                + (f"（這次最多連闖 {lim} 關）" if lim else "（目前不設上限，直到鑽石用完或遇到認不得的畫面）") + "。")
        if not messagebox.askyesno(
                "開始自動操控",
                f"接下來程式會自己在框選的範圍內點擊滑鼠。\n\n{cost}\n\n"
                f"隨時要停止：\n　• 按 {self.cfg.panic_key}（不用切回面板也有效）\n　• 或再按一次「■ 停止自動」\n\n"
                f"開始前請確認模擬器視窗在最上層、沒有被其他視窗擋住。\n\n要開始嗎？", parent=self):
            return
        self.engine.start_autoplay()
        self.worker.resume()
        self.pause_btn.config(text="暫停")
        self._sync_auto_note()
        self.flash(f"自動操控開始 —— 按 {self.cfg.panic_key} 可隨時停止", 6)

    # -- 暫停／關閉 --
    def toggle_pause(self) -> None:
        if self.worker.paused:
            self.worker.resume()
            self.pause_btn.config(text="暫停")
            self.flash("繼續偵測")
        else:
            # 暫停時一併關掉自動操控，不然按「繼續」會冷不防又開始搶滑鼠
            self.engine.stop_autoplay()
            self._sync_auto_note()
            self.worker.pause()
            self.pause_btn.config(text="繼續")
            self.flash("已暫停（畫面不會再更新）", 999)

    def _on_close(self) -> None:
        self.engine.stop_autoplay()
        self.worker.stop()
        self.worker.join(timeout=1.5)     # 等背景執行緒收工，之後 Tk 物件才會全在主執行緒清掉
        try:
            self.after_cancel(self._pump_job)
        except (tk.TclError, AttributeError):
            pass
        self.destroy()
        gc.collect()
        gc.enable()


def main() -> int:
    setup_log()
    app = AssistApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
