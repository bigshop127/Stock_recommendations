"""寶石排序輔助器的核心：鎖定使用者框選的範圍 → 擷取、辨識盤面 → 規劃 → （自動時）點擊。

跟水果2048／永夜迷城同樣的分工：UI（app.py）只負責顯示與按鈕，所有「看、判斷、動手」都在這裡，
而且刻意不碰 tkinter，測試時可以塞假的擷取來源、假的辨識、假的點擊函式，不必開視窗也不必碰真實遊戲。

核心原則（沿用前兩個專案的血淚教訓）：
  * **範圍就是全部。**擷取、辨識、點擊座標都以使用者框出來的那個矩形為準。
  * **寧可停手也不亂點。**認不得的畫面、盤面有疑點（顏色數量對不上、寶石數量變了、寶石中間有空隙）、
    點了沒反應、別的視窗蓋住遊戲、視窗縮小或大小變了——一律停下來說明原因，不硬猜。
  * **每一步都重新看畫面、重新規劃**：問號寶石顯現、藍罐解鎖之後多了新資訊，
    舊的計畫可能已經不是最好的，重算很快（一次 < 0.1 秒）。
  * **走完一步一定驗收**：等畫面穩定後檢查「盤面真的變成預期的樣子」。沒變 → 重試，重試仍沒變 →
    把這一步列入黑名單改走別的；預期外的變化 → 從新盤面重新規劃。
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Dict, List, Optional, Set, Tuple

import numpy as np

import control as C
import solver as S
import vision as V

# 資料夾可以用環境變數換掉——測試不能去動使用者真正的設定（fruit2048 踩過測試寫壞真實資料的坑）。
APP_DIR = os.environ.get("GEMSORT_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
PALETTE_PATH = os.path.join(APP_DIR, "palette.json")
DEBUG_DIR = os.path.join(APP_DIR, "debug")


# ---------------------------------------------------------------- 設定檔

@dataclass
class Config:
    region: Optional[dict] = None          # 使用者框選的範圍（螢幕座標）
    window_anchor: Optional[dict] = None   # {title, dx, dy, w, h}：範圍相對模擬器視窗左上角的位移
    poll_ms: int = 150
    stable_reads: int = 2                  # 連續幾次讀到同一個盤面才採信（擋掉動畫中間的畫面）
    click_hold: float = 0.06
    select_delay: float = 0.35             # 點完來源管、點目標管之間隔多久（讓遊戲的「選取」動畫跑完）
    move_settle: float = 0.8               # 點完目標管後，至少等這麼久才去看結果（搬移動畫）
    move_timeout: float = 6.0              # 點完之後畫面一直沒變化，多久算這一步沒生效
    max_retries: int = 1                   # 同一步沒生效最多重試幾次，再不行就列入黑名單改走別的
    unknown_timeout: float = 60.0          # 自動操控時連續認不得畫面多久就停手
    problem_timeout: float = 12.0          # 盤面有疑點（讀不準）持續多久就停手；看似無解也先等這麼久再停
    layout_settle: float = 3.0             # 管子排列變了要穩定撐多久才承認是換關（光效會讓某根管子暫時偵測不到）
    overlay_interval: float = 1.2          # 獎勵/結算畫面：兩次點擊之間至少隔多久
    overlay_retry_after: float = 4.0       # 點了之後畫面沒變，隔多久再點一次
    overlay_max_retries: int = 3
    max_levels: int = 0                    # 連闖上限（0 = 不限；「下一關」每關花 1 顆鑽石）
    samples: int = 4                       # 看不見的寶石：抽幾種可能的真相各解一次
    plan_time: float = 2.0                 # 單一世界的搜尋時間上限
    partial: bool = False                  # 目標管放不下整串時，能不能只搬一部分（實測不行就維持 False）
    opacity: float = 0.96
    panic_key: str = C.DEFAULT_PANIC_KEY
    # 「現在是不是自動操控」刻意不存檔：每次啟動都要人工按一次才會動，不會一開就搶滑鼠。

    @classmethod
    def load(cls) -> "Config":
        cfg = cls()
        if not os.path.exists(CONFIG_PATH):
            return cfg
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return cfg
        if isinstance(data, dict):
            for k, v in data.items():
                if hasattr(cfg, k):
                    setattr(cfg, k, v)
        return cfg

    def save(self) -> None:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)


# ---------------------------------------------------------------- 範圍追蹤（沿用永夜迷城，已在真 BlueStacks 驗證）

class RegionTracker:
    """回傳「現在這一刻」使用者框選的範圍在螢幕上的位置。

    框選時如果認得出範圍底下是哪個模擬器視窗，就記下範圍相對視窗左上角的位移（anchor）；
    之後每次擷取前重新找一次那個視窗，把位移套回去——把模擬器挪到別處不用重新框。
    只跟著「搬動」，視窗**大小**變了就停手請使用者重框。
    """

    SIZE_TOLERANCE = 2

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def current(self) -> Tuple[Optional[V.Region], Optional[str]]:
        if not self.cfg.region:
            return None, "還沒框選畫面範圍。按「① 框選畫面範圍」，拖曳框出模擬器裡的遊戲畫面。"
        base = V.Region.from_dict(self.cfg.region)
        anchor = self.cfg.window_anchor
        if not anchor:
            return base, None
        title = anchor["title"]
        hwnd = C.find_window(title)
        rect = C.window_rect(hwnd) if hwnd else None
        if rect is None or C.window_is_minimized(hwnd):
            return None, f"找不到視窗「{title}」——可能被關掉或縮到最小了。還原視窗就會自動接回去。"
        left, top, right, bottom = rect
        want_w, want_h = anchor.get("w"), anchor.get("h")
        if want_w and want_h and (abs((right - left) - want_w) > self.SIZE_TOLERANCE
                                  or abs((bottom - top) - want_h) > self.SIZE_TOLERANCE):
            return None, (f"視窗「{title}」的大小變了（框選時 {want_w}×{want_h}，現在 "
                          f"{right - left}×{bottom - top}），範圍對不上了。請按「① 框選畫面範圍」重框一次。")
        return V.Region(left + anchor["dx"], top + anchor["dy"], base.width, base.height), None

    def blocker(self, x: int, y: int) -> Optional[str]:
        """螢幕上 (x, y) 這一點最上層的視窗如果「不是遊戲的」，回傳它的描述；沒問題回 None。"""
        hwnd = C.window_at(x, y)
        if not hwnd:
            return None
        pid = C.window_pid(hwnd)
        if pid == os.getpid():
            return "輔助器自己的視窗"
        anchor = self.cfg.window_anchor
        if anchor:
            game = C.find_window(anchor["title"])
            if game and pid != C.window_pid(game):
                return f"別的程式的視窗「{C.window_title(hwnd) or '（無標題）'}」"
        return None

    @staticmethod
    def make_anchor(region: V.Region) -> Optional[dict]:
        """框選完成時試著記住範圍底下是哪個視窗。認不出來就回 None（視窗鎖定是錦上添花）。"""
        try:
            hwnd = C.window_at(region.left + region.width // 2, region.top + region.height // 2)
            if not hwnd or C.window_pid(hwnd) == os.getpid():
                return None
            title = C.window_title(hwnd)
            rect = C.window_rect(hwnd)
            if not title or rect is None:
                return None
            return {"title": title, "dx": region.left - rect[0], "dy": region.top - rect[1],
                    "w": rect[2] - rect[0], "h": rect[3] - rect[1]}
        except OSError:
            return None


# ---------------------------------------------------------------- 預測：走完一步之後盤面該長怎樣

def predict_cells(cells: List[List[str]], kinds: List[str], move: S.Move, cap: int = 4,
                  partial: bool = False) -> Optional[List[List[str]]]:
    """把 move 套到「目前看到的」盤面上（看不見的寶石維持看不見）。move 不合法回 None。"""
    s, d = move
    ts, td = cells[s], cells[d]
    if not ts or ts[-1] in S.UNKNOWN_CELLS:
        return None
    c = ts[-1]
    k = 1
    while k < len(ts) and ts[-1 - k] == c:
        k += 1
    room = cap - len(td)
    if room < k:
        if not partial or room <= 0:
            return None
        k = room
    out = [list(t) for t in cells]
    moved = out[s][-k:]
    del out[s][-k:]
    out[d].extend(moved)
    return out


def compatible(observed: List[List[str]], observed_kinds: List[str],
               predicted: List[List[str]], predicted_kinds: List[str]) -> bool:
    """實際看到的盤面跟預測一致嗎？預測裡「看不見」的格子，實際上是什麼都算對（顯現了）；
    藍罐鎖 → 一般管的變化也算對（合成一組會解鎖）。"""
    if len(observed) != len(predicted):
        return False
    for ok, pk, o, p in zip(observed_kinds, predicted_kinds, observed, predicted):
        if ok != pk and not (pk == "jar" and ok == "normal"):
            return False
        if len(o) != len(p):
            return False
        for a, b in zip(o, p):
            if b in S.UNKNOWN_CELLS:
                continue
            if a != b:
                return False
    return True


# ---------------------------------------------------------------- 引擎

@dataclass
class Status:
    kind: str                       # ok / settling / solved / stuck / unknown / waiting / error / stopped / overlay
    message: str = ""
    screen: str = ""                # level / reward / result / unknown
    board: Optional[V.Board] = None
    move: Optional[S.Move] = None   # 建議（或剛執行）的這一步
    plan: Optional[S.Plan] = None
    image: Optional[np.ndarray] = None
    region: Optional[V.Region] = None
    autoplay: bool = False
    moves_done: int = 0
    levels_done: int = 0
    level_moves: int = 0
    acted: str = ""                 # 這一輪剛做的動作（UI 記進「最近動作」）
    palette: Optional[V.Palette] = None


@dataclass
class _Pending:
    move: S.Move
    before_sig: tuple
    expected: Optional[List[List[str]]]
    expected_kinds: List[str]
    t: float
    attempts: int = 0


class Engine:
    """擷取 → 辨識 → 規劃 →（自動操控時）點擊 → 驗收。"""

    def __init__(self, cfg: Config,
                 grabber=None,
                 clicker: Optional[Callable[..., None]] = None,
                 guard: Optional[Callable[[int, int], Optional[str]]] = None,
                 busy: Optional[Callable[[], bool]] = None,
                 analyzer: Optional[Callable] = None,
                 sleep: Optional[Callable[[float], None]] = None,
                 clock: Optional[Callable[[], float]] = None,
                 palette: Optional[V.Palette] = None) -> None:
        self.cfg = cfg
        self.grabber = grabber or V.ScreenGrabber()
        self.tracker = RegionTracker(cfg)
        self._click = clicker or C.click
        self.guard = guard
        self._busy = busy or C.mouse_button_down
        self._analyze = analyzer or V.analyze
        self._sleep = sleep or time.sleep
        self._now = clock or time.monotonic
        self.palette = palette or V.Palette(PALETTE_PATH)
        self.autoplay = False
        self.moves_done = 0
        self.levels_done = 0
        self.last_image: Optional[np.ndarray] = None
        self.region: Optional[V.Region] = None
        self._reset_level()
        self._reset_flow()

    # ---- 狀態重置 ----
    def _reset_level(self) -> None:
        """新的一關開始：清掉這一關的所有暫存。"""
        self._banned: Set[S.Move] = set()
        self._pending: Optional[_Pending] = None
        self._total_gems: Optional[int] = None
        self._layout: Optional[tuple] = None
        self._layout_cand: Optional[tuple] = None      # 跟這一關不一樣的新排列（還在觀察，撐夠久才承認換關）
        self._layout_cand_since = 0.0
        self._nosol_since: Optional[float] = None      # 開始「看似無解」的時間
        self._level_moves = 0
        self._consec_bans = 0
        self._last_sig: Optional[tuple] = None
        self._same = 0
        self._problem_since: Optional[float] = None
        self._planner = S.Planner(samples=self.cfg.samples, time_limit=self.cfg.plan_time)

    def _reset_flow(self) -> None:
        self._unknown_since: Optional[float] = None
        self._ov_label: Optional[str] = None
        self._ov_n = 0
        self._ov_acted_at = 0.0
        self._ov_retry = 0
        self._ov_retry_label: Optional[str] = None
        self._ov_counted = False
        self._note = ""
        self._after_overlay = False

    def rebuild(self) -> None:
        self._reset_level()
        self._reset_flow()

    def _status(self, kind: str, message: str = "", **kw) -> Status:
        return Status(kind, message, autoplay=self.autoplay, moves_done=self.moves_done,
                      levels_done=self.levels_done, level_moves=self._level_moves,
                      region=self.region, palette=self.palette, **kw)

    def start_autoplay(self) -> None:
        self.autoplay = True
        self._consec_bans = 0
        self._problem_since = None
        self._unknown_since = None
        self._ov_retry = 0
        self._ov_acted_at = 0.0

    def stop_autoplay(self) -> None:
        self.autoplay = False
        self._pending = None

    # ---- 給 UI 用 ----
    def snapshot(self) -> np.ndarray:
        region, err = self.tracker.current()
        if region is None:
            raise ValueError(err)
        return self.grabber.grab(region)

    def _dump(self, img: np.ndarray, tag: str) -> Optional[str]:
        """把讀不準的畫面存起來，方便事後診斷（最多留 30 張）。"""
        try:
            from PIL import Image

            os.makedirs(DEBUG_DIR, exist_ok=True)
            path = os.path.join(DEBUG_DIR, f"{time.strftime('%Y%m%d_%H%M%S')}_{tag}.png")
            Image.fromarray(img).save(path)
            files = sorted(os.listdir(DEBUG_DIR))
            for old in files[:-30]:
                try:
                    os.remove(os.path.join(DEBUG_DIR, old))
                except OSError:
                    pass
            return path
        except Exception:
            return None

    @staticmethod
    def _dbg(path: Optional[str]) -> str:
        return f"（畫面已存到 debug/{os.path.basename(path)}）" if path else ""

    # ---- 主迴圈的一步 ----
    def step(self) -> Status:
        if self.autoplay and C.panic_pressed(self.cfg.panic_key):
            self.stop_autoplay()
            return self._status("stopped", f"偵測到 {self.cfg.panic_key}，自動操控已停止。")

        region, err = self.tracker.current()
        if region is None:
            self.region = None
            self._reset_level()
            self._reset_flow()
            return self._status("waiting", err or "")
        self.region = region

        try:
            img = self.grabber.grab(region)
        except (ValueError, OSError) as e:
            self.stop_autoplay()
            return self._status("error", f"抓不到畫面：{e}")
        self.last_image = img

        info = self._analyze(img, self.palette)
        if info.kind == "level":
            self._unknown_since = None
            self._ov_label, self._ov_n = None, 0
            return self._step_level(img, info, region)
        if info.kind in ("reward", "result"):
            self._unknown_since = None
            return self._step_overlay(img, info, region)
        return self._step_unknown(img, info)

    # -- 認不得的畫面 --
    def _step_unknown(self, img: np.ndarray, info) -> Status:
        now = self._now()
        self._ov_label, self._ov_n = None, 0
        self._last_sig, self._same = None, 0
        if self._unknown_since is None:
            self._unknown_since = now
        if self.autoplay and now - self._unknown_since > self.cfg.unknown_timeout:
            self.stop_autoplay()
            path = self._dump(img, "unknown")
            return self._status(
                "stopped",
                f"連續 {self.cfg.unknown_timeout:.0f} 秒認不得畫面，自動操控已停止。"
                f"可能是鑽石不夠的提示、活動彈窗或還沒見過的畫面——請手動處理"
                + (f"（畫面已存到 {os.path.basename(path)}）" if path else "。"),
                screen="unknown", image=img)
        return self._status("unknown", "現在不是關卡也不是結算畫面（轉場中，或還沒見過的畫面）。",
                            screen="unknown", image=img)

    # -- 過關後的兩段畫面 --
    def _step_overlay(self, img: np.ndarray, info, region: V.Region) -> Status:
        self._pending = None
        self._after_overlay = True
        label = info.kind
        if label == self._ov_label:
            self._ov_n += 1
        else:
            self._ov_label, self._ov_n = label, 1
        common = dict(screen=label, image=img)
        if self._ov_n < self.cfg.stable_reads:
            return self._status("settling", "畫面變動中…", **common)
        if not self.autoplay:
            return self._status("overlay", f"{info.detail}（自動操控關閉中，不會點）", **common)
        return self._act_overlay(label, info, region, img)

    def _act_overlay(self, label: str, info, region: V.Region, img: np.ndarray) -> Status:
        now = self._now()
        wait = lambda: self._status("overlay", info.detail, screen=label, image=img)   # noqa: E731
        if self._busy():
            return wait()
        if now - self._ov_acted_at < self.cfg.overlay_interval:
            return wait()
        if self._ov_acted_at and self._ov_retry_label == label:
            # 上次點完畫面還是同一種 → 那一下可能沒生效。等一下再試，連續幾次都沒反應就停手
            if now - self._ov_acted_at < self.cfg.overlay_retry_after:
                return wait()
            self._ov_retry += 1
            if self._ov_retry > self.cfg.overlay_max_retries:
                self.stop_autoplay()
                return self._status(
                    "stopped",
                    f"在{'結算' if label == 'result' else '獎勵'}畫面連續點了 {self.cfg.overlay_max_retries + 1} 次"
                    f"畫面都沒變化，已自動停止。請確認模擬器視窗在最上層、沒有被別的視窗擋住，"
                    f"或鑽石不夠（「下一關」要 1 顆）。", screen=label, image=img)
        else:
            self._ov_retry = 0
        if label == "result" and self.cfg.max_levels and self.levels_done >= self.cfg.max_levels                 and not self._ov_counted:
            self.stop_autoplay()
            return self._status("stopped", f"已連闖 {self.levels_done} 關（上限 {self.cfg.max_levels}），停手。"
                                           f"要繼續請再按一次「▶ 自動」。", screen=label, image=img)
        x = region.left + int(round(info.target[0]))
        y = region.top + int(round(info.target[1]))
        if self.guard is not None:
            blocked = self.guard(x, y)
            if blocked:
                self.stop_autoplay()
                return self._status("stopped", blocked, screen=label, image=img)
        try:
            self._click(x, y, hold=self.cfg.click_hold)
        except C.InputError as e:
            self.stop_autoplay()
            return self._status("error", str(e), screen=label, image=img)
        except OSError as e:
            self.stop_autoplay()
            return self._status("error", f"送出點擊失敗：{e}", screen=label, image=img)
        self._ov_acted_at = self._now()
        self._ov_retry_label = label
        self._ov_n = 0
        if label == "result" and not self._ov_counted:
            self._ov_counted = True
            self.levels_done += 1
        what = "「下一關」" if label == "result" else "空白處（繼續）"
        return self._status("overlay", info.detail, screen=label, image=img, acted=f"過關畫面 → 點{what} ({x}, {y})")

    # -- 關卡 --
    def _step_level(self, img: np.ndarray, info, region: V.Region) -> Status:
        board = info.board
        now = self._now()

        if self._after_overlay:
            # 過關畫面之後又看到關卡＝新的一關
            self._after_overlay = False
            self._reset_level()
            self._ov_acted_at = 0.0
            self._ov_retry_label = None
            self._ov_counted = False
        common = dict(screen="level", board=board, image=img)
        layout = board.layout_signature()
        if self._layout is not None and not V.layouts_match(layout, self._layout):
            # 管子排列跟這一關不一樣：可能真的換關（或視窗大小變了），也可能只是光效讓某根管子暫時偵測不到
            # （9/20 實機：紅寶石湊滿的火焰讓那根管子消失，引擎當成換關、清掉記憶，拿缺一根管子的殘缺盤面
            # 當新的一關 → 藍罐還鎖著、看起來無解 → 停手）。所以不立刻承認：新排列要穩定撐過 layout_settle
            # 秒才算換關，期間不規劃、不點擊；排列回到原樣就當什麼都沒發生。
            if self._layout_cand is None or not V.layouts_match(layout, self._layout_cand):
                self._layout_cand, self._layout_cand_since = layout, now
            if now - self._layout_cand_since < self.cfg.layout_settle:
                self._last_sig, self._same = None, 0
                return self._status("settling", "管子排列跟剛才不一樣（動畫或光效？），等一下再看…", **common)
            self._reset_level()          # 撐夠久了：真的換關
        else:
            self._layout_cand = None
        self._layout = layout            # 排列一致時跟著慢慢漂移（動畫的幾像素抖動不算變）

        # ---- 盤面有疑點 ----
        if not board.ok:
            msg = "；".join(board.problems[:3]) or "盤面有疑點"
            return self._unreliable(img, now, common, "problem",
                                    f"讀不準，等一下再看：{msg}", f"盤面持續讀不準（{msg}）")

        # ---- 穩定確認（連續幾次讀到同一個盤面才採信）----
        sig = board.signature()
        if sig == self._last_sig:
            self._same += 1
        else:
            self._last_sig, self._same = sig, 1
        if self._same < self.cfg.stable_reads:
            return self._status("settling", "畫面變動中…", **common)

        kinds = [t.kind for t in board.tubes]
        cells = [list(t.cells) for t in board.tubes]
        pz = S.Puzzle(kinds=kinds, cells=cells, cap=board.cap, partial=self.cfg.partial)

        # ---- 各色數量要湊得成 4 的倍數 ----
        # 橫幅（「你完成了一個寶匣歸類！」）、光環會短暫蓋住最上排最上面的寶石，讀起來就是少一顆、顏色對不上。
        # 這是「畫面暫時不可信」，不是「無解」：等它消失（逾時才停手）。而且要先過這關才可以當寶石總數的基準，
        # 不然會把被蓋住的少算數字當成基準。（9/20 實機：1-6、1-7 都在這裡誤判無解而停手）
        cons = S.check_consistency(pz)
        if not cons.ok:
            return self._unreliable(img, now, common, "inconsistent",
                                    f"{cons.message}——可能被橫幅或光效蓋住，等一下再看",
                                    f"顏色數量一直對不上（{cons.message}）")

        # ---- 寶石總數要守恆（動畫中途、被橫幅遮住都會讓數量對不上）----
        gems = sum(len(t.cells) for t in board.tubes)
        if self._total_gems is None or gems > self._total_gems:
            # 這一關第一個穩定盤面當基準；寶石不會憑空變多，讀到更多（而且上面顏色數量湊得齊）
            # ＝先前的基準是在被蓋住時量的、少算了，往上修
            self._total_gems = gems
        elif gems != self._total_gems:
            return self._unreliable(img, now, common, "gemcount",
                                    f"寶石數量對不上（應為 {self._total_gems}，讀到 {gems}），可能在動畫中…",
                                    f"寶石總數一直對不上（應為 {self._total_gems}，讀到 {gems}）")
        self._problem_since = None

        # ---- 驗收上一步 ----
        if self._pending is not None:
            res = self._check_pending(board, cells, kinds, sig, now, region, img)
            if res is not None:
                return res

        if pz.is_solved():
            self.palette.commit()
            return self._status("solved", "這關的寶石都歸位了，等待過關畫面…", **common)

        plan = self._planner.plan(pz, avoid=tuple(self._banned))
        self.palette.commit()          # 盤面通過所有檢查、連續穩定 → 新顏色可以轉正
        if not plan.ok or plan.first is None:
            if self.autoplay:
                # 看似無解不一定真的無解：合成的光效/動畫中途讀到的盤面常常是殘缺的（少一根管子、罐子還沒解鎖）。
                # 先等 problem_timeout 秒、每次重新確認重新規劃；一直無解才停手（並存下畫面）。
                if self._nosol_since is None:
                    self._nosol_since = now
                if now - self._nosol_since <= self.cfg.problem_timeout:
                    self._last_sig, self._same = None, 0
                    return self._status("settling", f"{plan.message}——先等等看是不是動畫中途的畫面…", plan=plan, **common)
                self.stop_autoplay()
                path = self._dump(img, "nosolution")
                return self._status("stuck", f"{plan.message}。自動操控已停止。"
                                    + self._dbg(path),
                                    plan=plan, **common)
            return self._status("stuck", plan.message, plan=plan, **common)
        self._nosol_since = None

        move = plan.first
        common.update(move=move, plan=plan)
        if not self.autoplay:
            return self._status("ok", self._plan_text(board, plan), **common)
        return self._do_move(board, cells, kinds, sig, move, region, common)

    def _unreliable(self, img: np.ndarray, now: float, common: dict, tag: str,
                    wait_msg: str, stop_msg: str) -> Status:
        """這一幀不可信（讀不準、顏色或寶石數量對不上）：不動作、等下一幀；持續太久才停手並存畫面。"""
        self._last_sig, self._same = None, 0
        if self._problem_since is None:
            self._problem_since = now
        if self.autoplay and now - self._problem_since > self.cfg.problem_timeout:
            self.stop_autoplay()
            path = self._dump(img, tag)
            return self._status("stopped", f"{stop_msg}，自動操控已停止。" + self._dbg(path), **common)
        return self._status("settling", wait_msg, **common)

    def _plan_text(self, board: V.Board, plan: S.Plan) -> str:
        s, d = plan.first
        txt = f"建議：{board.tubes[s].label()} → {board.tubes[d].label()}（預計還要 {len(plan.moves)} 步"
        if plan.unknown_count:
            txt += f"；看不見 {plan.unknown_count} 顆，{plan.worlds_solved}/{plan.worlds_total} 種可能都解得出"
        return txt + "）"

    def _do_move(self, board: V.Board, cells, kinds, sig, move: S.Move, region: V.Region, common: dict,
                 attempts: int = 0) -> Status:
        if self._busy():
            return self._status("ok", "你正按著滑鼠，先讓你操作完…", **common)
        s, d = move
        pts = []
        for idx in (s, d):
            t = board.tubes[idx]
            pts.append((region.left + int(round(t.px)), region.top + int(round(t.py))))
        if self.guard is not None:
            for (x, y) in pts:
                blocked = self.guard(x, y)
                if blocked:
                    self.stop_autoplay()
                    return self._status("stopped", blocked, **common)
        try:
            self._click(pts[0][0], pts[0][1], hold=self.cfg.click_hold)
            self._sleep(self.cfg.select_delay)
            self._click(pts[1][0], pts[1][1], hold=self.cfg.click_hold)
        except C.InputError as e:
            self.stop_autoplay()
            return self._status("error", str(e), **common)
        except OSError as e:
            self.stop_autoplay()
            return self._status("error", f"送出點擊失敗：{e}", **common)
        expected = predict_cells(cells, kinds, move, board.cap, self.cfg.partial)
        self._pending = _Pending(move=move, before_sig=board.content_signature(), expected=expected,
                                 expected_kinds=list(kinds),
                                 t=self._now(), attempts=attempts)
        self._same = 0
        self._last_sig = None
        label = f"{board.tubes[s].label()} → {board.tubes[d].label()}"
        return self._status("ok", f"已點：{label}", acted=f"{label}（點 {pts[0]} → {pts[1]}）", **common)

    def _check_pending(self, board: V.Board, cells, kinds, sig, now: float, region: V.Region,
                       img: np.ndarray) -> Optional[Status]:
        """回傳非 None 代表這一輪已經有結果要顯示（還在等 / 重試 / 停手）；None 代表驗收完畢可以繼續規劃。"""
        p = self._pending
        common = dict(screen="level", board=board, image=img)
        elapsed = now - p.t
        if elapsed < self.cfg.move_settle:
            return self._status("settling", "等待搬移動畫…", **common)
        if board.content_signature() == p.before_sig:      # 只比內容：位置抖動不算「盤面變了」
            if elapsed < self.cfg.move_timeout:
                return self._status("settling", "等待畫面更新…", **common)
            # 這一步沒生效
            if p.attempts < self.cfg.max_retries:
                move = p.move
                s, d = move
                self._pending = None
                common["move"] = move
                return self._do_move(board, cells, kinds, sig, move, region, common, attempts=p.attempts + 1)
            self._banned.add(p.move)
            self._pending = None
            self._consec_bans += 1
            s, d = p.move
            note = f"{board.tubes[s].label()} → {board.tubes[d].label()} 點了 {p.attempts + 1} 次都沒反應，改走別的路"
            if self._consec_bans >= 3:
                self.stop_autoplay()
                path = self._dump(img, "noeffect")
                return self._status("stopped", f"連續 {self._consec_bans} 步點了都沒反應，自動操控已停止——"
                                    f"請確認模擬器在最上層、沒被擋住，或遊戲的操作方式跟預期不同。"
                                    + self._dbg(path), **common)
            return self._status("settling", note, acted=note, **common)
        # 畫面變了：黑名單只針對「當時那個盤面」，盤面一變就作廢（同一步之後可能就合法了）
        self._pending = None
        self._banned.clear()
        self._consec_bans = 0
        self.moves_done += 1
        self._level_moves += 1
        if p.expected is not None and compatible(cells, kinds, p.expected, p.expected_kinds):
            return None
        note = "盤面變化跟預期不同（可能多顯現了寶石、或動畫中途），重新規劃"
        self._note = note
        return None


# ---------------------------------------------------------------- 背景執行緒

class Worker(threading.Thread):
    """在背景跑 Engine.step()，把結果丟進 queue。辨識與截圖放在 UI 執行緒會讓視窗卡住。"""

    def __init__(self, engine: Engine, lock: threading.Lock, out: "queue.Queue[Status]") -> None:
        super().__init__(daemon=True)
        self.engine = engine
        self.lock = lock
        self.out = out
        self._stop_evt = threading.Event()
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
        self._stop_evt.set()
        self._resume.set()

    def run(self) -> None:
        while not self._stop_evt.is_set():
            self._resume.wait()
            if self._stop_evt.is_set():
                break
            with self.lock:
                try:
                    status = self.engine.step()
                except Exception as e:    # 背景執行緒炸掉就整個沒反應，一律轉成畫面上的訊息
                    self.engine.stop_autoplay()
                    status = Status("error", f"內部錯誤：{type(e).__name__}: {e}")
                poll = self.engine.cfg.poll_ms
            self.out.put(status)
            time.sleep(max(0.05, poll / 1000.0))


__all__ = [
    "APP_DIR", "CONFIG_PATH", "PALETTE_PATH", "DEBUG_DIR",
    "Config", "RegionTracker", "Status", "Engine", "Worker", "predict_cells", "compatible",
]
