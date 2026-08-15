"""水果 2048 即時輔助器 —— 主程式。

盯著模擬器畫面上的 4x4 盤面，自動辨識後用 expectimax 算出最佳方向，
顯示在一個永遠置頂的小視窗上。

    python app.py

第一次執行要做兩件事：
  1. 按「校準盤面」框出遊戲的 4x4 區域（大概框就好，程式會自己吸附格線）
  2. 按「標記水果」把每一格是幾號告訴它（只要做這一次，之後永久記住）
"""

from __future__ import annotations

import ctypes
import json
import os
import queue
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ImageTk

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
TEMPLATES_PATH = os.path.join(APP_DIR, "templates.json")


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

import tkinter as tk  # noqa: E402
from tkinter import messagebox, ttk  # noqa: E402

import adb as ADB  # noqa: E402
import control as C  # noqa: E402
import solver as S  # noqa: E402
import vision as V  # noqa: E402


# ---------------------------------------------------------------- 外觀

UI_FONT = "Microsoft JhengHei UI"
BG = "#1c1f24"
BG_PANEL = "#262a31"
FG = "#e8eaed"
FG_DIM = "#9aa0a8"
ACCENT = "#5ac36a"
WARN = "#e0a33e"
ERROR = "#e05c5c"

FRUIT_COLORS = {
    0: "#333840",
    1: "#e0524a", 2: "#e8912f", 3: "#e6c93c", 4: "#a3cd45",
    5: "#8a5bb5", 6: "#d9d94a", 7: "#e8a08f", 8: "#4a9fd4",
    9: "#43bf9e", 10: "#d1568f", 11: "#7a6de8", 12: "#c07038",
    13: "#4fb8b8", 14: "#9aa0a8", 15: "#f0c419",
}


def fruit_color(v: int) -> str:
    return FRUIT_COLORS.get(v, "#f0c419")


# ---------------------------------------------------------------- 設定檔

@dataclass
class Config:
    region: Optional[dict] = None
    rows: int = 4
    cols: int = 4
    inset: float = 0.10
    tolerance: float = V.DEFAULT_TOLERANCE
    min_margin: float = V.DEFAULT_MIN_MARGIN
    time_budget: float = 0.30
    poll_ms: int = 50
    opacity: float = 0.95
    spawn: List[List[float]] = field(default_factory=lambda: [[1, 1.0]])

    # -- 自動操控 --
    # 注意：「現在是不是自動玩」刻意不存檔。每次啟動都要人工按一次才會動，
    # 免得程式一開就突然開始搶滑鼠。
    autoplay_method: str = "swipe"      # swipe / arrows / wasd
    swipe_fraction: float = 0.35        # 滑動距離佔盤面短邊的比例
    swipe_ms: int = 140                 # 一次滑動花多久
    swipe_steps: int = 14               # 拆成幾個中間點（太少會被當成瞬移）
    move_interval: float = 0.20         # 兩步之間至少隔多久
    retry_after: float = 1.6            # 盤面沒變的話，隔多久重滑一次
    max_retries: int = 3                # 連續重試幾次仍沒反應就停下來
    animation_grace: float = 1.2        # 剛滑完這段時間內認不得都算動畫，不當成錯誤
    panic_key: str = C.DEFAULT_PANIC_KEY

    # 校準時如果偵測得到模擬器視窗，記住「框選範圍相對那個視窗左上角差多少」
    # （title / dx / dy）。之後每次擷取前用標題重新找一次視窗現在的位置，
    # 把位移套回去 —— 這樣挪動或換螢幕擺放視窗都不用重新校準。
    # 偵測不到（例如模擬器不是一般視窗）就是 None，退回原本寫死畫面座標的行為。
    window_anchor: Optional[dict] = None

    # -- 畫面來源：screen＝PC 模擬器截圖（原本的路），adb＝USB 接實體手機 --
    capture_source: str = "screen"
    adb_serial: Optional[str] = None    # 多台裝置時指定序號；留白就自動挑「唯一一台已授權」的

    @classmethod
    def load(cls) -> "Config":
        if not os.path.exists(CONFIG_PATH):
            return cls()
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return cls()
        cfg = cls()
        for k, v in data.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg

    def save(self) -> None:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)


# ---------------------------------------------------------------- 引擎

@dataclass
class Status:
    kind: str                      # ok / settling / unknown / misaligned / nomove / waiting / error / stopped
    message: str = ""
    cells: Optional[List[int]] = None
    result: Optional[S.Result] = None
    reading: Optional[V.Reading] = None
    autoplay: bool = False
    moves_played: int = 0


