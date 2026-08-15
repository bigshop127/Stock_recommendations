"""mobile_main.py 的驗證。

MobileEngine 建構子會直接建立真的 RishGrabber／RishController，測試裡用
monkeypatch 換成假的（FakeGrabber／FakeController），這樣不用真的裝
Termux/Shizuku、也不用真機就能測 step() 的節奏邏輯本身。

    python test_mobile.py
"""

from __future__ import annotations

import sys
from typing import List, Optional

import numpy as np

import mobile_main as M
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


ROWS, COLS = 4, 4
CELL = 30
REGION = V.Region(0, 0, CELL * COLS, CELL * ROWS)


def make_board_image(cells: List[int]) -> np.ndarray:
    """畫一張跟 cells 對應的假盤面：0 是純色空格，其餘每個數字各自一種花紋。

    不能像空格一樣純色平塗——vision.normalize() 會把每張縮圖各自減掉自己的
    色版平均值（用來去掉整體亮度／色偏），純色格子減掉平均值後全部變成
    (0,0,0)，不管原本填的是什麼顏色，會讓所有「水果」格跟空格互相認不出來。
    真實水果圖示本來就有花紋所以沒這問題，這裡用跟座標相關的花紋來模擬。
    """
    img = np.zeros((REGION.height, REGION.width, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:CELL, 0:CELL]
    for i, v in enumerate(cells):
        r, c = divmod(i, COLS)
        y0, x0 = r * CELL, c * CELL
        if v == 0:
            block = np.full((CELL, CELL, 3), (20, 20, 20), dtype=np.uint8)
        else:
            ch0 = (xx * (v * 7 + 3) + yy * (v * 5 + 11)) % 256
            ch1 = (255 - ch0) % 256
            ch2 = (ch0 // 2 + v * 13) % 256
            block = np.stack([ch0, ch1, ch2], axis=-1).astype(np.uint8)
        img[y0:y0 + CELL, x0:x0 + CELL] = block
    return img


class FakeGrabber:
    def __init__(self, frames: List[np.ndarray]) -> None:
        self.frames = list(frames)
        self.calls = 0

    def grab(self, region):
        self.calls += 1
        return self.frames[min(self.calls - 1, len(self.frames) - 1)]


class FakeController:
    def __init__(self, fail: bool = False) -> None:
        self.plays: List[tuple] = []
        self.fail = fail

    def play(self, region, move):
        if self.fail:
            raise R.InputError("模擬送滑動失敗")
        self.plays.append((region, move))


def learned_engine(cells: List[int], labels: Optional[List[int]] = None) -> M.MobileEngine:
    """建一個已經學過 cells 對應樣板的 MobileEngine，並用假的 grabber/controller 換掉。"""
    cfg = M.MobileConfig(region=REGION.to_dict(), rows=ROWS, cols=COLS,
                         time_budget=0.05, move_interval=0.0, retry_after=0.0,
                         animation_grace=0.0, max_retries=2)
    eng = M.MobileEngine(cfg)
    img = make_board_image(cells)
    grid = V.Grid(ROWS, COLS, cfg.inset)
    for i, crop in enumerate(grid.crops(img)):
        label = cells[i] if labels is None else labels[i]
        # 連 0（空格）也要教，不然只要樣板庫非空，沒教過的空格就會被判定「認不得」。
        if label is not None:
            eng.db.add(label, V.raw_feature(crop))
    return eng, img


def main():
    """把 M.TEMPLATES_PATH 換成暫存路徑再跑全部測試——不然 MobileEngine 建構子
    會直接讀（_learn_from_badges 還會寫回）使用者手機上真正在用的 templates.json，
    測試會被裡面已經練出來的上千張真樣板汙染，學新水果那段甚至會把測試用的
    假樣板存回真正的檔案，汙染使用者的辨識庫。
    """
    import os
    import tempfile

    real_templates_path = M.TEMPLATES_PATH
    with tempfile.TemporaryDirectory() as td:
        M.TEMPLATES_PATH = os.path.join(td, "templates.json")
        try:
            return _run_tests()
        finally:
            M.TEMPLATES_PATH = real_templates_path


def _run_tests():
    print("1) MobileConfig.load()：只吃自己認得的欄位，PC 專用欄位靜靜略過")
    import json
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "config.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "region": {"left": 1, "top": 2, "width": 300, "height": 300},
                "rows": 4, "cols": 4, "time_budget": 0.4,
                "capture_source": "adb", "window_anchor": {"title": "x"}, "adb_serial": "ABC",
            }, f)
        real_path = M.CONFIG_PATH
        M.CONFIG_PATH = path
        try:
            cfg = M.MobileConfig.load()
        finally:
            M.CONFIG_PATH = real_path
        check("讀到 region", cfg.region == {"left": 1, "top": 2, "width": 300, "height": 300})
        check("讀到 time_budget", cfg.time_budget == 0.4)
        check("PC 專用欄位（capture_source 等）沒有害它炸掉", not hasattr(cfg, "capture_source"))

    print("2) 沒校準過：step() 只給一句話，不會嘗試抓畫面")
    cfg = M.MobileConfig()
    eng = M.MobileEngine(cfg)
    check("region 是 None", eng.region is None)
    check("提示要先校準", "校準" in eng.step())

    print("3) 穩定確認：同一個盤面要連續讀到兩次才會真的動手")
    cells = [0] * 16
    cells[15] = 1  # 右下角一顆 1
    eng, img = learned_engine(cells)
    fg = FakeGrabber([img, img, img])
    fc = FakeController()
    eng.grabber, eng.controller = fg, fc
    msg1 = eng.step()
    check("第一次讀到，還在確認中，不會動手", msg1 is None and not fc.plays)
    msg2 = eng.step()
    check("第二次讀到一樣的盤面，真的動手了", msg2 is not None and len(fc.plays) == 1, f"{msg2}")

    print("4) 送滑動失敗：要把錯誤講清楚，不要整個炸掉")
    eng2, img2 = learned_engine(cells)
    eng2.grabber = FakeGrabber([img2, img2])
    eng2.controller = FakeController(fail=True)
    eng2.step()
    msg = eng2.step()
    check("送滑動失敗的訊息有透出來", msg is not None and "送出操作失敗" in msg, f"{msg}")

    print("5) 盤面卡住不動：重試到上限後放棄，不是無限空滑")
    eng3, img3 = learned_engine(cells)
    fc3 = FakeController()  # play() 什麼都不做，盤面不會真的變
    eng3.grabber = FakeGrabber([img3] * 20)
    eng3.controller = fc3
    stopped_msg = None
    for _ in range(20):
        m = eng3.step()
        if m and "已自動停止" in m:
            stopped_msg = m
            break
    check("重試超過上限會停手講清楚，不會一直空滑", stopped_msg is not None, f"{stopped_msg}")
    check("停手前確實嘗試滑動了幾次（原始一次＋重試），不是連一次都沒滑就放棄",
          len(fc3.plays) >= 1, f"{len(fc3.plays)} 次")

    print("6) 靠格子上的數字認出新水果：學起來會回報訊息")
    cells6 = [0] * 16
    cells6[0] = 9
    cfg6 = M.MobileConfig(region=REGION.to_dict(), rows=ROWS, cols=COLS,
                          time_budget=0.05, move_interval=0.0, animation_grace=0.0)
    eng6 = M.MobileEngine(cfg6)
    img6 = make_board_image(cells6)

    # 直接組一個帶 badge_indices 的 Reading，模擬 Recognizer.read 判斷靠數字認出格子 0
    grid6 = V.Grid(ROWS, COLS, cfg6.inset)
    crops6 = grid6.crops(img6)
    matches6 = [V.Match(cells6[i] or None, 0.0, 99.0, "", "badge" if i == 0 else "")
               for i in range(16)]
    reading6 = V.Reading(cells6, matches6, crops6, True, [], [0])
    added_before = len(eng6.db)
    note = eng6._learn_from_badges(reading6)
    check("學到新樣板", len(eng6.db) == added_before + 1)
    check("有回報學到幾號", "9" in note, note)

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
