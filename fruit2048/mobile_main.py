"""水果 2048 輔助器 —— 手機本地版主迴圈。

整個「擷取→辨識→求解→滑動」都在手機的 Termux 裡執行，不用再透過 PC 的 adb
跨 USB 傳輸——延遲從 400~460ms/幀降到本機等級。screencap／滑動改叫 Shizuku
給的本機殼層（見 rish.py），vision.py／solver.py 完全照搬，一行都沒改。

跟 PC 版 app.py 的差異：
  * 沒有 tkinter 視窗（Termux 沒有桌面環境），純文字輸出狀態到終端機。
  * 沒有「視窗追蹤」——手機沒有視窗可以搬動，擷取範圍永遠是同一支手機螢幕。
  * 沒有「緊急停止鍵」（沒有全域鍵盤監聽），改成 Ctrl+C 直接中斷。
  * 沒有校準／標記水果的 UI。這兩件事沿用 PC 版 app.py 做（螢幕來源選「手機
    （USB 接 adb）」），做完把 config.json、templates.json 複製到手機這邊
    跟這支程式同一個資料夾即可直接接著跑——座標本來就是「手機螢幕像素」，
    跟是從 PC 端 adb 還是手機本地 rish 擷取無關，不用重新校準。

    python mobile_main.py
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import List, Optional

import solver as S
import vision as V
from rish import InputError, RishError, RishController, RishGrabber

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
TEMPLATES_PATH = os.path.join(APP_DIR, "templates.json")


@dataclass
class MobileConfig:
    """PC 版 Config 的一個子集——只留手機自動玩用得到的欄位。config.json 是
    同一份檔案共用，多出來的欄位（capture_source、window_anchor…）直接忽略。
    """

    region: Optional[dict] = None
    rows: int = 4
    cols: int = 4
    inset: float = 0.10
    tolerance: float = V.DEFAULT_TOLERANCE
    min_margin: float = V.DEFAULT_MIN_MARGIN
    time_budget: float = 0.30
    poll_ms: int = 50
    spawn: List[List[float]] = field(default_factory=lambda: [[1, 1.0]])
    swipe_ms: int = 140
    swipe_fraction: float = 0.35
    move_interval: float = 0.20
    retry_after: float = 1.6
    max_retries: int = 3
    animation_grace: float = 1.2

    @classmethod
    def load(cls) -> "MobileConfig":
        cfg = cls()
        if not os.path.exists(CONFIG_PATH):
            return cfg
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return cfg
        for k, v in data.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        return cfg


class MobileEngine:
    """Engine.step() 的精簡版：拿掉視窗追蹤／緊急停止鍵／UI 狀態物件，
    邏輯（穩定確認、重試上限、節奏控制）跟 PC 版對齊。
    """

    def __init__(self, cfg: MobileConfig) -> None:
        self.cfg = cfg
        self.region = V.Region.from_dict(cfg.region) if cfg.region else None
        self.db = V.TemplateDB.load(TEMPLATES_PATH, cfg.tolerance, cfg.min_margin)
        self.grid = V.Grid(cfg.rows, cfg.cols, cfg.inset)
        self.rec = V.Recognizer(self.grid, self.db)
        self.solver = S.Solver(spawn=[tuple(x) for x in cfg.spawn])
        self.grabber = RishGrabber()
        self.controller = RishController(duration=cfg.swipe_ms / 1000.0, fraction=cfg.swipe_fraction)

        self._confirming: Optional[List[int]] = None
        self._solved_board: Optional[int] = None
        self._result: Optional[S.Result] = None
        self._played_board: Optional[int] = None
        self._played_at = 0.0
        self._retry = 0
        self.moves_played = 0

    def step(self) -> str:
        """跑一輪，回傳這一輪要印出來的狀態字串；回傳 None 代表沒新鮮事不用印。"""
        if self.region is None:
            return "還沒校準——回 PC 版 app.py 校準（畫面來源選「手機」），再把 config.json 複製過來。"

        try:
            img = self.grabber.grab(self.region)
        except (ValueError, RishError) as e:
            return f"抓不到畫面：{e}"

        reading = self.rec.read(img)

        if not reading.ok:
            self._confirming = None
            if time.monotonic() - self._played_at < self.cfg.animation_grace:
                return None  # 剛滑完的動畫期間，安靜等，不要嚇人
            if len(self.db) == 0:
                return "樣板庫是空的——回 PC 版標記過水果，再把 templates.json 複製過來。"
            if reading.looks_misaligned:
                return f"{len(reading.unknown_indices)} 格認不得，畫面可能歪了或校準漂掉了。"
            return f"有 {len(reading.unknown_indices)} 格沒見過（新水果？）——這支手機端不會自己學，回 PC 版標記後把 templates.json 複製過來。"

        cells = reading.board_cells

        if cells != self._confirming:
            self._confirming = cells
            return None  # 等下一輪讀到一樣的才算數

        learned = self._learn_from_badges(reading)

        board = S.from_list(cells)
        if board != self._solved_board or self._result is None:
            self._solved_board = board
            self._result = self.solver.solve(board, self.cfg.time_budget)

        if self._result.best is None:
            return f"四個方向都動不了——這局結束了，共走 {self.moves_played} 步。"

        played = self._play(board, self._result.best)
        if played:
            return played
        return learned or None

    def _learn_from_badges(self, reading: V.Reading) -> str:
        if not reading.badge_indices:
            return ""
        crops = [reading.crops[i] for i in reading.badge_indices]
        labels = [reading.cells[i] for i in reading.badge_indices]
        added = self.rec.learn(crops, labels)
        if not added:
            return ""
        self.db.save(TEMPLATES_PATH)
        names = "、".join(str(n) for n in sorted({int(l) for l in labels if l}))
        return f"看格子上的數字認出 {names} 號水果，已經記起來了"

    def _play(self, board: int, move: int) -> Optional[str]:
        now = time.monotonic()
        if now - self._played_at < self.cfg.move_interval:
            return None  # 節奏控制，還沒到時間

        if board == self._played_board:
            if now - self._played_at < self.cfg.retry_after:
                return None
            self._retry += 1
            if self._retry > self.cfg.max_retries:
                return (f"連續滑了 {self.cfg.max_retries + 1} 次盤面都沒變化，已自動停止。"
                        f"請確認 Shizuku 還在跑、遊戲在最上層。")
        else:
            self._retry = 0

        try:
            self.controller.play(self.region, move)
        except (InputError, RishError) as e:
            return f"送出操作失敗：{e}"

        self._played_board = board
        self._played_at = time.monotonic()
        self.moves_played += 1
        self._confirming = None
        return f"第 {self.moves_played} 步：往 {S.MOVE_NAME[move]} 滑"


def main() -> None:
    cfg = MobileConfig.load()
    engine = MobileEngine(cfg)

    if engine.region is None:
        print(engine.step())
        return

    print(f"開始自動玩：{cfg.rows}x{cfg.cols}，範圍 {engine.region}。Ctrl+C 停止。")
    try:
        while True:
            msg = engine.step()
            if msg:
                print(msg)
            if engine._result is not None and engine._result.best is None:
                break
            if msg and msg.startswith("連續滑了"):
                break
            time.sleep(max(0.05, cfg.poll_ms / 1000.0))
    except KeyboardInterrupt:
        print(f"\n手動停止，共走 {engine.moves_played} 步。")


if __name__ == "__main__":
    main()
