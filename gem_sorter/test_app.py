"""面板測試：Tk 視窗建立後立刻隱藏（GEMSORT_HEADLESS），不會出現在桌面、不搶焦點、不送真點擊。

驗證：面板能建起來、預覽圖畫得出來、各種狀態顯示對、連闖上限存得進設定檔、
沒框範圍就不能開自動、關閉時背景執行緒有收乾淨。
資料夾導到暫存夾，不動使用者真正的 config / palette。
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import tkinter as tk

_TMP = tempfile.mkdtemp(prefix="gemsort_app_test_")
os.environ["GEMSORT_DATA_DIR"] = _TMP
os.environ["GEMSORT_HEADLESS"] = "1"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import app as A  # noqa: E402
import engine as E  # noqa: E402
import solver as S  # noqa: E402
import vision as V  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata")

_passed = 0
_failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS {name}")
    else:
        _failed += 1
        print(f"  FAIL {name}  {detail}")


def load(name: str) -> np.ndarray:
    return np.array(Image.open(os.path.join(DATA, name)).convert("RGB"))


def level_status(app: A.AssistApp, name: str) -> E.Status:
    img = load(name)
    board = V.build_board(img, app.engine.palette)
    pz = S.Puzzle(kinds=[t.kind for t in board.tubes], cells=[list(t.cells) for t in board.tubes])
    plan = S.Planner().plan(pz)
    return E.Status("ok", "建議：第1排第2根 → 第1排第1根（預計還要 27 步）", screen="level", board=board,
                    move=plan.first, plan=plan, image=img, palette=app.engine.palette)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("[1] 面板建得起來、且不會出現在桌面")
    app = A.AssistApp()
    app.update()
    check("視窗是隱藏狀態（測試模式）", app.state() == "withdrawn", app.state())
    check("預設自動操控是關的", app.engine.autoplay is False)
    check("背景偵測執行緒有在跑", app.worker.is_alive())
    check("沒框範圍時標題是「尚未框選範圍」", app.state_name.cget("text") == "尚未框選範圍", app.state_name.cget("text"))

    print("[2] 各種狀態的顯示")
    # 背景執行緒會不斷丟「等待中」進佇列，蓋掉測試餵進去的狀態 → 先暫停並清空佇列
    app.worker.pause()
    time.sleep(0.5)
    while not app.queue.empty():
        app.queue.get_nowait()
    st = level_status(app, "lvl2-1_start.png")
    app._render(st)
    check("關卡中：標題「關卡中」", app.state_name.cget("text") == "關卡中", app.state_name.cget("text"))
    check("關卡中：顯示建議的這一步", "建議" in app.state_hint.cget("text"))
    check("預覽圖畫出來了（PhotoImage 不為空）", app._photo is not None)
    check("預覽圖尺寸 = 預覽框大小", app._photo.width() == A.PREVIEW_W and app._photo.height() == A.PREVIEW_H,
          f"{app._photo.width()}x{app._photo.height()}")

    for kind, screen, text, shown in (
            ("solved", "level", "這關完成了", "這關完成了"),
            ("overlay", "reward", "獎勵畫面", "獎勵畫面"),
            ("overlay", "result", "結算畫面", "結算畫面"),
            ("stuck", "level", "找不到解", "找不到解"),
            ("unknown", "unknown", "認不得這個畫面", "認不得這個畫面"),
            ("stopped", "", "已停止", "已停止"),
            ("error", "", "出錯了", "出錯了")):
        app._flash_until = 0
        app._render(E.Status(kind, "測試訊息", screen=screen, palette=app.engine.palette))
        check(f"狀態 {kind}/{screen or '-'} → 標題「{shown}」", app.state_name.cget("text") == shown,
              app.state_name.cget("text"))

    app._flash_until = 0
    app._render(E.Status("settling", "讀不準，等一下再看", screen="level", palette=app.engine.palette))
    check("讀不準時顯示「畫面變動中…」", "畫面變動中" in app.state_name.cget("text"))

    app._render(E.Status("ok", "已點：第1排第1根 → 第2排第3根", screen="level",
                         acted="第1排第1根 → 第2排第3根（點 (10, 20) → (30, 40)）", palette=app.engine.palette))
    check("剛執行的動作進「最近動作」", "第1排第1根" in app.log_contents())

    print("[2b] 「最近動作」：可捲動、自動捲到最新、重複的停手訊息只記一次（9/20 實機：看不到最新、捲不動）")
    lg = app.log_text
    check("是可捲動的 Text（不是固定高度的 Label）", isinstance(lg, tk.Text))
    for i in range(40):
        app._push_log(f"動作 {i}")
    app.update_idletasks()
    top, bottom = lg.yview()
    check("訊息很多時自動捲到最底＝看得到最新一則", bottom >= 0.999 and top > 0.0, f"yview={lg.yview()}")
    check("最新一則在內容裡", app.log_contents().splitlines()[-1].endswith("動作 39"))
    lg.yview_moveto(0.0)
    app._push_log("往上翻時進來的新訊息")
    app.update_idletasks()
    check("使用者往上翻舊訊息時，新訊息不會把畫面硬拉走", lg.yview()[0] == 0.0, f"yview={lg.yview()}")
    lg.yview_moveto(1.0)
    n0 = app.log_contents().count("同一句停手訊息")
    for _ in range(50):
        app._render(E.Status("stopped", "同一句停手訊息", palette=app.engine.palette))
    check("同一句停手訊息連續 50 輪只記 1 則", app.log_contents().count("同一句停手訊息") == n0 + 1,
          f"記了 {app.log_contents().count('同一句停手訊息') - n0} 則")
    app._render(E.Status("ok", "恢復", screen="level", palette=app.engine.palette))
    app._render(E.Status("stopped", "同一句停手訊息", palette=app.engine.palette))
    check("狀態恢復後又出現同一句 → 算新事件再記一次", app.log_contents().count("同一句停手訊息") == n0 + 2)
    for i in range(A.LOG_KEEP + 50):
        app._push_log(f"灌水 {i}")
    check(f"最多保留 {A.LOG_KEEP} 則、舊的自動丟掉", len(app.log_contents().splitlines()) == A.LOG_KEEP,
          str(len(app.log_contents().splitlines())))

    print("[3] 設定與防呆")
    app.max_var.set("5")
    app._on_max_levels()
    check("連闖上限存進設定檔", app.cfg.max_levels == 5 and E.Config.load().max_levels == 5)
    app.max_var.set("abc")
    app._on_max_levels()
    check("亂填 → 退回原值、不崩", app.max_var.get() == "5")
    app.max_var.set("0")
    app._on_max_levels()
    check("0 ＝不限", app.cfg.max_levels == 0)

    app.toggle_autoplay()
    check("沒框範圍就不能開自動", app.engine.autoplay is False)
    check("並提示要先框選", "框選" in app.status.cget("text"), app.status.cget("text"))

    print("[4] 關閉時背景執行緒收乾淨")
    worker = app.worker
    app._on_close()
    check("背景執行緒已結束", not worker.is_alive())
    check("除了主執行緒沒有殘留的非 daemon 執行緒",
          all(t.daemon or t is threading.main_thread() for t in threading.enumerate()))

    print(f"\n{_passed} 項通過，{_failed} 項失敗")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
