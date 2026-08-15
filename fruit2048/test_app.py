"""app.py 的端到端驗證。

把螢幕擷取換成「永遠回傳那張真實遊戲截圖」的假來源，就能在沒有模擬器的情況下
把「擷取 → 辨識 → 求解 → 顯示」整條路走完，也能檢查各種狀態下 UI 不會炸掉。

    python test_app.py
"""

import os
import shutil
import sys
import tempfile
import time

import numpy as np
from PIL import Image

# 中文版 Windows 的主控台預設是 cp950，印不出結尾那個 ✅/❌ 就會整支噴
# UnicodeEncodeError —— 測試明明全過，看起來卻像壞了。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 測資圖放在 repo 裡。以前指向 Claude 的暫存圖片快取，那個檔案每傳一張新圖
# 就會被覆蓋掉 —— 2026-08-15 真的被蓋掉一次，四個套件一起紅。
SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "board.png")
# 盤面範圍是獨立量出來的（格縫的亮度谷底做最小平方），不是拿 autofit 的輸出當真值，
# 不然「測 autofit 準不準」就變成自己考自己。細格搜尋得到 x 起點 41.0 格距 186.60、
# y 起點 35.0 格距 187.60。
TRUE_REGION = (41, 35, 746, 750)
TRUE_BOARD = [0, 0, 0, 1, 0, 1, 0, 2, 0, 2, 1, 2, 1, 4, 7, 9]

_failures = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)
    return ok