class Engine:
    """擷取 → 辨識 → 求解。所有狀態都在這裡，UI 只負責顯示。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.db = V.TemplateDB.load(TEMPLATES_PATH, cfg.tolerance, cfg.min_margin)
        self.grabber = self._build_grabber()
        self.last_image: Optional[np.ndarray] = None
        self.autoplay = False          # 每次啟動都從關閉開始，見 Config 的註解
        # 「本來在自動玩，只是被沒見過的水果／格線跑掉擋下來」的記號。
        # 使用者把問題處理掉之後就自己接回去，不用再按一次開始（見 stop_autoplay）。
        self.autoplay_resumable = False
        self.moves_played = 0
        self.rebuild()

    def _build_grabber(self):
        if self.cfg.capture_source == "adb":
            return ADB.AdbGrabber(serial=self.cfg.adb_serial)
        return V.ScreenGrabber()

    def refresh_capture_backend(self) -> None:
        """capture_source／adb_serial 換了才需要呼叫，重建擷取來源。

        故意不放進 rebuild()：標記、校準、重新吸附這些小動作都會觸發
        rebuild()，如果 grabber 也跟著每次重建，測試裡蓋掉的假擷取來源
        會被無聲換回真的螢幕擷取，而且只有在剛好某個測試序列踩到才會
        看出來——2026-08-15 加手機支援時就是這樣，隔了好幾個 rebuild()
        呼叫點才炸出一個看起來毫不相干的失敗。
        """
        self.grabber = self._build_grabber()

    def rebuild(self) -> None:
        """設定改過之後重建衍生物件，並清掉快取的判斷。"""
        cfg = self.cfg
        self.db.tolerance = cfg.tolerance
        self.db.min_margin = cfg.min_margin
        self.grid = V.Grid(cfg.rows, cfg.cols, cfg.inset)
        self.rec = V.Recognizer(self.grid, self.db)
        self.solver = S.Solver(spawn=[tuple(x) for x in cfg.spawn])
        self.region = V.Region.from_dict(cfg.region) if cfg.region else None
        if cfg.capture_source == "adb":
            self.controller = ADB.AdbController(
                serial=cfg.adb_serial,
                duration=cfg.swipe_ms / 1000.0,
                fraction=cfg.swipe_fraction,
            )
        else:
            self.controller = C.Controller(
                method=cfg.autoplay_method,
                fraction=cfg.swipe_fraction,
                duration=cfg.swipe_ms / 1000.0,
                steps=cfg.swipe_steps,
            )
        self._confirming: Optional[List[int]] = None
        self._solved_board: Optional[int] = None
        self._result: Optional[S.Result] = None
        self._played_board: Optional[int] = None
        self._played_at = 0.0
        self._retry = 0

    def _status(self, kind: str, message: str = "", **kw) -> Status:
        return Status(kind, message, autoplay=self.autoplay,
                      moves_played=self.moves_played, **kw)

    def start_autoplay(self) -> None:
        self.autoplay = True
        self.autoplay_resumable = False
        self._played_board = None
        self._retry = 0

    def stop_autoplay(self, resumable: bool = False) -> None:
        """停下自動操控。

        `resumable=True` 代表「只是被辨識問題擋下來」——使用者標記完新水果、
        或重新吸附好格線之後，程式就自己接回去繼續玩。其他理由停下來的
        （按了暫停、按了緊急停止鍵、送不出操作、遊戲結束）一律不接回去，
        因為那些都是「使用者要它停」或「環境壞掉了」，自己重開會很嚇人。
        """
        if not resumable:
            self.autoplay_resumable = False
        elif self.autoplay:
            # 認不得的那幾秒 step() 每一輪都會叫一次，只在真的從「開著」變「關掉」
            # 的那一次記錄下來，後面幾輪不要把記號洗掉。
            self.autoplay_resumable = True
        self.autoplay = False
        self._played_board = None
        self._retry = 0

    # -- 給 UI 用的即時擷取 --
    def snapshot(self) -> Optional[np.ndarray]:
        if self.region is None:
            return None
        return self.grabber.grab(self.region)

    def refit_region(self) -> bool:
        """重新吸附格線。成功就寫回設定並回 True。"""
        if self.region is None:
            return False
        fitted = V.autofit_screen(
            self.grabber, self.region, self.cfg.rows, self.cfg.cols,
            screen=self.grabber.virtual_screen(),
        )
        if fitted is None:
            return False
        self.cfg.region = fitted.to_dict()
        if self.cfg.window_anchor:
            # 微調過的位置也要記得跟視窗的相對關係，不然視窗一移動又會退回
            # 校準當下那個沒吸附過的位置。
            hwnd = C.find_window(self.cfg.window_anchor["title"])
            rect = C.window_rect(hwnd) if hwnd else None
            if rect is not None:
                self.cfg.window_anchor = {
                    "title": self.cfg.window_anchor["title"],
                    "dx": fitted.left - rect[0],
                    "dy": fitted.top - rect[1],
                }
        self.cfg.save()
        self.rebuild()
        return True

    def _track_region(self) -> Tuple[Optional[V.Region], Optional[str]]:
        """視窗有被鎖定的話，把 self.region 校正到那個視窗現在的位置。

        沒鎖定（window_anchor 是 None）就原封不動回傳 self.region ——
        這是舊行為，畫面座標校準完就固定死。
        """
        anchor = self.cfg.window_anchor
        if not anchor:
            return self.region, None
        hwnd = C.find_window(anchor["title"])
        rect = C.window_rect(hwnd) if hwnd else None
        if rect is None or C.window_is_minimized(hwnd):
            return None, (f"找不到視窗「{anchor['title']}」——可能被關掉或縮到最小了。"
                          f"還原視窗就會自動接回去繼續玩。")
        base = self.region or V.Region.from_dict(self.cfg.region)
        left, top, _, _ = rect
        return V.Region(left + anchor["dx"], top + anchor["dy"], base.width, base.height), None

    def step(self) -> Status:
        if self.autoplay and C.panic_pressed(self.cfg.panic_key):
            self.stop_autoplay()
            return self._status("stopped", f"偵測到 {self.cfg.panic_key}，自動操控已停止。")

        if self.region is None:
            return self._status("waiting", "還沒校準。按下方的「① 校準盤面」框出遊戲的 4x4 區域。")

        live_region, track_err = self._track_region()
        if track_err:
            return self._status("waiting", track_err)
        self.region = live_region

        try:
            img = self.grabber.grab(self.region)
        except (ValueError, OSError) as e:
            self.stop_autoplay()
            return self._status("error", f"抓不到畫面：{e}")
        self.last_image = img

        reading = self.rec.read(img)

        if not reading.ok:
            self._confirming = None
            # 剛滑完的那一小段時間本來就讀不到完整盤面（水果正在飛），
            # 這時候跳「有 N 格沒見過」只會嚇到人，等動畫過了再判斷。
            if time.monotonic() - self._played_at < self.cfg.animation_grace:
                return self._status("settling", "動畫播放中…", reading=reading)

            if len(self.db) == 0:
                return self._status("unknown", "樣板庫是空的。按「② 標記水果」教它每一格是幾號。",
                                    reading=reading)
            stopped = " 自動操控先停著，處理好會自己接回去。" if self.autoplay else ""
            self.stop_autoplay(resumable=True)
            if reading.looks_misaligned:
                return self._status("misaligned",
                                    f"{len(reading.unknown_indices)} 格認不得 —— 多半是模擬器視窗移動過。"
                                    f"按「重新吸附」試著自動修正。{stopped}",
                                    cells=reading.board_cells, reading=reading)
            return self._status("unknown",
                                f"有 {len(reading.unknown_indices)} 格沒見過（大概是升級出新水果了）。"
                                f"按「② 標記水果」教它。{stopped}",
                                cells=reading.board_cells, reading=reading)

        cells = reading.board_cells

        # 連續兩次讀到同一個盤面才採信。合成動畫播到一半時每一幀都不一樣，
        # 這個條件比用像素差異設門檻可靠得多，也不怕遊戲背景一直有微動畫。
        if cells != self._confirming:
            self._confirming = cells
            return self._status("settling", "畫面變動中…", cells=cells, reading=reading)

        learned = self._learn_from_badges(reading)

        board = S.from_list(cells)
        if board != self._solved_board or self._result is None:
            self._solved_board = board
            self._result = self.solver.solve(board, self.cfg.time_budget)

        if self._result.best is None:
            self.stop_autoplay()
            return self._status("nomove", "四個方向都動不了 —— 這局結束了。",
                                cells=cells, result=self._result, reading=reading)

        if self.autoplay:
            failure = self._play(board, self._result.best)
            if failure is not None:
                return failure

        return self._status("ok", learned, cells=cells, result=self._result, reading=reading)

    def _learn_from_badges(self, reading: V.Reading) -> str:
        """把「靠格子上的號碼認出來」的新水果收進樣板庫，回傳要顯示的訊息。

        等盤面連續兩次讀到一樣才做，借用上面那個穩定判斷 —— 動畫播到一半的格子
        本來就不該被學進去。學起來之後這顆水果就走第一層樣板比對，不必每一幀
        都重讀一次數字。
        """
        if not reading.badge_indices:
            return ""
        crops = [reading.crops[i] for i in reading.badge_indices]
        labels = [reading.cells[i] for i in reading.badge_indices]
        added = self.rec.learn(crops, labels)
        if not added:
            return ""
        self.db.save(TEMPLATES_PATH)
        # 這裡不呼叫 rebuild()：db.add() 自己會把比對矩陣設成 None，而 rebuild()
        # 會順手把 _played_at 歸零 —— 那正好會在新水果冒出來的那一刻打亂自動
        # 操控的節奏（下一步立刻滑出去，不等 move_interval）。
        names = "、".join(str(n) for n in sorted({int(l) for l in labels if l}))
        return f"看格子上的數字認出 {names} 號水果，已經記起來了"

    def _play(self, board: int, move: int) -> Optional[Status]:
        """自動操控：真的把這一步滑出去。回傳非 None 代表出事了、要顯示給使用者。"""
        now = time.monotonic()
        if now - self._played_at < self.cfg.move_interval:
            return None  # 節奏控制，不要滑太快

        if board == self._played_board:
            # 盤面跟我們上次動手時一模一樣 → 那一下沒生效。等一下再試，
            # 連續幾次都沒反應就停手，免得對著沒反應的視窗一直空滑。
            if now - self._played_at < self.cfg.retry_after:
                return None
            self._retry += 1
            if self._retry > self.cfg.max_retries:
                self.stop_autoplay()
                return self._status(
                    "stopped",
                    f"連續滑了 {self.cfg.max_retries + 1} 次盤面都沒變化，已自動停止。"
                    f"請確認模擬器視窗在最上層、而且沒有被這個輔助器的視窗蓋住。",
                )
        else:
            self._retry = 0

        try:
            self.controller.play(self.region, move)
        except C.InputError as e:
            self.stop_autoplay()
            return self._status("error", str(e))
        except OSError as e:
            self.stop_autoplay()
            return self._status("error", f"送出操作失敗：{e}")

        self._played_board = board
        self._played_at = time.monotonic()
        self.moves_played += 1
        self._confirming = None  # 盤面即將改變，重新確認
        return None


class Worker(threading.Thread):
    """在背景跑 Engine.step()，把結果丟進 queue。

    求解一次要花幾百毫秒，放在 UI 執行緒會讓整個視窗卡住、按鈕按不動。
    """

    def __init__(self, engine: Engine, lock: threading.Lock, out: "queue.Queue[Status]") -> None:
        super().__init__(daemon=True)
        self.engine = engine
        self.lock = lock
        self.out = out
        self._stop = threading.Event()
        self._resume = threading.Event()
        self._resume.set()

    def pause(self) -> None:
        self._resume.clear()

    def resume(self) -> None:
        self._resume.set()

    @property
    def paused(self) -> bool:
        return not self._resume.is_set()

    def stop(self) -> None:
        self._stop.set()
        self._resume.set()  # 免得停在 wait() 裡出不來

    def run(self) -> None:
        while not self._stop.is_set():
            self._resume.wait()
            if self._stop.is_set():
                break
            with self.lock:
                try:
                    status = self.engine.step()
                except Exception as e:  # 背景執行緒炸掉就整個沒反應，一律轉成畫面上的訊息
                    status = Status("error", f"內部錯誤：{type(e).__name__}: {e}")
                poll = self.engine.cfg.poll_ms
            self.out.put(status)
            time.sleep(max(0.05, poll / 1000.0))


# ---------------------------------------------------------------- 框選範圍

class CalibrationOverlay(tk.Toplevel):
    """蓋滿整個桌面的半透明遮罩，分兩步問出盤面的位置。

    第 1 步：框出「左上角那一格」 —— 定出一格有多大、以及左上格的中心。
    第 2 步：依序點「右上、右下、左下」三格的中心 —— 定出整個盤面。

    比「一次框住整個盤面」好對很多：盤面外緣是裝飾外框，邊界本來就模糊，
    框到哪裡算對全靠猜；但每一格的中心點眼睛一看就知道，而且四個角落
    互相校正還能吸收點歪的誤差（實測抖動 ±6px 仍能還原到 8px 內）。
    """

    CORNER_NAMES = ("右上", "右下", "左下")
    MIN_CELL = 12

    def __init__(self, master: tk.Misc, screen: V.Region, rows: int, cols: int, on_done) -> None:
        super().__init__(master)
        self.screen = screen
        self.rows = rows
        self.cols = cols
        self.on_done = on_done

        self.phase = 1
        self.drag_start: Optional[tuple] = None
        self.cell_box: Optional[V.Region] = None      # 螢幕座標
        self.points: List[tuple] = []                 # 螢幕座標

        self.overrideredirect(True)
        self.geometry(f"{screen.width}x{screen.height}+{screen.left}+{screen.top}")
        self.attributes("-topmost", True)
        self.attributes("-alpha", 0.4)
        self.configure(bg="#000000")

        self.canvas = tk.Canvas(self, bg="#000000", highlightthickness=0, cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)

        mid = screen.width // 2
        self.title_id = self.canvas.create_text(mid, 54, fill="#ffffff",
                                                font=(UI_FONT, 24, "bold"), text="")
        self.hint_id = self.canvas.create_text(mid, 96, fill="#c8ccd2",
                                               font=(UI_FONT, 14), text="")
        self.error_id = self.canvas.create_text(mid, 132, fill="#ff8a8a",
                                                font=(UI_FONT, 14, "bold"), text="")

        self.band_id: Optional[int] = None
        self.tl_label_id: Optional[int] = None
        self.ghost_ids: List[int] = []
        self.mark_ids: List[int] = []

        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._drag)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.canvas.bind("<Motion>", self._motion)
        self.bind("<Escape>", lambda _e: self._cancel())
        self.bind("<BackSpace>", lambda _e: self._undo())
        try:
            self.grab_set()
            self.focus_force()
        except tk.TclError:
            pass  # 別的視窗抓著輸入時搶不到，不影響滑鼠操作
        self._refresh_text()

    # -- 座標換算：畫布是貼齊虛擬桌面的，所以只差一個平移 --
    def _to_screen(self, x: int, y: int) -> tuple:
        return self.screen.left + x, self.screen.top + y

    def _to_canvas(self, x: int, y: int) -> tuple:
        return x - self.screen.left, y - self.screen.top

    def _refresh_text(self, error: str = "") -> None:
        if self.phase == 1:
            self.canvas.itemconfig(self.title_id, text="第 1 步 / 共 2 步　框出「左上角那一格」")
            self.canvas.itemconfig(
                self.hint_id,
                text="沿著左上角那一顆水果的格子邊框拖曳。這一步是用來量出一格有多大。"
                     "　　Esc 取消")
        else:
            done = len(self.points)
            nxt = self.CORNER_NAMES[done] if done < len(self.CORNER_NAMES) else ""
            self.canvas.itemconfig(
                self.title_id,
                text=f"第 2 步 / 共 2 步　點選「{nxt}」那一格的中心（{done + 1}/3）")
            self.canvas.itemconfig(
                self.hint_id,
                text="跟著游標的白框就是一格的大小，對準格子中央再按。"
                     "　　Backspace 退回上一步　　Esc 取消")
        self.canvas.itemconfig(self.error_id, text=error)

    # -- 第 1 步：拖出一格 --
    def _press(self, ev) -> None:
        if self.phase == 2:
            self._click_phase2(ev)
            return
        self.drag_start = (ev.x, ev.y)
        if self.band_id:
            self.canvas.delete(self.band_id)
        if self.tl_label_id is not None:
            self.canvas.delete(self.tl_label_id)
            self.tl_label_id = None
        self.band_id = self.canvas.create_rectangle(ev.x, ev.y, ev.x, ev.y,
                                                    outline="#5ac36a", width=3)

    def _drag(self, ev) -> None:
        if self.phase == 1 and self.drag_start and self.band_id:
            self.canvas.coords(self.band_id, self.drag_start[0], self.drag_start[1], ev.x, ev.y)

    def _release(self, ev) -> None:
        if self.phase != 1 or not self.drag_start:
            return
        x0, y0 = self.drag_start
        w, h = abs(ev.x - x0), abs(ev.y - y0)
        if w < self.MIN_CELL or h < self.MIN_CELL:
            self._refresh_text("框太小了，請沿著格子的邊框重新拖一次")
            return
        left, top = self._to_screen(min(x0, ev.x), min(y0, ev.y))
        self.cell_box = V.Region(left, top, w, h)
        self.phase = 2
        self.drag_start = None
        # 標一下這是左上角，免得跟第 2 步點出來的綠框混在一起分不清
        self.tl_label_id = self.canvas.create_text(
            min(x0, ev.x) + w / 2, min(y0, ev.y) + h / 2,
            text="左上", fill="#5ac36a", font=(UI_FONT, 13, "bold"))
        self._refresh_text()

    # -- 第 2 步：點三個角落 --
    def _motion(self, ev) -> None:
        if self.phase != 2 or self.cell_box is None:
            return
        for gid in self.ghost_ids:
            self.canvas.delete(gid)
        self.ghost_ids = []
        hw, hh = self.cell_box.width / 2, self.cell_box.height / 2
        self.ghost_ids.append(self.canvas.create_rectangle(
            ev.x - hw, ev.y - hh, ev.x + hw, ev.y + hh, outline="#ffffff", width=2))
        self.ghost_ids.append(self.canvas.create_line(
            ev.x - 10, ev.y, ev.x + 10, ev.y, fill="#ffffff", width=1))
        self.ghost_ids.append(self.canvas.create_line(
            ev.x, ev.y - 10, ev.x, ev.y + 10, fill="#ffffff", width=1))

    def _click_phase2(self, ev) -> None:
        self.points.append(self._to_screen(ev.x, ev.y))
        self._draw_marks()
        if len(self.points) < len(self.CORNER_NAMES):
            self._refresh_text()
            return
        try:
            cal = V.calibration_from_corners(
                self.cell_box, self.points[0], self.points[1], self.points[2],
                self.rows, self.cols)
        except ValueError as e:
            self.points.clear()
            self._draw_marks()
            self._refresh_text(str(e))
            return
        self._release_grab()
        self.destroy()
        self.on_done(cal)

    def _draw_marks(self) -> None:
        for mid_ in self.mark_ids:
            self.canvas.delete(mid_)
        self.mark_ids = []
        if self.cell_box is None:
            return
        hw, hh = self.cell_box.width / 2, self.cell_box.height / 2
        for i, pt in enumerate(self.points):
            cx, cy = self._to_canvas(*pt)
            self.mark_ids.append(self.canvas.create_rectangle(
                cx - hw, cy - hh, cx + hw, cy + hh, outline="#5ac36a", width=3))
            self.mark_ids.append(self.canvas.create_text(
                cx, cy, text=self.CORNER_NAMES[i], fill="#5ac36a",
                font=(UI_FONT, 13, "bold")))

    def _undo(self) -> None:
        if self.phase == 2 and self.points:
            self.points.pop()
            self._draw_marks()
        elif self.phase == 2:
            self.phase = 1
            self.cell_box = None
            for gid in self.ghost_ids:
                self.canvas.delete(gid)
            self.ghost_ids = []
            if self.tl_label_id is not None:
                self.canvas.delete(self.tl_label_id)
                self.tl_label_id = None
        self._refresh_text()

    def _cancel(self) -> None:
        self._release_grab()
        self.destroy()
        self.on_done(None)

    def _release_grab(self) -> None:
        try:
            self.grab_release()
        except tk.TclError:
            pass


class AdbCalibrationDialog(tk.Toplevel):
    """手機版的校準：跟 CalibrationOverlay 做一樣的兩步（框左上角一格、
    點右上/右下/左下三格中心），但底圖是一張**靜態截圖**而不是即時桌面。

    手機截圖通常比螢幕大，顯示前先縮小到放得下的尺寸，`self.scale` 記住
    縮放比例，點擊座標一律先換算回原始手機像素再丟給
    `V.calibration_from_corners()` —— 算出來的範圍才會是手機真正的像素座標，
    AdbGrabber.grab() 拿去裁切才會準。

    顯示上限預設用「使用者電腦的實際螢幕大小」（扣掉標題文字跟邊距），
    不是寫死的小尺寸——不然截圖在大螢幕上只會佔一小角，點起來很不準。
    `max_display` 開放外部指定，是為了讓測試能固定用一個跟真實螢幕大小
    無關的小尺寸，穩定驗證「確實有縮放」這條路，不會因為跑測試那台機器
    螢幕夠大就使不上力。
    """

    CORNER_NAMES = ("右上", "右下", "左下")
    SCREEN_MARGIN = (100, 220)   # 螢幕寬高各要扣掉多少給邊距跟上方文字

    def __init__(self, master: tk.Misc, image: np.ndarray, rows: int, cols: int, on_done,
                 max_display: Optional[Tuple[int, int]] = None) -> None:
        super().__init__(master)
        self.rows = rows
        self.cols = cols
        self.on_done = on_done
        img_h, img_w = image.shape[:2]
        if max_display is None:
            master.update_idletasks()
            margin_w, margin_h = self.SCREEN_MARGIN
            max_display = (max(240, master.winfo_screenwidth() - margin_w),
                          max(240, master.winfo_screenheight() - margin_h))
        max_w, max_h = max_display
        self.scale = min(max_w / img_w, max_h / img_h, 1.0)
        disp_w = max(1, round(img_w * self.scale))
        disp_h = max(1, round(img_h * self.scale))

        self.phase = 1
        self.drag_start: Optional[tuple] = None
        self.cell_box: Optional[V.Region] = None      # 手機像素座標（未縮放）
        self.points: List[tuple] = []                 # 手機像素座標（未縮放）
        self.band_id: Optional[int] = None
        self.mark_ids: List[int] = []
        self.ghost_ids: List[int] = []

        self.title("校準盤面（手機截圖）")
        self.configure(bg="#000000")
        self.attributes("-topmost", True)
        self.resizable(False, False)

        self.title_var = tk.StringVar()
        self.hint_var = tk.StringVar()
        self.error_var = tk.StringVar()
        tk.Label(self, textvariable=self.title_var, fg="#ffffff", bg="#000000",
                font=(UI_FONT, 13, "bold")).pack(pady=(10, 2))
        tk.Label(self, textvariable=self.hint_var, fg="#c8ccd2", bg="#000000",
                font=(UI_FONT, 10), wraplength=disp_w, justify="center").pack()
        tk.Label(self, textvariable=self.error_var, fg="#ff8a8a", bg="#000000",
                font=(UI_FONT, 10, "bold")).pack(pady=(2, 6))

        self.canvas = tk.Canvas(self, width=disp_w, height=disp_h,
                                highlightthickness=0, cursor="crosshair", bg="#000000")
        self.canvas.pack(padx=10, pady=(0, 10))
        pil_img = Image.fromarray(image).resize((disp_w, disp_h), Image.BILINEAR)
        self._photo = ImageTk.PhotoImage(pil_img)   # 一定要留住參照，不然畫布會變空白
        self.canvas.create_image(0, 0, anchor="nw", image=self._photo)

        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._drag)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.canvas.bind("<Motion>", self._motion)
        self.bind("<Escape>", lambda _e: self._cancel())
        self.bind("<BackSpace>", lambda _e: self._undo())
        self.protocol("WM_DELETE_WINDOW", self._cancel)
        self.update_idletasks()
        self._center_on_screen()
        try:
            self.grab_set()
            self.focus_force()
        except tk.TclError:
            pass
        self._refresh_text()

    def _center_on_screen(self) -> None:
        w, h = self.winfo_reqwidth(), self.winfo_reqheight()
        x = max(0, (self.winfo_screenwidth() - w) // 2)
        y = max(0, (self.winfo_screenheight() - h) // 2)
        self.geometry(f"+{x}+{y}")

    # -- 座標換算：畫布是縮小過的，點擊位置要放大回真正的手機像素 --
    def _to_image(self, x: float, y: float) -> tuple:
        return int(round(x / self.scale)), int(round(y / self.scale))

    def _to_canvas(self, x: float, y: float) -> tuple:
        return x * self.scale, y * self.scale

    def _refresh_text(self, error: str = "") -> None:
        if self.phase == 1:
            self.title_var.set("第 1 步 / 共 2 步　框出「左上角那一格」")
            self.hint_var.set("沿著左上角那一顆水果的格子邊框拖曳，量出一格有多大。")
        else:
            done = len(self.points)
            nxt = self.CORNER_NAMES[done] if done < len(self.CORNER_NAMES) else ""
            self.title_var.set(f"第 2 步 / 共 2 步　點「{nxt}」那一格的中心（{done + 1}/3）")
            self.hint_var.set("依序點「右上→右下→左下」三格的中心。"
                              "Backspace 退回上一步　　Esc 取消")
        self.error_var.set(error)

    def _press(self, ev) -> None:
        if self.phase == 2:
            self._click_phase2(ev)
            return
        self.drag_start = (ev.x, ev.y)
        if self.band_id:
            self.canvas.delete(self.band_id)
        self.band_id = self.canvas.create_rectangle(ev.x, ev.y, ev.x, ev.y,
                                                     outline="#5ac36a", width=2)

    def _drag(self, ev) -> None:
        if self.phase == 1 and self.drag_start and self.band_id:
            self.canvas.coords(self.band_id, self.drag_start[0], self.drag_start[1], ev.x, ev.y)

    def _release(self, ev) -> None:
        if self.phase != 1 or not self.drag_start:
            return
        x0, y0 = self.drag_start
        left_d, top_d = min(x0, ev.x), min(y0, ev.y)
        right_d, bottom_d = max(x0, ev.x), max(y0, ev.y)
        left, top = self._to_image(left_d, top_d)
        right, bottom = self._to_image(right_d, bottom_d)
        w, h = right - left, bottom - top
        if w < 6 or h < 6:
            self.drag_start = None
            self._refresh_text("框太小了，請沿著格子的邊框重新拖一次")
            return
        self.cell_box = V.Region(left, top, w, h)
        self.phase = 2
        self.drag_start = None
        self._refresh_text()

    def _motion(self, ev) -> None:
        """第 2 步時讓游標帶著一格大小的白框走，跟桌面版校準一樣的預覽提示。"""
        if self.phase != 2 or self.cell_box is None:
            return
        for gid in self.ghost_ids:
            self.canvas.delete(gid)
        self.ghost_ids = []
        hw, hh = self._to_canvas(self.cell_box.width / 2, self.cell_box.height / 2)
        self.ghost_ids.append(self.canvas.create_rectangle(
            ev.x - hw, ev.y - hh, ev.x + hw, ev.y + hh, outline="#ffffff", width=2))
        self.ghost_ids.append(self.canvas.create_line(
            ev.x - 10, ev.y, ev.x + 10, ev.y, fill="#ffffff", width=1))
        self.ghost_ids.append(self.canvas.create_line(
            ev.x, ev.y - 10, ev.x, ev.y + 10, fill="#ffffff", width=1))

    def _click_phase2(self, ev) -> None:
        self.points.append(self._to_image(ev.x, ev.y))
        self._draw_marks()
        if len(self.points) < len(self.CORNER_NAMES):
            self._refresh_text()
            return
        try:
            cal = V.calibration_from_corners(
                self.cell_box, self.points[0], self.points[1], self.points[2],
                self.rows, self.cols)
        except ValueError as e:
            self.points.clear()
            self._draw_marks()
            self._refresh_text(str(e))
            return
        self._finish(cal)

    def _draw_marks(self) -> None:
        for mid_ in self.mark_ids:
            self.canvas.delete(mid_)
        self.mark_ids = []
        if self.cell_box is None:
            return
        hw, hh = self._to_canvas(self.cell_box.width / 2, self.cell_box.height / 2)
        for i, pt in enumerate(self.points):
            cx, cy = self._to_canvas(*pt)
            self.mark_ids.append(self.canvas.create_rectangle(
                cx - hw, cy - hh, cx + hw, cy + hh, outline="#5ac36a", width=2))
            self.mark_ids.append(self.canvas.create_text(
                cx, cy, text=self.CORNER_NAMES[i], fill="#5ac36a",
                font=(UI_FONT, 11, "bold")))

    def _undo(self) -> None:
        if self.phase == 2 and self.points:
            self.points.pop()
            self._draw_marks()
        elif self.phase == 2:
            self.phase = 1
            self.cell_box = None
            if self.band_id:
                self.canvas.delete(self.band_id)
                self.band_id = None
            for gid in self.ghost_ids:
                self.canvas.delete(gid)
            self.ghost_ids = []
        self._refresh_text()

    def _cancel(self) -> None:
        self._finish(None)

    def _finish(self, cal: Optional[V.Calibration]) -> None:
        try:
            self.grab_release()
        except tk.TclError:
            pass
        self.destroy()
        self.on_done(cal)


class RegionTuner(tk.Toplevel):
    """校準完的確認視窗：畫上格線讓使用者看對不對，可用方向鍵微調。"""

    PREVIEW_MAX = 460

    def __init__(self, master: "AssistApp", region: V.Region,
                 inset: Optional[float] = None) -> None:
        super().__init__(master)
        self.app = master
        self.region = region
        self.inset = master.cfg.inset if inset is None else inset
        self._photo: Optional[ImageTk.PhotoImage] = None
        self._accepted = False

        self.title("確認盤面範圍")
        self.configure(bg=BG)
        self.attributes("-topmost", True)
        self.resizable(False, False)

        tk.Label(
            self, bg=BG, fg=FG_DIM, font=(UI_FONT, 10), justify="left",
            text="紫色框要剛好套住每一顆水果。不準的話：\n"
                 "　方向鍵 = 平移 1px　　Shift+方向鍵 = 改變大小　　Ctrl+方向鍵 = 平移 10px",
        ).pack(padx=12, pady=(12, 6), anchor="w")

        self.canvas = tk.Canvas(self, bg="#000000", highlightthickness=1,
                                highlightbackground="#3a3f47")
        self.canvas.pack(padx=12)

        self.info = tk.Label(self, bg=BG, fg=FG_DIM, font=("Consolas", 9))
        self.info.pack(pady=(6, 0))

        row = tk.Frame(self, bg=BG)
        row.pack(padx=12, pady=12)
        tk.Button(row, text="重新自動吸附", command=self._refit, **btn_style()).pack(side="left", padx=4)
        tk.Button(row, text="重新框選", command=self._reselect, **btn_style()).pack(side="left", padx=4)
        tk.Button(row, text="確定", command=self._accept,
                  **btn_style(bg=ACCENT, fg="#10240f")).pack(side="left", padx=4)

        for key, dx, dy in (("Left", -1, 0), ("Right", 1, 0), ("Up", 0, -1), ("Down", 0, 1)):
            self.bind(f"<{key}>", lambda _e, dx=dx, dy=dy: self._nudge(dx, dy))
            self.bind(f"<Shift-{key}>", lambda _e, dx=dx, dy=dy: self._resize(dx, dy))
            self.bind(f"<Control-{key}>", lambda _e, dx=dx, dy=dy: self._nudge(dx * 10, dy * 10))
        self.bind("<Return>", lambda _e: self._accept())
        self.bind("<Escape>", lambda _e: self.destroy())
        # 校準期間背景偵測是暫停的，所以不管使用者從哪個出口離開這個視窗都要恢復，
        # 否則按 Esc 或右上角關掉之後整個程式就再也不會更新了
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.bind("<Destroy>", self._on_destroy)
        self.focus_force()
        self._render()

    def _on_destroy(self, event) -> None:
        if event.widget is self and not self._accepted:
            self.app.worker.resume()

    def _nudge(self, dx: int, dy: int) -> None:
        self.region = V.Region(self.region.left + dx, self.region.top + dy,
                               self.region.width, self.region.height)
        self._render()

    def _resize(self, dx: int, dy: int) -> None:
        w = max(40, self.region.width + dx)
        h = max(40, self.region.height + dy)
        self.region = V.Region(self.region.left, self.region.top, w, h)
        self._render()

    def _refit(self) -> None:
        fitted = V.autofit_screen(
            self.app.engine.grabber, self.region,
            self.app.cfg.rows, self.app.cfg.cols,
            screen=self.app.engine.grabber.virtual_screen(),
        )
        if fitted is None:
            messagebox.showinfo("自動吸附", "這個範圍看不出格線，請手動微調或重新框選。", parent=self)
            return
        self.region = fitted
        self._render()

    def _reselect(self) -> None:
        self.destroy()
        self.app.start_calibration()

    def _accept(self) -> None:
        self._accepted = True
        region, inset = self.region, self.inset
        # 先關掉自己再偵測視窗：apply_region 會用 WindowFromPoint 認「這個
        # 位置現在是哪個視窗」，這個確認視窗自己是 topmost 又常常剛好蓋在
        # 棋盤正中央，順序顛倒的話會把自己的 hwnd 當成模擬器鎖起來——
        # 一按「確定」這個視窗馬上關掉，之後每次都找不到那個標題的視窗，
        # 整個輔助器就卡死在「尚未校準」。update_idletasks() 是確保
        # destroy() 真的先從畫面上消失，不是還沒來得及重繪就被打點。
        self.destroy()
        self.app.update_idletasks()
        self.app.apply_region(region, inset)

    def _render(self) -> None:
        try:
            img = self.app.engine.grabber.grab(self.region)
        except (ValueError, OSError) as e:
            self.info.config(text=f"抓不到畫面：{e}", fg=ERROR)
            return

        pil = Image.fromarray(img)
        scale = min(self.PREVIEW_MAX / pil.width, self.PREVIEW_MAX / pil.height, 1.0)
        disp = pil.resize((max(1, int(pil.width * scale)), max(1, int(pil.height * scale))),
                          Image.BILINEAR)
        self._photo = ImageTk.PhotoImage(disp)

        self.canvas.config(width=disp.width, height=disp.height)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor="nw", image=self._photo)

        grid = V.Grid(self.app.cfg.rows, self.app.cfg.cols, self.inset)
        for x0, y0, x1, y1 in grid.cell_boxes(self.region.width, self.region.height):
            self.canvas.create_rectangle(x0 * scale, y0 * scale, x1 * scale, y1 * scale,
                                         outline="#d264d2", width=2)
        self.info.config(
            text=f"left={self.region.left}  top={self.region.top}  "
                 f"{self.region.width}x{self.region.height}  "
                 f"每格 {self.region.width / self.app.cfg.cols:.1f}x"
                 f"{self.region.height / self.app.cfg.rows:.1f}"
                 f"  內縮 {self.inset:.3f}",
            fg=FG_DIM,
        )


# ---------------------------------------------------------------- 標記水果

class LabelDialog(tk.Toplevel):
    """把每一格的縮圖排出來讓使用者填號碼，填完一次就記住。"""

    CELL_PX = 72

    def __init__(self, master: "AssistApp", reading: V.Reading, focus_unknown: bool) -> None:
        super().__init__(master)
        self.app = master
        self.reading = reading
        self._photos: List[ImageTk.PhotoImage] = []
        self.entries: List[tk.Entry] = []

        self.title("標記水果")
        self.configure(bg=BG)
        self.attributes("-topmost", True)
        self.resizable(False, False)

        tk.Label(
            self, bg=BG, fg=FG, font=(UI_FONT, 11, "bold"),
            text="填入每一格水果上的號碼；空格請填 0",
        ).pack(padx=14, pady=(14, 2), anchor="w")
        tk.Label(
            self, bg=BG, fg=FG_DIM, font=(UI_FONT, 9), justify="left",
            text="黃框 = 程式認不得的格子，這幾格一定要填。其他格已經填好目前的判讀，\n"
                 "如果判讀是對的就不用動；發現讀錯的話直接改掉，存檔後會一起學進去。",
        ).pack(padx=14, pady=(0, 10), anchor="w")

        grid_frame = tk.Frame(self, bg=BG)
        grid_frame.pack(padx=14)

        cols = self.app.cfg.cols
        for i, crop in enumerate(reading.crops):
            r, c = divmod(i, cols)
            cell = tk.Frame(grid_frame, bg=BG)
            cell.grid(row=r, column=c, padx=4, pady=4)

            unknown = reading.cells[i] is None
            border = tk.Frame(cell, bg=WARN if unknown else "#3a3f47", padx=2, pady=2)
            border.pack()

            pil = Image.fromarray(crop).resize((self.CELL_PX, self.CELL_PX), Image.BILINEAR)
            photo = ImageTk.PhotoImage(pil)
            self._photos.append(photo)
            tk.Label(border, image=photo, bd=0).pack()

            entry = tk.Entry(cell, width=5, justify="center", font=(UI_FONT, 12),
                             bg=BG_PANEL, fg=FG, insertbackground=FG,
                             relief="flat", highlightthickness=1,
                             highlightbackground=WARN if unknown else "#3a3f47",
                             highlightcolor=ACCENT)
            entry.pack(pady=(4, 0))
            if reading.cells[i] is not None:
                entry.insert(0, str(reading.cells[i]))
            self.entries.append(entry)

        self.hint = tk.Label(self, bg=BG, fg=FG_DIM, font=(UI_FONT, 9))
        self.hint.pack(pady=(8, 0))

        row = tk.Frame(self, bg=BG)
        row.pack(padx=14, pady=12)
        tk.Button(row, text="取消", command=self.destroy, **btn_style()).pack(side="left", padx=4)
        tk.Button(row, text="存檔並開始", command=self._save,
                  **btn_style(bg=ACCENT, fg="#10240f")).pack(side="left", padx=4)

        self.bind("<Escape>", lambda _e: self.destroy())
        self.bind("<Return>", lambda _e: self._save())

        first = next((i for i, c in enumerate(reading.cells) if c is None), 0) if focus_unknown else 0
        self.entries[first].focus_set()
        self.entries[first].select_range(0, "end")

    def _save(self) -> None:
        labels: List[Optional[int]] = []
        for i, entry in enumerate(self.entries):
            text = entry.get().strip()
            if not text:
                if self.reading.cells[i] is None:
                    self.hint.config(text=f"第 {i // self.app.cfg.cols + 1} 列第 "
                                          f"{i % self.app.cfg.cols + 1} 格還沒填", fg=ERROR)
                    entry.focus_set()
                    return
                labels.append(None)
                continue
            try:
                value = int(text)
            except ValueError:
                self.hint.config(text=f"「{text}」不是數字", fg=ERROR)
                entry.focus_set()
                return
            if not 0 <= value <= S.MAX_RANK:
                self.hint.config(text=f"號碼要在 0 到 {S.MAX_RANK} 之間", fg=ERROR)
                entry.focus_set()
                return
            labels.append(value)

        added = self.app.learn(self.reading.crops, labels)
        self.destroy()
        learned = f"學到 {added} 張新樣板，樣板庫共 {len(self.app.engine.db)} 張"
        if self.app.resume_autoplay_if_interrupted():
            self.app.flash(f"{learned}；自動操控接回去了 —— "
                           f"按 {self.app.cfg.panic_key} 可隨時停止", 6)
        else:
            self.app.flash(learned)


# ---------------------------------------------------------------- 設定

METHOD_LABELS = {
    "swipe": "滑鼠滑動（推薦）",
    "arrows": "鍵盤方向鍵",
    "wasd": "鍵盤 W A S D",
}
CAPTURE_SOURCE_LABELS = {
    "screen": "PC 模擬器（螢幕擷取）",
    "adb": "手機（USB 接 adb）",
}

# (欄位, 標題, 說明, 型別, 下限, 上限)
DETECT_FIELDS = [
    # 上限刻意壓在「還算合理」的範圍內：4x4 想超過 1 秒早就沒有增益，
    # 但少打一個小數點（0.5 打成 05）就會變成 5 秒，整個慢到像當機。
    # 寧可跳出「要在 0.05 到 1.5 之間」的紅字，也不要默默收下。
    ("time_budget", "思考時間（秒）", "0.2～0.5 就很夠；記得打小數點", float, 0.05, 1.5),
    ("poll_ms", "偵測間隔（毫秒）", "多久看一次畫面，全自動可壓到 50", int, 50, 5000),
    ("tolerance", "辨識門檻", "越小越嚴格；認不得的格子變多就調大", float, 4.0, 40.0),
    ("inset", "取樣內縮比例", "每格四邊往內縮多少，0.05～0.20", float, 0.01, 0.45),
    ("opacity", "視窗透明度", "0.2～1.0", float, 0.2, 1.0),
]
AUTO_FIELDS = [
    ("swipe_fraction", "滑動距離比例", "佔盤面短邊的比例，滑不動就調大", float, 0.1, 0.9),
    ("swipe_ms", "滑動時間（毫秒）", "太快會被遊戲判成點擊", int, 30, 1000),
    ("move_interval", "每步間隔（秒）", "兩步之間至少隔多久；記得打小數點", float, 0.1, 2.0),
]


class SettingsDialog(tk.Toplevel):
    def __init__(self, master: "AssistApp") -> None:
        super().__init__(master)
        self.app = master
        self.title("設定")
        self.configure(bg=BG)
        self.attributes("-topmost", True)
        self.resizable(False, False)

        cfg = master.cfg
        self.vars: dict = {}

        body = tk.Frame(self, bg=BG)
        body.pack(padx=16, pady=(16, 6))

        left = self._section(body, "偵測與求解")
        left.grid(row=0, column=0, sticky="n")
        for spec in DETECT_FIELDS:
            self._number_row(left, cfg, spec)

        right = self._section(body, "自動操控")
        right.grid(row=0, column=1, sticky="n", padx=(24, 0))
        self._choice_row(right, "操控方式", "autoplay_method",
                         METHOD_LABELS, cfg.autoplay_method,
                         "模擬器有設按鍵對應才選鍵盤")
        self._choice_row(right, "緊急停止鍵", "panic_key",
                         {k: k for k in C.PANIC_KEYS}, cfg.panic_key,
                         "按下去就立刻停手，不用切視窗")
        for spec in AUTO_FIELDS:
            self._number_row(right, cfg, spec)

        far = self._section(body, "畫面來源")
        far.grid(row=0, column=2, sticky="n", padx=(24, 0))
        self._choice_row(far, "來源", "capture_source",
                         CAPTURE_SOURCE_LABELS, cfg.capture_source,
                         "改這個之後要重新校準一次")
        self._text_row(far, "手機序號", "adb_serial", cfg.adb_serial,
                       "adb devices 看到的那串；留白就自動挑唯一一台")

        self.hint = tk.Label(self, bg=BG, fg=ERROR, font=(UI_FONT, 9), wraplength=460)
        self.hint.pack()

        row = tk.Frame(self, bg=BG)
        row.pack(pady=(4, 14))
        tk.Button(row, text="清空樣板庫", command=self._clear_templates,
                  **btn_style(fg=WARN)).pack(side="left", padx=4)
        tk.Button(row, text="取消", command=self.destroy, **btn_style()).pack(side="left", padx=4)
        tk.Button(row, text="套用", command=self._apply,
                  **btn_style(bg=ACCENT, fg="#10240f")).pack(side="left", padx=4)
        self.bind("<Escape>", lambda _e: self.destroy())

    def _section(self, parent: tk.Misc, title: str) -> tk.Frame:
        wrap = tk.Frame(parent, bg=BG)
        tk.Label(wrap, text=title, bg=BG, fg=ACCENT, font=(UI_FONT, 10, "bold")).pack(
            anchor="w", pady=(0, 4))
        inner = tk.Frame(wrap, bg=BG)
        inner.pack(anchor="w")
        wrap.inner = inner  # type: ignore[attr-defined]
        return wrap

    def _number_row(self, section: tk.Frame, cfg: Config, spec) -> None:
        key, label, hint, _kind, _lo, _hi = spec
        parent = section.inner  # type: ignore[attr-defined]
        line = tk.Frame(parent, bg=BG)
        line.pack(anchor="w", fill="x", pady=(6, 0))
        tk.Label(line, text=label, bg=BG, fg=FG, font=(UI_FONT, 10), width=15,
                 anchor="w").pack(side="left")
        var = tk.StringVar(value=str(getattr(cfg, key)))
        self.vars[key] = var
        tk.Entry(line, textvariable=var, width=8, justify="center", font=(UI_FONT, 10),
                 bg=BG_PANEL, fg=FG, insertbackground=FG, relief="flat",
                 highlightthickness=1, highlightbackground="#3a3f47",
                 highlightcolor=ACCENT).pack(side="left")
        tk.Label(parent, text=hint, bg=BG, fg=FG_DIM, font=(UI_FONT, 8),
                 anchor="w").pack(anchor="w")

    def _choice_row(self, section: tk.Frame, label: str, key: str,
                    options: dict, current: str, hint: str) -> None:
        parent = section.inner  # type: ignore[attr-defined]
        line = tk.Frame(parent, bg=BG)
        line.pack(anchor="w", fill="x", pady=(6, 0))
        tk.Label(line, text=label, bg=BG, fg=FG, font=(UI_FONT, 10), width=15,
                 anchor="w").pack(side="left")
        var = tk.StringVar(value=options.get(current, next(iter(options.values()))))
        self.vars[key] = (var, {v: k for k, v in options.items()})
        menu = tk.OptionMenu(line, var, *options.values())
        menu.config(bg=BG_PANEL, fg=FG, font=(UI_FONT, 9), relief="flat", bd=0,
                    highlightthickness=0, activebackground="#39404a", width=14,
                    anchor="w")
        menu["menu"].config(bg=BG_PANEL, fg=FG, font=(UI_FONT, 9), bd=0)
        menu.pack(side="left")
        tk.Label(parent, text=hint, bg=BG, fg=FG_DIM, font=(UI_FONT, 8),
                 anchor="w").pack(anchor="w")

    def _text_row(self, section: tk.Frame, label: str, key: str,
                 current: Optional[str], hint: str) -> None:
        """自由文字、可以留白的欄位（跟 _number_row 不同，不驗證數字範圍）。"""
        parent = section.inner  # type: ignore[attr-defined]
        line = tk.Frame(parent, bg=BG)
        line.pack(anchor="w", fill="x", pady=(6, 0))
        tk.Label(line, text=label, bg=BG, fg=FG, font=(UI_FONT, 10), width=15,
                 anchor="w").pack(side="left")
        var = tk.StringVar(value=current or "")
        self.vars[key] = var
        tk.Entry(line, textvariable=var, width=16, font=(UI_FONT, 10),
                 bg=BG_PANEL, fg=FG, insertbackground=FG, relief="flat",
                 highlightthickness=1, highlightbackground="#3a3f47",
                 highlightcolor=ACCENT).pack(side="left")
        tk.Label(parent, text=hint, bg=BG, fg=FG_DIM, font=(UI_FONT, 8),
                 anchor="w").pack(anchor="w")

    def _clear_templates(self) -> None:
        if not messagebox.askyesno(
            "清空樣板庫",
            "會忘掉所有學過的水果外觀，之後要重新標記一次。確定嗎？", parent=self
        ):
            return
        self.app.clear_templates()
        self.destroy()

    def _apply(self) -> None:
        parsed = {}
        for key, label, _hint, kind, lo, hi in DETECT_FIELDS + AUTO_FIELDS:
            raw = self.vars[key].get().strip()
            try:
                value = kind(raw)
            except ValueError:
                self.hint.config(text=f"「{label}」填的「{raw}」不是數字")
                return
            if not lo <= value <= hi:
                self.hint.config(text=f"「{label}」要在 {lo} 到 {hi} 之間（填了 {value}）")
                return
            parsed[key] = value

        for key in ("autoplay_method", "panic_key", "capture_source"):
            var, reverse = self.vars[key]
            parsed[key] = reverse[var.get()]
        parsed["adb_serial"] = self.vars["adb_serial"].get().strip() or None

        source_changed = parsed["capture_source"] != self.app.cfg.capture_source
        backend_changed = source_changed or parsed["adb_serial"] != self.app.cfg.adb_serial
        for key, value in parsed.items():
            setattr(self.app.cfg, key, value)
        if source_changed:
            # 螢幕座標跟手機像素是兩個不相干的座標系，換了來源舊的框選範圍
            # 完全沒意義，留著只會拿去裁出一塊不知道是哪裡的畫面。
            self.app.cfg.region = None
            self.app.cfg.window_anchor = None
            self.app.engine.stop_autoplay()
        self.app.apply_config()
        if backend_changed:
            self.app.engine.refresh_capture_backend()
        if source_changed:
            self.app.flash("畫面來源換了，請重新按「① 校準盤面」。", 10)
        self.destroy()


# ---------------------------------------------------------------- 主視窗

def btn_style(bg: str = BG_PANEL, fg: str = FG) -> dict:
    return dict(bg=bg, fg=fg, font=(UI_FONT, 10), relief="flat", bd=0,
                padx=12, pady=6, activebackground="#39404a", activeforeground=FG,
                cursor="hand2", highlightthickness=0)


class AssistApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.cfg = Config.load()
        self.engine = Engine(self.cfg)
        self.lock = threading.Lock()
        self.queue: "queue.Queue[Status]" = queue.Queue()
        self.worker = Worker(self.engine, self.lock, self.queue)
        self.last_reading: Optional[V.Reading] = None
        self._flash_until = 0.0

        self.title("水果 2048 輔助器")
        self.configure(bg=BG)
        self.attributes("-topmost", True)
        self.attributes("-alpha", self.cfg.opacity)
        self.resizable(False, False)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_ui()
        self._force_normal_window()
        self.worker.start()
        self.after(80, self._pump)

    def _force_normal_window(self) -> None:
        """不管是被什麼方式啟動的，都確保視窗是正常大小、看得到。

        兩種真的會發生的狀況：
          * 桌面捷徑本身是「最小化」啟動（用來壓掉 PowerShell 黑視窗），這個顯示狀態
            會經由 STARTUPINFO 一路繼承到這裡。
          * 前景有全螢幕獨佔的遊戲時，Windows 會把新出現的視窗壓成最小化。
        被壓成最小化的話 Tk 不會完成初始版面計算，還原之後會變成一個 140x39 的小殘塊。
        所以這裡明確還原狀態，再把 geometry 清掉讓 Tk 依內容重新量一次尺寸。
        """
        try:
            self.update_idletasks()
            if self.state() != "normal":
                self.state("normal")
            self.deiconify()
            self.geometry("")          # 清掉尺寸，讓 Tk 依內容重算
            self.update_idletasks()
        except tk.TclError:
            pass

    # -- 版面 --
    def _build_ui(self) -> None:
        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=16, pady=(14, 4))

        self.arrow = tk.Label(head, text="—", bg=BG, fg=FG_DIM, font=(UI_FONT, 56, "bold"))
        self.arrow.pack(side="left")

        head_text = tk.Frame(head, bg=BG)
        head_text.pack(side="left", padx=(14, 0), anchor="center")
        self.move_name = tk.Label(head_text, text="等待中", bg=BG, fg=FG_DIM,
                                  font=(UI_FONT, 22, "bold"))
        self.move_name.pack(anchor="w")
        self.move_hint = tk.Label(head_text, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 10))
        self.move_hint.pack(anchor="w")

        body = tk.Frame(self, bg=BG)
        body.pack(fill="x", padx=16, pady=(6, 0))

        board_wrap = tk.Frame(body, bg="#12141a", padx=6, pady=6)
        board_wrap.pack(side="left")
        self.cells: List[tk.Label] = []
        for i in range(16):
            r, c = divmod(i, 4)
            lbl = tk.Label(board_wrap, text="", width=3, height=1,
                           font=(UI_FONT, 15, "bold"), bg=fruit_color(0), fg=FG)
            lbl.grid(row=r, column=c, padx=2, pady=2, ipadx=2, ipady=6)
            self.cells.append(lbl)

        rank = tk.Frame(body, bg=BG)
        rank.pack(side="left", padx=(16, 0), anchor="n")
        tk.Label(rank, text="四個方向評分", bg=BG, fg=FG_DIM, font=(UI_FONT, 9)).pack(anchor="w")
        self.rank_rows: List[tk.Label] = []
        for _ in range(4):
            lbl = tk.Label(rank, text="", bg=BG, fg=FG_DIM, font=("Consolas", 10), anchor="w")
            lbl.pack(anchor="w", pady=1)
            self.rank_rows.append(lbl)

        self.status = tk.Label(self, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 9),
                               wraplength=430, justify="left", anchor="w")
        self.status.pack(fill="x", padx=16, pady=(10, 0))

        auto = tk.Frame(self, bg=BG)
        auto.pack(fill="x", padx=16, pady=(12, 0))
        self.auto_btn = tk.Button(auto, text="▶ 開始自動玩", command=self.toggle_autoplay,
                                  **btn_style(bg="#2f6b38", fg="#dff5e2"))
        self.auto_btn.pack(side="left")
        self.auto_note = tk.Label(auto, text="", bg=BG, fg=FG_DIM, font=(UI_FONT, 9))
        self.auto_note.pack(side="left", padx=(10, 0))
        self._sync_auto_note()

        bar = tk.Frame(self, bg=BG)
        bar.pack(fill="x", padx=12, pady=12)
        tk.Button(bar, text="① 校準盤面", command=self.start_calibration,
                  **btn_style()).pack(side="left", padx=2)
        tk.Button(bar, text="② 標記水果", command=self.open_labeler,
                  **btn_style()).pack(side="left", padx=2)
        tk.Button(bar, text="重新吸附", command=self.refit,
                  **btn_style()).pack(side="left", padx=2)
        self.pause_btn = tk.Button(bar, text="暫停", command=self.toggle_pause, **btn_style())
        self.pause_btn.pack(side="left", padx=2)
        tk.Button(bar, text="⚙", command=lambda: SettingsDialog(self),
                  **btn_style()).pack(side="right", padx=2)

        self.footer = tk.Label(self, text="", bg=BG, fg="#5c626b", font=("Consolas", 8))
        self.footer.pack(fill="x", padx=16, pady=(0, 8))

    # -- 事件 --
    def _pump(self) -> None:
        # 緊急停止在 UI 執行緒也檢查一次。背景執行緒正在滑動時是不會回頭看的，
        # 這裡每 60ms 檢查一次，按下去的反應快得多。
        if self.engine.autoplay and C.panic_pressed(self.cfg.panic_key):
            self.engine.stop_autoplay()
            self._sync_auto_note()
            self.flash(f"已按下 {self.cfg.panic_key}，自動操控停止")

        self._sync_pause_btn()

        latest: Optional[Status] = None
        try:
            while True:
                latest = self.queue.get_nowait()
        except queue.Empty:
            pass
        if latest is not None:
            self._render(latest)
        self.after(60, self._pump)

    def _sync_pause_btn(self) -> None:
        """讓「暫停／繼續」的字樣跟背景執行緒的真實狀態一致。

        校準、標記、重新吸附都會自己暫停再恢復背景偵測。字樣如果只在
        toggle_pause 裡改，走完那些流程就會對不上 —— 顯示「繼續」但其實在跑，
        使用者按下去反而把它停掉。每輪 _pump 同步一次最省事。
        """
        want = "繼續" if self.worker.paused else "暫停"
        if self.pause_btn.cget("text") != want:
            self.pause_btn.config(text=want)

    def _sync_auto_note(self) -> None:
        on = self.engine.autoplay
        self.auto_btn.config(
            text="■ 停止自動玩" if on else "▶ 開始自動玩",
            bg="#7a3030" if on else "#2f6b38",
            fg="#f7dede" if on else "#dff5e2",
        )
        played = self.engine.moves_played
        if on:
            self.auto_note.config(text=f"執行中 · 已走 {played} 步 · 按 {self.cfg.panic_key} 隨時停止",
                                  fg=ACCENT)
        else:
            self.auto_note.config(
                text=f"開啟後程式會自己控制滑鼠（已走 {played} 步）" if played
                     else "開啟後程式會自己控制滑鼠滑動盤面",
                fg=FG_DIM)

    def _render(self, st: Status) -> None:
        if st.reading is not None:
            self.last_reading = st.reading
        self._sync_auto_note()

        # 正常狀態帶訊息 = 剛剛自動學會了新水果。那只會出現一幀，不 flash 住的話
        # 下一輪就被空字串蓋掉，使用者根本來不及看到。
        if st.kind == "ok" and st.message:
            self.flash(st.message, 8)

        if st.cells:
            for i, value in enumerate(st.cells[:16]):
                unknown = st.reading is not None and st.reading.cells[i] is None
                self.cells[i].config(
                    text="?" if unknown else (str(value) if value else ""),
                    bg=WARN if unknown else fruit_color(value),
                    fg="#10240f" if unknown else ("#f4f5f7" if value else "#4a5058"),
                )

        if st.kind == "ok" and st.result is not None:
            best = st.result.best
            self.arrow.config(text=S.MOVE_ARROW[best], fg=ACCENT)
            self.move_name.config(text=f"往 {S.MOVE_NAME[best]} 滑", fg=FG)
            self.move_hint.config(
                text="自動執行中…" if st.autoplay else f"鍵盤 {S.MOVE_KEY[best]}",
                fg=ACCENT if st.autoplay else FG_DIM)
            top = st.result.scores[0].score
            for row, ms in zip(self.rank_rows, st.result.scores):
                if not ms.legal:
                    row.config(text=f"{S.MOVE_ARROW[ms.move]} {S.MOVE_NAME[ms.move]}  不能動",
                               fg="#5c626b")
                else:
                    gap = ms.score - top
                    tag = "★" if ms.move == best else " "
                    row.config(
                        text=f"{tag}{S.MOVE_ARROW[ms.move]} {S.MOVE_NAME[ms.move]}  "
                             f"{'最佳' if gap == 0 else f'{gap:+,.0f}'}",
                        fg=ACCENT if ms.move == best else FG_DIM,
                    )
            self.footer.config(text=f"深度 {st.result.depth}　{st.result.nodes:,} nodes　"
                                    f"{st.result.elapsed * 1000:.0f} ms　"
                                    f"樣板 {len(self.engine.db)} 張　"
                                    f"擷取 {self.engine.grabber.backend}")
        elif st.kind == "nomove":
            self.arrow.config(text="✕", fg=ERROR)
            self.move_name.config(text="遊戲結束", fg=ERROR)
            self.move_hint.config(text="")
        elif st.kind == "settling":
            # 盤面還在變，箭頭留著的是上一步的建議。整組調暗，讓人一眼看出
            # 「這是舊的、還沒跟上」，不會照著一個過期的方向滑。
            self.arrow.config(fg=FG_DIM)
            self.move_name.config(fg=FG_DIM)
            self.move_hint.config(text="畫面變動中…", fg=FG_DIM)
        else:
            self.arrow.config(text="—", fg=FG_DIM)
            self.move_name.config(text={"waiting": "尚未校準", "unknown": "需要標記",
                                        "misaligned": "校準跑掉了", "stopped": "已停止",
                                        "error": "出錯了"}.get(st.kind, "等待中"), fg=FG_DIM)
            self.move_hint.config(text="")
            for row in self.rank_rows:
                row.config(text="")

        if time.time() >= self._flash_until:
            color = {"error": ERROR, "misaligned": WARN,
                     "unknown": WARN, "stopped": WARN}.get(st.kind, FG_DIM)
            self.status.config(text=st.message, fg=color)

    def flash(self, text: str, seconds: float = 4.0) -> None:
        self.status.config(text=text, fg=ACCENT)
        self._flash_until = time.time() + seconds

    # -- 動作 --
    def start_calibration(self) -> None:
        self.engine.stop_autoplay()   # 校準期間絕對不能有東西在搶滑鼠
        self._sync_auto_note()
        self.worker.pause()

        if self.cfg.capture_source == "adb":
            self._start_adb_calibration()
            return

        self.withdraw()
        self.update_idletasks()
        screen = self.engine.grabber.virtual_screen()

        def done(cal: Optional[V.Calibration]) -> None:
            self.deiconify()
            if cal is None:
                self.worker.resume()
                self.flash("已取消校準")
                return
            if cal.skew > max(4.0, 0.06 * max(cal.pitch_x, cal.pitch_y)):
                messagebox.showwarning(
                    "點的位置好像有點歪",
                    f"從上下兩排量到的格距差了 {cal.skew:.0f} px，通常代表有一個角落點偏了。\n\n"
                    f"還是會先幫你算出來，請在接下來的預覽視窗確認紫色框有沒有套準；"
                    f"沒套準就按「重新框選」再來一次。",
                    parent=self,
                )
            # 使用者自己點出來的位置就是最可信的答案，這裡不再套自動吸附
            RegionTuner(self, cal.region, cal.inset)

        # 遮罩要等主視窗真的藏起來才建立，不然會把自己也框進去
        self.after(120, lambda: CalibrationOverlay(
            self, screen, self.cfg.rows, self.cfg.cols, done))

    def _start_adb_calibration(self) -> None:
        """手機沒有「桌面」可以蓋一層透明遮罩，改成先抓一張截圖、
        在一個一般視窗裡縮放顯示，讓使用者對著這張靜態圖點兩步。
        """
        try:
            full = self.engine.grabber.virtual_screen()
            img = self.engine.grabber.grab(full)
        except (ValueError, OSError) as e:
            self.worker.resume()
            self.flash(f"抓不到手機畫面：{e}", 10)
            return

        def done(cal: Optional[V.Calibration]) -> None:
            if cal is None:
                self.worker.resume()
                self.flash("已取消校準")
                return
            if cal.skew > max(4.0, 0.06 * max(cal.pitch_x, cal.pitch_y)):
                messagebox.showwarning(
                    "點的位置好像有點歪",
                    f"從上下兩排量到的格距差了 {cal.skew:.0f} px，通常代表有一個角落點偏了。\n\n"
                    f"還是會先幫你算出來，請在接下來的預覽視窗確認紫色框有沒有套準；"
                    f"沒套準就按「重新框選」再來一次。",
                    parent=self,
                )
            RegionTuner(self, cal.region, cal.inset)

        AdbCalibrationDialog(self, img, self.cfg.rows, self.cfg.cols, done)

    def _detect_window_anchor(self, region: V.Region) -> Optional[dict]:
        """校準完成時試著記住是哪個視窗，讓之後搬動這個視窗不用重新框。

        抓不到（例如底下根本不是一般的 Win32 視窗）就靜靜放棄，退回原本
        畫面座標寫死的行為 —— 這是錦上添花，不該讓校準本身因此失敗。
        """
        try:
            hwnd = C.window_at(region.left + region.width // 2, region.top + region.height // 2)
            if not hwnd:
                return None
            title = C.window_title(hwnd)
            rect = C.window_rect(hwnd)
            if not title or rect is None:
                return None
            return {"title": title, "dx": region.left - rect[0], "dy": region.top - rect[1]}
        except OSError:
            return None

    def apply_region(self, region: V.Region, inset: Optional[float] = None) -> None:
        # 視窗鎖定只在「框選範圍＝真的螢幕座標」時有意義；手機截圖的範圍是
        # 影像像素，拿去問 WindowFromPoint 只會問到 PC 桌面上某個不相干的視窗。
        anchor = self._detect_window_anchor(region) if self.cfg.capture_source == "screen" else None
        with self.lock:
            self.cfg.region = region.to_dict()
            if inset is not None:
                self.cfg.inset = float(inset)
            self.cfg.window_anchor = anchor
            self.cfg.save()
            self.engine.rebuild()
            # 立刻試讀一次，直接告訴使用者這次校準到底成不成立，
            # 不要讓人按了「確定」之後還要自己猜為什麼沒反應
            try:
                img = self.engine.snapshot()
                reading = self.engine.rec.read(img) if img is not None else None
            except (ValueError, OSError):
                reading = None
        self.worker.resume()

        note = (f" 順便鎖定了視窗「{anchor['title']}」，之後搬動這個視窗不用重新校準。"
                if anchor else "")
        if len(self.engine.db) == 0:
            self.flash(f"範圍存好了。接著按「② 標記水果」教它每格是幾號。{note}", 10)
        elif reading is not None and reading.ok:
            self.flash(f"範圍存好了，而且馬上就讀得懂盤面 —— 可以開始用了。{note}", 8)
        else:
            unknown = len(reading.unknown_indices) if reading else self.cfg.rows * self.cfg.cols
            self.flash(f"範圍存好了，但有 {unknown} 格對不上之前學過的樣板"
                       f"（切格位置變了就會這樣）。請按「② 標記水果」重新教一次。{note}", 12)

    def refit(self) -> None:
        if self.engine.region is None:
            self.flash("請先校準盤面")
            return
        self.worker.pause()
        with self.lock:
            ok = self.engine.refit_region()
        self.worker.resume()
        if ok and self.resume_autoplay_if_interrupted():
            self.flash("已重新吸附格線，自動操控接回去了", 6)
            return
        self.flash("已重新吸附格線" if ok else "吸附失敗，請按「① 校準盤面」重框一次")

    def open_labeler(self) -> None:
        if self.engine.region is None:
            self.flash("請先校準盤面")
            return
        # 標記期間先停手（不能一邊教一邊滑），但記著「本來在自動玩」，存完檔會接回去
        self.engine.stop_autoplay(resumable=True)
        self._sync_auto_note()
        self.worker.pause()
        with self.lock:
            try:
                img = self.engine.snapshot()
            except (ValueError, OSError) as e:
                img = None
                self.flash(f"抓不到畫面：{e}")
            reading = self.engine.rec.read(img) if img is not None else None
        if reading is None:
            self.worker.resume()
            return
        dialog = LabelDialog(self, reading, focus_unknown=not reading.ok)
        dialog.bind("<Destroy>", lambda e: self.worker.resume() if e.widget is dialog else None)

    def learn(self, crops, labels) -> int:
        with self.lock:
            added = self.engine.rec.learn(crops, labels)
            self.engine.db.save(TEMPLATES_PATH)
            self.engine.rebuild()
        return added

    def clear_templates(self) -> None:
        with self.lock:
            self.engine.db.clear()
            self.engine.db.save(TEMPLATES_PATH)
            self.engine.rebuild()
        self.flash("樣板庫已清空，請重新標記一次")

    def apply_config(self) -> None:
        with self.lock:
            self.cfg.save()
            self.engine.rebuild()
        self.attributes("-alpha", self.cfg.opacity)
        self.flash("設定已套用")

    def _overlaps_board(self) -> bool:
        """輔助器視窗有沒有蓋在盤面上。

        蓋住的話滑動會點到自己的視窗而不是遊戲，而且症狀很難懂（盤面完全沒反應），
        所以寧可事先擋下來講清楚。
        """
        region = self.engine.region
        if region is None:
            return False
        self.update_idletasks()
        left = self.winfo_rootx()
        top = self.winfo_rooty() - 40   # 標題列不在 rooty 範圍內，往上多算一點
        right = left + self.winfo_width()
        bottom = top + 40 + self.winfo_height()
        return not (right <= region.left or left >= region.right
                    or bottom <= region.top or top >= region.bottom)

    def toggle_autoplay(self) -> None:
        if self.engine.autoplay:
            self.engine.stop_autoplay()
            self._sync_auto_note()
            self.flash("自動操控已停止")
            return

        if self.engine.region is None:
            self.flash("請先按「① 校準盤面」")
            return
        if len(self.engine.db) == 0:
            self.flash("請先按「② 標記水果」，程式要看得懂盤面才能自己玩")
            return
        if self.cfg.autoplay_method == "swipe" and self._overlaps_board():
            messagebox.showwarning(
                "視窗擋住盤面了",
                "這個輔助器的視窗正蓋在遊戲盤面上。\n\n"
                "自動操控是用滑鼠在盤面上滑動的，視窗擋著的話會滑到自己身上、"
                "遊戲完全不會有反應。\n\n"
                "請先把輔助器視窗拖到旁邊，再按一次「開始自動玩」。",
                parent=self,
            )
            return

        how = {"swipe": "在盤面中央用滑鼠滑動",
               "arrows": "按方向鍵",
               "wasd": "按 W / A / S / D"}[self.cfg.autoplay_method]
        if not messagebox.askyesno(
            "開始自動操控",
            f"接下來程式會自己{how}，一步一步幫你玩。\n\n"
            f"隨時要停止：\n"
            f"　• 按 {self.cfg.panic_key}（不用切回這個視窗也有效）\n"
            f"　• 或再按一次「■ 停止自動玩」\n\n"
            f"開始前請確認模擬器視窗在最上層、沒有被其他視窗擋住。\n\n"
            f"要開始嗎？",
            parent=self,
        ):
            return

        self.engine.start_autoplay()
        self.worker.resume()
        self.pause_btn.config(text="暫停")
        self._sync_auto_note()
        self.flash(f"自動操控開始 —— 按 {self.cfg.panic_key} 可隨時停止", 6)

    def resume_autoplay_if_interrupted(self) -> bool:
        """把被辨識問題打斷的自動操控接回去。

        使用者按「② 標記水果」或「重新吸附」，本來就是為了讓它繼續玩；
        每次都還要再按一次「開始自動玩」＋確認視窗很煩。但只接「被打斷的」，
        沒在自動玩的時候標記水果不會憑空開始搶滑鼠。
        """
        if not self.engine.autoplay_resumable:
            return False
        if self.engine.region is None or len(self.engine.db) == 0:
            self.engine.autoplay_resumable = False
            return False
        if self.cfg.autoplay_method == "swipe" and self._overlaps_board():
            self.engine.autoplay_resumable = False
            self.flash("輔助器視窗蓋在盤面上，沒有自動接回去。"
                       "請把視窗挪開再按「▶ 開始自動玩」。", 10)
            return False
        self.engine.start_autoplay()
        self.worker.resume()
        self.pause_btn.config(text="暫停")
        self._sync_auto_note()
        return True

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
        self.worker.stop()
        self.destroy()


def main() -> int:
    app = AssistApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