def main():
    if not os.path.exists(SHOT):
        print(f"找不到測試盤面圖：{SHOT}\n它跟程式一起進版控，用 `git checkout` 就能還原。")
        return 1

    sandbox = tempfile.mkdtemp(prefix="fruit2048_test_")
    try:
        import app as A
        import vision as V
        import solver as S

        # 別動到使用者真正的設定檔與樣板庫
        A.CONFIG_PATH = os.path.join(sandbox, "config.json")
        A.TEMPLATES_PATH = os.path.join(sandbox, "templates.json")

        full = np.asarray(Image.open(SHOT).convert("RGB"))
        l, t, w, h = TRUE_REGION
        board_img = full[t:t + h, l:l + w]

        class FakeGrabber:
            """假的擷取來源：不管要哪一塊，都回傳那張截圖裡的盤面。"""

            backend = "fake"
            calls = 0

            def virtual_screen(self):
                return V.Region(0, 0, full.shape[1], full.shape[0])

            def grab(self, region):
                FakeGrabber.calls += 1
                return board_img.copy()

        print("1) 設定檔存讀")
        cfg = A.Config()
        cfg.region = {"left": l, "top": t, "width": w, "height": h}
        cfg.time_budget = 0.25
        cfg.save()
        check("寫得出檔案", os.path.exists(A.CONFIG_PATH))
        again = A.Config.load()
        check("讀回來一樣", again.region == cfg.region and again.time_budget == 0.25)
        check("壞檔案 → 回預設值而不是炸掉",
              (open(A.CONFIG_PATH, "w").write("{ not json"), A.Config.load().rows)[1] == 4)
        cfg.save()

        print("2) 沒校準時的狀態")
        blank = A.Config()
        eng_blank = A.Engine(blank)
        eng_blank.grabber = FakeGrabber()
        st = eng_blank.step()
        check("回報 waiting", st.kind == "waiting", st.message)

        print("3) 樣板庫是空的時候")
        eng = A.Engine(A.Config.load())
        eng.grabber = FakeGrabber()
        st = eng.step()
        check("回報 unknown", st.kind == "unknown", st.message)
        check("附帶 reading 讓 UI 可以開標記視窗", st.reading is not None)

        print("4) 標記之後跑完整條管線")
        reading = eng.rec.read(eng.snapshot())
        added = eng.rec.learn(reading.crops, TRUE_BOARD)
        eng.db.save(A.TEMPLATES_PATH)
        eng.rebuild()
        print(f"      學到 {added} 張樣板")

        st1 = eng.step()
        check("第一次讀到 → settling（等待確認）", st1.kind == "settling", st1.kind)
        st2 = eng.step()
        check("第二次讀到同樣盤面 → ok", st2.kind == "ok", f"{st2.kind}: {st2.message}")
        check("辨識出的盤面正確", st2.cells == TRUE_BOARD, f"{st2.cells}")
        if st2.result:
            best = st2.result.best
            print(f"      建議 {S.MOVE_ARROW[best]}{S.MOVE_NAME[best]}"
                  f"（深度 {st2.result.depth}, {st2.result.elapsed * 1000:.0f}ms）")
            check("建議方向合法", best is not None and
                  S.apply_move(S.from_list(TRUE_BOARD), best) != S.from_list(TRUE_BOARD))
            check("四個方向都有評分", len(st2.result.scores) == 4)

        print("5) 同一個盤面不重算")
        before = FakeGrabber.calls
        t0 = __import__("time").perf_counter()
        st3 = eng.step()
        elapsed = __import__("time").perf_counter() - t0
        check("有再抓一次畫面", FakeGrabber.calls > before)
        check("但沒有重新求解（快很多）", elapsed < 0.05, f"{elapsed * 1000:.1f}ms")
        check("結果沿用", st3.result is st2.result)

        print("6) 樣板庫存檔之後，新的 Engine 直接可用")
        eng2 = A.Engine(A.Config.load())
        eng2.grabber = FakeGrabber()
        eng2.step()
        st = eng2.step()
        check("不用重新標記就能用", st.kind == "ok", f"{st.kind}: {st.message}")

        print("7) 校準跑掉時的回報")
        class DriftGrabber(FakeGrabber):
            def grab(self, region):
                return full[t + 7:t + 7 + h, l + 7:l + 7 + w].copy()

        eng.grabber = DriftGrabber()
        st = eng.step()
        check("回報 misaligned", st.kind == "misaligned", f"{st.kind}: {st.message}")
        check("訊息有提到重新吸附", "重新吸附" in st.message)
        check("有帶盤面回去，UI 才畫得出哪幾格認不得", st.cells is not None)
        eng.grabber = FakeGrabber()

        print("8) 遊戲結束的回報")
        dead = A.Engine(A.Config.load())
        dead.grabber = FakeGrabber()
        dead._confirming = [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1]

        class DeadRec:
            def read(self, img):
                cells = [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1]
                return V.Reading(cells, [], [], True, [])

        dead.rec = DeadRec()
        st = dead.step()
        check("回報 nomove", st.kind == "nomove", f"{st.kind}: {st.message}")

        print("9) 擷取失敗不會讓背景執行緒死掉")
        class BrokenGrabber(FakeGrabber):
            def grab(self, region):
                raise OSError("模擬器關掉了")

        eng.grabber = BrokenGrabber()
        st = eng.step()
        check("轉成 error 狀態", st.kind == "error", f"{st.kind}: {st.message}")
        eng.grabber = FakeGrabber()
        eng.step()
        check("恢復之後能繼續", eng.step().kind == "ok")

        print("10) 看格子上的號碼自動學會新水果")
        # 把一個空格換成商店圖裡的 11 號水果：樣板庫沒見過它，但它的號碼就印在
        # 格子上。讀得出來就當場採用，不必停下來叫使用者標一輪。
        NEW = 11
        boxes = eng.grid.cell_boxes(w, h)
        tile = np.asarray(Image.open(os.path.join(
            os.path.dirname(SHOT), "shop_11_12.png")).convert("RGB"))[30:195, 25:190]
        x0, y0, x1, y1 = boxes[8]          # 8 本來是空格，換掉不會蓋到別的水果
        grown = board_img.copy()
        grown[y0:y1, x0:x1] = np.asarray(
            Image.fromarray(tile).resize((x1 - x0, y1 - y0), Image.BILINEAR))

        class GrowGrabber(FakeGrabber):
            def grab(self, region):
                return grown.copy()

        eng.grabber = GrowGrabber()
        n_before = len(eng.db)
        eng.step()                        # 第一次讀到 → settling（等下一輪確認）
        st = eng.step()
        check("整盤讀得出來，不用開標記視窗", st.kind == "ok", f"{st.kind}: {st.message}")
        check("新水果認成 11 號", st.cells is not None and st.cells[8] == NEW, f"{st.cells}")
        check("樣板庫真的多一張", len(eng.db) == n_before + 1, f"{n_before} → {len(eng.db)}")
        check("訊息告訴使用者學到什麼", str(NEW) in st.message, st.message)
        check("順手存檔，下次開起來就有", NEW in V.TemplateDB.load(A.TEMPLATES_PATH).labels)
        check("學會之後不再重複報一次", not eng.step().message)
        eng.grabber = FakeGrabber()
        eng.db.remove_label(NEW)
        eng.db.save(A.TEMPLATES_PATH)

        print("11) 自動操控的狀態機（用假的 controller，不會真的動滑鼠）")

        class FakeController:
            def __init__(self):
                self.calls = []
                self.regions = []
                self.raise_next = None

            def play(self, region, move):
                if self.raise_next:
                    err, self.raise_next = self.raise_next, None
                    raise err
                self.calls.append(move)
                self.regions.append(region)

        class ScriptedRec:
            """繞過影像辨識，直接餵指定盤面，好單獨測自動操控的邏輯。"""

            def __init__(self, cells):
                self.cells = list(cells)
                self.readable = True

            def read(self, img):
                if self.readable:
                    return V.Reading(list(self.cells), [], [], True, [])
                return V.Reading([None] * 16, [], [], False, list(range(16)))

        def build_auto(**over):
            c = A.Config.load()
            c.move_interval = 0.0
            c.retry_after = 0.0
            c.max_retries = 2
            c.animation_grace = 0.0
            for k, v in over.items():
                setattr(c, k, v)
            e = A.Engine(c)
            e.grabber = FakeGrabber()
            e.rec = ScriptedRec(TRUE_BOARD)
            ctl = FakeController()
            e.controller = ctl
            return e, ctl

        def pump(e, n=2):
            last = None
            for _ in range(n):
                last = e.step()
            return last

        DEAD = [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1]

        e, ctl = build_auto()
        pump(e, 4)
        check("沒開自動時不會動手", ctl.calls == [], f"{ctl.calls}")

        e, ctl = build_auto()
        e.autoplay = True
        st = pump(e, 2)
        check("開了自動 → 走一步", len(ctl.calls) == 1, f"{ctl.calls}")
        check("走的方向就是建議方向", ctl.calls[0] == st.result.best if st.result else False)
        check("步數有計數", e.moves_played == 1, f"{e.moves_played}")

        e, ctl = build_auto(retry_after=99.0)
        e.autoplay = True
        pump(e, 2)
        pump(e, 6)     # 盤面完全沒變
        check("盤面沒變化時不會連續猛滑", len(ctl.calls) == 1, f"{ctl.calls}")

        e, ctl = build_auto()   # retry_after=0，模擬「滑了沒反應」
        e.autoplay = True
        st = None
        for _ in range(20):
            st = e.step()
            if st.kind == "stopped":
                break
        check("一直沒反應會自動停手", st.kind == "stopped", f"{st.kind}: {st.message}")
        check("停手後 autoplay 關閉", not e.autoplay)
        check("重試次數符合設定（1 次首發 + 2 次重試）", len(ctl.calls) == 3, f"{ctl.calls}")
        check("訊息說得出原因", "沒變化" in st.message, st.message)

        e, ctl = build_auto(retry_after=99.0)
        e.autoplay = True
        pump(e, 2)
        e.rec.cells = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 2]  # 盤面真的變了
        pump(e, 2)
        check("盤面變了就繼續下一步", len(ctl.calls) == 2, f"{ctl.calls}")
        check("重試計數有歸零", e._retry == 0)

        e, ctl = build_auto()
        e.autoplay = True
        ctl.raise_next = A.C.InputError("模擬送不進去")
        st = pump(e, 2)
        check("送不出去就停手並回報", st.kind == "error" and not e.autoplay,
              f"{st.kind}: {st.message}")

        e, ctl = build_auto()
        e.autoplay = True
        e.rec.cells = DEAD
        st = pump(e, 2)
        check("遊戲結束會停手", st.kind == "nomove" and not e.autoplay, f"{st.kind}")

        e, ctl = build_auto(animation_grace=5.0)
        e.autoplay = True
        pump(e, 2)                      # 走一步，記下時間
        e.rec.readable = False          # 動畫中讀不到完整盤面
        st = e.step()
        check("剛滑完讀不到 → 當成動畫，不嚇人", st.kind == "settling", f"{st.kind}: {st.message}")
        check("動畫期間不會關掉自動", e.autoplay)

        e, ctl = build_auto(animation_grace=0.0)
        e.autoplay = True
        pump(e, 2)
        e.rec.readable = False
        st = e.step()
        check("動畫期過了還讀不到 → 停手", not e.autoplay, f"{st.kind}: {st.message}")
        check("訊息有說自動操控停了", "自動操控先停著" in st.message, st.message)
        check("認不得停手是『可接回去』的", e.autoplay_resumable)
        for _ in range(5):
            e.step()        # 認不得的狀態每輪都會再叫一次 stop_autoplay
        check("連續幾輪認不得也不會把記號洗掉", e.autoplay_resumable)
        e.rec.readable = True
        e.stop_autoplay()   # 使用者自己按停止 → 就不該再自己接回去
        check("非辨識問題的停手會清掉記號", not e.autoplay_resumable)

        e, ctl = build_auto()
        e.autoplay = True
        original_panic = A.C.panic_pressed
        A.C.panic_pressed = lambda key=None: True
        try:
            e.step()
        finally:
            A.C.panic_pressed = original_panic
        check("緊急停止不留可接回去的記號", not e.autoplay_resumable)

        e, ctl = build_auto()
        e.stop_autoplay(resumable=True)   # 本來就沒在自動玩
        check("沒在自動玩就不會留下記號", not e.autoplay_resumable)

        e, ctl = build_auto()
        e.autoplay = True
        original_panic = A.C.panic_pressed
        A.C.panic_pressed = lambda key=None: True
        try:
            st = e.step()
        finally:
            A.C.panic_pressed = original_panic
        check("按下緊急停止鍵就停手", st.kind == "stopped" and not e.autoplay,
              f"{st.kind}: {st.message}")
        check("訊息有提到那顆鍵", e.cfg.panic_key in st.message, st.message)

        print("12) 視窗追蹤：模擬器視窗被搬走也不用重新校準")
        try:
            import tkinter as _tk

            class TrackedGrabber(FakeGrabber):
                """記住最後一次被要求擷取的範圍，好檢查追蹤有沒有真的生效。"""

                def __init__(self):
                    self.last_region = None

                def grab(self, region):
                    self.last_region = region
                    return board_img.copy()

            win_title = f"fruit2048_test_emulator_{os.getpid()}"
            win = _tk.Tk()
            try:
                win.title(win_title)
                win.geometry("300x200+150+120")
                win.attributes("-topmost", True)
                win.lift()
                win.focus_force()
                win.update()
                time.sleep(0.2)
                win.update()

                original_region = V.Region(*TRUE_REGION)
                hwnd = A.C.find_window(win_title)
                rect = A.C.window_rect(hwnd) if hwnd else None
                check("測試視窗找得到、量得到位置", rect is not None, f"{rect}")

                e, ctl = build_auto()
                e.grabber = TrackedGrabber()
                e.cfg.window_anchor = {
                    "title": win_title,
                    "dx": original_region.left - rect[0],
                    "dy": original_region.top - rect[1],
                }
                e.autoplay = True

                pump(e, 2)
                check("視窗還沒動時，擷取範圍跟校準當下一樣",
                      e.grabber.last_region == original_region, f"{e.grabber.last_region}")
                check("也真的滑了一步", len(ctl.calls) == 1, f"{ctl.calls}")
                check("滑動目標用的也是同一個範圍",
                      ctl.regions[-1] == original_region, f"{ctl.regions[-1]}")

                win.geometry("300x200+270+210")
                win.update()
                time.sleep(0.15)
                win.update()

                # retry_after=0：盤面沒變 → 重新確認穩定之後立刻視為「重試」再滑一次，
                # 正好可以用來檢查追蹤後的範圍有沒有跟著套進滑動目標。要 pump 兩次是
                # 因為剛滑完那一下 _confirming 被重置了，得先重新確認一輪穩定的盤面。
                pump(e, 2)
                shifted = V.Region(original_region.left + 120, original_region.top + 90,
                                    original_region.width, original_region.height)
                check("視窗搬走之後，擷取範圍跟著移動",
                      e.grabber.last_region == shifted, f"{e.grabber.last_region}")
                check("滑動目標也跟著移動（不會對著視窗搬走前的舊位置滑）",
                      ctl.regions[-1] == shifted, f"{ctl.regions[-1]}")

                win.iconify()
                win.update()
                time.sleep(0.15)
                st = e.step()
                check("視窗縮到最小 → 安靜等待，不會報錯嚇人",
                      st.kind == "waiting" and win_title in st.message, f"{st.kind}: {st.message}")
                check("等待視窗回來時不會把自動操控關掉", e.autoplay)

                win.deiconify()
                win.lift()
                win.focus_force()
                win.update()
                time.sleep(0.15)
                win.update()
                st = e.step()
                check("視窗還原之後自己接回去，不用使用者按任何按鈕",
                      st.kind != "waiting", f"{st.kind}: {st.message}")

                win.destroy()
                win = None
                st = e.step()
                check("視窗被關掉時一樣安靜等待，不會整個炸掉",
                      st.kind == "waiting" and e.autoplay, f"{st.kind}: {st.message}")
            finally:
                if win is not None:
                    win.destroy()

            print("      · 重新吸附之後，追蹤的位移量也要跟著校正")
            win2_title = f"fruit2048_test_emulator2_{os.getpid()}"
            win2 = _tk.Tk()
            # refit_region() 內部會 cfg.save() 寫回共用的沙盒設定檔，這裡用的是
            # A.Engine(A.Config.load())（不是 build_auto，它把 move_interval 等
            # 欄位刻意壓到 0.0 方便測節奏，一旦存回磁碟就會讓後面的設定視窗測試
            # 讀到超出 UI 合法範圍的值而悄悄擋下所有套用）。就算這樣，refit_region
            # 仍然會把假造的吸附範圍存進沙盒檔，所以額外備份/還原整個檔案，
            # 不讓這個子測試留下任何看得到的痕跡。
            config_backup = None
            if os.path.exists(A.CONFIG_PATH):
                with open(A.CONFIG_PATH, "r", encoding="utf-8") as f:
                    config_backup = f.read()
            try:
                win2.title(win2_title)
                win2.geometry("300x200+500+80")
                win2.attributes("-topmost", True)
                win2.lift()
                win2.focus_force()
                win2.update()
                time.sleep(0.2)
                win2.update()

                rect2 = A.C.window_rect(A.C.find_window(win2_title))
                e2 = A.Engine(A.Config.load())
                e2.grabber = FakeGrabber()
                e2.cfg.window_anchor = {
                    "title": win2_title,
                    "dx": e2.region.left - rect2[0],
                    "dy": e2.region.top - rect2[1],
                }

                fitted = V.Region(e2.region.left + 5, e2.region.top - 3,
                                   e2.region.width, e2.region.height)
                original_autofit = A.V.autofit_screen
                A.V.autofit_screen = lambda *a, **kw: fitted
                try:
                    ok = e2.refit_region()
                finally:
                    A.V.autofit_screen = original_autofit

                check("重新吸附成功", ok)
                check("鎖定的視窗標題沒變", e2.cfg.window_anchor["title"] == win2_title)
                check("位移量重新對齊吸附後的位置",
                      e2.cfg.window_anchor["dx"] == fitted.left - rect2[0] and
                      e2.cfg.window_anchor["dy"] == fitted.top - rect2[1],
                      f"{e2.cfg.window_anchor}")
            finally:
                win2.destroy()
                if config_backup is not None:
                    with open(A.CONFIG_PATH, "w", encoding="utf-8") as f:
                        f.write(config_backup)
        except _tk.TclError as e:
            check("視窗追蹤（需要能開視窗的環境）", False, str(e))

        print("13) UI：建得起來、各種狀態都畫得出來")
        try:
            ui = A.AssistApp()
        except Exception as e:
            check("AssistApp 建構", False, f"{type(e).__name__}: {e}")
            return 1
        try:
            ui.worker.pause()
            ui.engine.grabber = FakeGrabber()
            ui.update()
            check("AssistApp 建構", True)

            states = [
                A.Status("waiting", "還沒校準"),
                A.Status("unknown", "有新水果", reading=reading),
                A.Status("misaligned", "校準跑掉了", reading=reading),
                A.Status("settling", "畫面變動中"),
                A.Status("error", "抓不到畫面"),
                st2,
                A.Status("nomove", "結束了", cells=TRUE_BOARD, result=st2.result),
            ]
            for s in states:
                ui._render(s)
                ui.update()
            check("七種狀態都渲染成功", True)

            ui.flash("測試訊息")
            ui.update()
            check("flash 訊息", ui.status.cget("text") == "測試訊息")

            ui._render(st2)
            ui.update()
            check("建議方向有顯示在標題", S.MOVE_NAME[st2.result.best] in ui.move_name.cget("text"),
                  ui.move_name.cget("text"))
            shown = [ui.cells[i].cget("text") for i in range(16)]
            want = [str(v) if v else "" for v in TRUE_BOARD]
            check("盤面 16 格都顯示正確", shown == want, f"{shown}")

            # 盤面在變的那一兩輪，箭頭還是上一步的建議。要調暗，不然使用者
            # 分不出「這是新算的」還是「還沒跟上」，會照著過期的方向滑。
            lit = ui.arrow.cget("fg")
            ui._render(A.Status("settling", "畫面變動中"))
            ui.update()
            check("畫面變動中箭頭會變暗", ui.arrow.cget("fg") == A.FG_DIM,
                  f"{ui.arrow.cget('fg')}")
            check("箭頭本身留著，只是變暗", ui.arrow.cget("text") == S.MOVE_ARROW[st2.result.best])
            ui._render(st2)
            ui.update()
            check("算好之後箭頭亮回來", ui.arrow.cget("fg") == lit, f"{ui.arrow.cget('fg')}")

            fresh = eng.rec.read(board_img)  # 學過之後的判讀，才會有預填值
            dlg = A.LabelDialog(ui, fresh, focus_unknown=False)
            ui.update()
            check("標記視窗建得起來", len(dlg.entries) == 16)
            check("標記視窗有預填目前判讀",
                  [e.get() for e in dlg.entries] == [str(v) for v in TRUE_BOARD])
            dlg.destroy()
            ui.update()

            tuner = A.RegionTuner(ui, V.Region(*TRUE_REGION))
            ui.update()
            before_left = tuner.region.left
            tuner._nudge(-3, 2)
            ui.update()
            check("微調視窗建得起來且方向鍵有效果",
                  tuner.region.left == before_left - 3 and tuner.region.top == TRUE_REGION[1] + 2)
            # 校準期間背景是暫停的，中途放棄不能讓程式卡在暫停狀態
            ui.worker.pause()
            tuner.destroy()
            ui.update()
            check("微調視窗中途關掉會恢復背景偵測", not ui.worker.paused)

            check("自動玩按鈕預設是關閉狀態", "開始自動玩" in ui.auto_btn.cget("text"))
            check("預設不會自己開始", not ui.engine.autoplay)
            ui.engine.autoplay = True
            ui._sync_auto_note()
            ui.update()
            check("開啟後按鈕變成停止", "停止自動玩" in ui.auto_btn.cget("text"))
            check("旁邊有寫緊急停止鍵", ui.cfg.panic_key in ui.auto_note.cget("text"),
                  ui.auto_note.cget("text"))
            ui.engine.stop_autoplay()
            ui._sync_auto_note()
            ui.update()

            # 視窗蓋在盤面上時滑動會點到自己，這個偵測是唯一的防線
            #
            # 搬完視窗一定要 update() 不能只 update_idletasks()：geometry() 只是
            # 「跟視窗管理員要一個位置」，winfo_rootx() 要等 ConfigureNotify 進來
            # 才會更新，而那是真的事件、idletasks 不處理。只等 idletasks 的話，
            # 這幾項會看心情通過。
            r = ui.engine.region
            ui.geometry(f"+{r.left + 20}+{r.top + 60}")
            ui.update()
            check("視窗蓋住盤面時偵測得到", ui._overlaps_board())
            ui.geometry(f"+{r.right + 80}+{r.bottom + 80}")
            ui.update()
            check("移開之後不會誤判", not ui._overlaps_board())

            print("      · 標記完新水果要自己接回去（使用者回報：標記完就不動了）")
            ui.engine.autoplay = True
            ui.engine.stop_autoplay(resumable=True)   # 模擬 step() 撞到沒見過的水果
            ui.worker.pause()                         # 標記期間背景是停的
            dlg = A.LabelDialog(ui, fresh, focus_unknown=False)
            ui.update()
            dlg._save()
            ui.update()
            check("標記完會自己接回自動操控", ui.engine.autoplay)
            check("接回去之後背景偵測也是開的", not ui.worker.paused)
            check("接回去之後記號就清掉", not ui.engine.autoplay_resumable)
            check("按鈕字樣同步成停止自動玩", "停止自動玩" in ui.auto_btn.cget("text"))
            ui.engine.stop_autoplay()

            dlg = A.LabelDialog(ui, fresh, focus_unknown=False)
            ui.update()
            dlg._save()
            ui.update()
            check("沒在自動玩的話，標記完不會憑空開始搶滑鼠", not ui.engine.autoplay)

            ui.engine.autoplay = True
            ui.engine.stop_autoplay(resumable=True)
            ui.geometry(f"+{r.left + 20}+{r.top + 60}")
            ui.update()
            check("視窗蓋住盤面時寧可不接回去",
                  not ui.resume_autoplay_if_interrupted() and not ui.engine.autoplay)
            ui.geometry(f"+{r.right + 80}+{r.bottom + 80}")
            ui.update()

            # 校準/標記/吸附會自己暫停再恢復，按鈕字樣不能停在「繼續」
            ui.worker.pause()
            ui._sync_pause_btn()
            check("暫停時按鈕寫著繼續", ui.pause_btn.cget("text") == "繼續")
            ui.worker.resume()
            ui._sync_pause_btn()
            check("背景自己恢復後按鈕字樣跟著回來", ui.pause_btn.cget("text") == "暫停")

            check("暫停會一併關掉自動操控",
                  (setattr(ui.engine, "autoplay", True), ui.toggle_pause(),
                   not ui.engine.autoplay)[2])
            ui.toggle_pause()   # 恢復
            check("校準會一併關掉自動操控",
                  (setattr(ui.engine, "autoplay", True), ui.engine.stop_autoplay(),
                   not ui.engine.autoplay)[2])

            print("      · 兩段式校準遮罩")

            class Ev:
                def __init__(self, x, y):
                    self.x, self.y = x, y

            screen = V.Region(0, 0, 1920, 1080)   # 讓畫布座標＝螢幕座標，好推算

            def run_overlay():
                got = {}
                ov = A.CalibrationOverlay(ui, screen, 4, 4, lambda c: got.setdefault("cal", c))
                return ov, got

            # 使用者「應該會點在哪」由 TRUE_REGION 推出來。寫死絕對座標的話，
            # 換一張測資圖就會算出完全不同的範圍，而且錯誤看起來像校準壞掉。
            px, py = TRUE_REGION[2] / 4, TRUE_REGION[3] / 4

            def cell_center(r, c):
                return (int(round(TRUE_REGION[0] + (c + 0.5) * px)),
                        int(round(TRUE_REGION[1] + (r + 0.5) * py)))

            cw = int(round(px * 0.84))   # 使用者框的一格會比格距小一點（格線與間隙不算）
            tlx, tly = cell_center(0, 0)
            bx, by = tlx - cw // 2, tly - cw // 2

            ov, got = run_overlay()
            check("一開始是第 1 步", ov.phase == 1)
            ov._press(Ev(bx, by)); ov._drag(Ev(bx + cw, by + cw)); ov._release(Ev(bx + cw, by + cw))
            check("框完左上一格 → 進入第 2 步", ov.phase == 2, f"phase={ov.phase}")
            check("記下格子大小", tuple(ov.cell_box) == (bx, by, cw, cw), f"{tuple(ov.cell_box)}")
            ov._press(Ev(*cell_center(0, 3)))
            ov._press(Ev(*cell_center(3, 3)))
            check("點兩個角落還不算完成", "cal" not in got and len(ov.points) == 2)
            ov._press(Ev(*cell_center(3, 0)))
            cal = got.get("cal")
            check("點滿三個角落就回報結果", cal is not None)
            if cal:
                d = max(abs(cal.region.left - TRUE_REGION[0]), abs(cal.region.top - TRUE_REGION[1]),
                        abs(cal.region.width - TRUE_REGION[2]), abs(cal.region.height - TRUE_REGION[3]))
                check("算出來的範圍對得上真值", d <= 2, f"{tuple(cal.region)} 誤差 {d}px")
                check("inset 也一起算出來", 0.04 <= cal.inset <= 0.30, f"{cal.inset:.3f}")
            ui.update()

            ov, got = run_overlay()
            ov._press(Ev(bx, by)); ov._drag(Ev(bx + cw, by + cw)); ov._release(Ev(bx + cw, by + cw))
            ov._press(Ev(*cell_center(0, 3)))
            ov._undo()
            check("Backspace 退掉一個點", len(ov.points) == 0 and ov.phase == 2)
            ov._undo()
            check("再退一次回到第 1 步", ov.phase == 1 and ov.cell_box is None)
            ov._cancel()
            check("取消回報 None", got.get("cal", "missing") is None)
            ui.update()

            ov, got = run_overlay()
            ov._press(Ev(65, 65)); ov._drag(Ev(160, 160)); ov._release(Ev(160, 160))
            ov._press(Ev(112, 452)); ov._press(Ev(450, 452)); ov._press(Ev(450, 112))  # 順序反了
            check("順序點反 → 不會關掉視窗，而是就地提示",
                  "cal" not in got and ov.points == [] and ov.winfo_exists())
            check("錯誤訊息有顯示出來",
                  "不合理" in ov.canvas.itemcget(ov.error_id, "text"),
                  ov.canvas.itemcget(ov.error_id, "text")[:30])
            ov._cancel()
            ui.update()

            ov, got = run_overlay()
            ov._press(Ev(100, 100)); ov._drag(Ev(105, 105)); ov._release(Ev(105, 105))
            check("框太小不會進下一步", ov.phase == 1)
            check("有提示框太小", "太小" in ov.canvas.itemcget(ov.error_id, "text"))
            ov._cancel()
            ui.update()

            settings = A.SettingsDialog(ui)
            ui.update()
            method_var, method_map = settings.vars["autoplay_method"]
            check("設定視窗有操控方式下拉選單", set(method_map.values()) == set(A.C.Controller.METHODS),
                  f"{sorted(method_map.values())}")
            method_var.set(A.METHOD_LABELS["arrows"])
            settings._apply()
            check("操控方式改得動", ui.cfg.autoplay_method == "arrows", ui.cfg.autoplay_method)
            check("引擎的 controller 跟著換", ui.engine.controller.method == "arrows")
            ui.cfg.autoplay_method = "swipe"
            ui.apply_config()

            settings = A.SettingsDialog(ui)
            ui.update()
            settings.vars["time_budget"].set("abc")
            settings._apply()
            check("設定視窗擋得住亂填", "不是數字" in settings.hint.cget("text"))
            settings.vars["time_budget"].set("99")
            settings._apply()
            check("設定視窗擋得住超出範圍", "0.05 到 1.5" in settings.hint.cget("text"),
                  settings.hint.cget("text"))
            # 真的踩過的坑：想填 0.5 卻打成 05，float() 收成 5.0 照單全收，
            # 每步先想 5 秒，整個看起來像當機。上限壓低就是要讓它跳紅字。
            before = ui.cfg.time_budget
            settings.vars["time_budget"].set("05")
            settings._apply()
            check("少打小數點會被擋下來（05 不是 0.5）",
                  "0.05 到 1.5" in settings.hint.cget("text") and ui.cfg.time_budget == before,
                  f"time_budget={ui.cfg.time_budget}")
            settings.vars["time_budget"].set("0.4")
            settings._apply()
            check("合法值套用得進去", ui.cfg.time_budget == 0.4)
            ui.update()
        finally:
            ui.worker.stop()
            ui.destroy()

        print()
        if _failures:
            print(f"有 {len(_failures)} 項失敗 ❌")
            for f in _failures:
                print(f"  - {f}")
            return 1
        print("全部通過 ✅")
        return 0
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
