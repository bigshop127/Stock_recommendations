"""引擎測試：用「遊戲模擬器」＋假時鐘＋假點擊，把整條迴圈（辨識→規劃→點擊→驗收→過關→下一關）跑一遍。

不開視窗、不碰桌面、不送真點擊、不吃真實時間（時鐘是假的，`sleep` 只是把假時鐘往前撥）。
資料夾導到暫存夾（config/palette/debug 都不會動到使用者真正的檔案）。
"""

from __future__ import annotations

import os
import sys
import tempfile

# 一定要在 import engine 之前：測試不能去動使用者真正的設定與除錯截圖
_TMP = tempfile.mkdtemp(prefix="gemsort_test_")
os.environ["GEMSORT_DATA_DIR"] = _TMP

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import engine as E  # noqa: E402
import simgame as SG  # noqa: E402
import solver as S  # noqa: E402
import vision as V  # noqa: E402
from test_solver import puzzle_from_expect  # noqa: E402

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


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def now(self) -> float:
        return self.t

    def sleep(self, dt: float) -> None:
        self.t += dt


class FakeWorld:
    """一連串關卡＋過關畫面。點擊由這裡解讀（點到哪根管子、結算畫面點沒點到按鈕）。"""

    def __init__(self, clock: Clock, games, solved_delay: float = 1.0) -> None:
        self.clock = clock
        self.games = list(games)
        self.cur = 0
        self.screen = "level"
        self.selected = None
        self.solved_at = None
        self.solved_delay = solved_delay
        self.clicks = []
        self.drop = 0                  # 忽略接下來 N 次點擊
        self.deaf_pairs = set()        # 這些 (來源, 目標) 永遠點不動（模擬遊戲不接受）
        self.forced_problem = None     # 強制回傳「有疑點」的盤面
        self.blackout = False          # 強制回傳「不認得」
        self.target = (900.0, 500.0)
        self.overlay_target = (600.0, 380.0)

    @property
    def game(self) -> SG.SimGame:
        return self.games[self.cur]

    # ---- 辨識（取代 vision.analyze）----
    def analyze(self, img, palette):
        if self.blackout:
            return V.ScreenInfo("unknown")
        if self.screen == "level":
            if self.game.solved() and self.solved_at is None:
                self.solved_at = self.clock.t
            if self.solved_at is not None and self.clock.t - self.solved_at >= self.solved_delay:
                self.screen = "reward"
            else:
                board = self.game.observe_board()
                if self.forced_problem:
                    board.problems.append(self.forced_problem)
                return V.ScreenInfo("level", board=board)
        if self.screen == "reward":
            return V.ScreenInfo("reward", target=self.overlay_target, detail="獎勵畫面")
        if self.screen == "result":
            return V.ScreenInfo("result", target=self.target, detail="結算畫面")
        return V.ScreenInfo("unknown")

    # ---- 點擊（取代 control.click）----
    def click(self, x, y, hold=0.06):
        self.clicks.append((x, y, self.screen))
        if self.drop > 0:
            self.drop -= 1
            return
        if self.screen == "level":
            board = self.game.observe_board()
            idx = min(range(len(board.tubes)), key=lambda i: abs(board.tubes[i].px - x) + abs(board.tubes[i].py - y))
            if self.selected is None:
                self.selected = idx if self.game.gems[idx] else None
            else:
                s, self.selected = self.selected, None
                if (s, idx) not in self.deaf_pairs and s != idx:
                    self.game.move(s, idx)
        elif self.screen == "reward":
            self.screen = "result"
        elif self.screen == "result":
            if abs(x - self.target[0]) < 30 and abs(y - self.target[1]) < 30:
                if self.cur + 1 < len(self.games):
                    self.cur += 1
                    self.screen = "level"
                    self.solved_at = None
                else:
                    self.screen = "gone"


def make_engine(world: FakeWorld, clock: Clock, **cfg_kw):
    cfg = E.Config()
    cfg.region = {"left": 0, "top": 0, "width": 1200, "height": 600}
    for k, v in cfg_kw.items():
        setattr(cfg, k, v)

    class G:
        def grab(self, region):
            return np.zeros((region.height, region.width, 3), dtype=np.uint8)

    eng = E.Engine(cfg, grabber=G(), clicker=world.click, guard=None, busy=lambda: False,
                   analyzer=world.analyze, sleep=clock.sleep, clock=clock.now, palette=V.Palette())
    return eng


def run(eng: E.Engine, clock: Clock, until, max_iters: int = 3000, dt: float = 0.15):
    last = None
    for i in range(max_iters):
        last = eng.step()
        if until(last):
            return last, i
        clock.t += dt
    return last, max_iters


def game_from(name: str, fill, jar_order=None) -> SG.SimGame:
    return SG.from_puzzle(puzzle_from_expect(name), fill, jar_order=jar_order)


# ---------------------------------------------------------------- 測試

def test_single_level() -> None:
    print("[1] 自動玩完 1-2 關（含藍罐解鎖、看不見的寶石），步數＝15")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "solved")
    check("走到「這關已歸位」", st.kind == "solved", f"{st.kind}: {st.message}")
    check("遊戲真的過關", world.game.solved())
    check("走了 15 步", world.game.steps == 15, f"steps={world.game.steps}")
    check("每步剛好點兩下（選來源、點目標）", len(world.clicks) == 30, f"{len(world.clicks)} 下")
    check("引擎計的步數 = 15", eng.moves_done == 15, f"{eng.moves_done}")


def test_semi_auto() -> None:
    print("[2] 自動操控關閉時：只給建議、絕不點擊")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    for _ in range(10):
        st = eng.step()
        clock.t += 0.15
    check("沒有任何點擊", len(world.clicks) == 0)
    check("有給建議與下一步", st.kind == "ok" and st.move is not None and "建議" in st.message, f"{st.kind} {st.message}")


def test_level_chain() -> None:
    print("[3] 連闖：過關 → 點空白 → 點下一關 → 新的一關 → …")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"]),
                              game_from("lvl1-3_0_start.png", ["magenta"])])
    eng = make_engine(world, clock)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: world.screen == "gone")
    check("兩關都走完並點了最後的「下一關」", world.screen == "gone", f"screen={world.screen} {st.message}")
    check("兩關都真的過關", all(g.solved() for g in world.games))
    check("引擎計到 2 次「下一關」", eng.levels_done == 2, f"{eng.levels_done}")
    ov = [c for c in world.clicks if c[2] in ("reward", "result")]
    check("每關獎勵畫面點 1 下、結算畫面點 1 下（共 4 下）", len(ov) == 4, f"{len(ov)}: {ov}")


def test_max_levels() -> None:
    print("[4] 連闖上限：到了就停手，不點「下一關」")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"]),
                              game_from("lvl1-3_0_start.png", ["magenta"])])
    eng = make_engine(world, clock, max_levels=1)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "stopped" or world.screen == "gone")
    check("第 1 關的「下一關」點了、第 2 關結束後停手", st.kind == "stopped" and "上限" in st.message, f"{st.kind} {st.message}")
    check("只點了 1 次「下一關」", eng.levels_done == 1, f"{eng.levels_done}")


def test_dropped_click() -> None:
    print("[5] 點擊被吃掉（遊戲沒反應）→ 重試後成功")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    world.drop = 2                       # 第一步的兩下點擊都被吃掉
    eng = make_engine(world, clock)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "solved")
    check("最後還是過關", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")
    check("多花的點擊有限（重試 1 次）", len(world.clicks) <= 34, f"{len(world.clicks)} 下")


def test_deaf_move_banned() -> None:
    print("[6] 某一步遊戲永遠不接受 → 列入黑名單、改走別的路")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    # 先看引擎第一步想走哪一步，然後讓那一步永遠點不動
    probe = make_engine(world, clock)
    first = probe.step()
    for _ in range(3):
        first = probe.step()
        clock.t += 0.15
    move = first.move
    world.deaf_pairs.add(move)
    eng = make_engine(world, clock)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind in ("solved", "stopped", "stuck"))
    check(f"避開走不通的 {move}，仍然過關", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")
    lv = [c for c in world.clicks if c[2] == "level"]
    pairs = [(round(lv[i][0] / 100) - 1, round(lv[i + 1][0] / 100) - 1) for i in range(0, len(lv) - 1, 2)]
    tries = sum(1 for pr in pairs if pr == move)
    check(f"走不通的那一步最多試 {eng.cfg.max_retries + 1} 次就放棄（實際 {tries} 次）",
          1 <= tries <= eng.cfg.max_retries + 1, f"{tries}")


def test_stop_conditions() -> None:
    print("[7] 停手條件：疑點、認不得、被擋住、使用者按著滑鼠")
    clock = Clock()
    # 盤面持續有疑點
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    world.forced_problem = "第1排第1根顏色分不清"
    eng = make_engine(world, clock, problem_timeout=5.0)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "stopped", max_iters=200)
    check("盤面一直讀不準 → 停手且沒點過", st.kind == "stopped" and len(world.clicks) == 0, f"{st.kind} {st.message}")
    # 一直認不得
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    world.blackout = True
    eng = make_engine(world, clock, unknown_timeout=10.0)
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "stopped", max_iters=200)
    check("一直認不得畫面 → 停手且沒點過", st.kind == "stopped" and len(world.clicks) == 0, f"{st.kind} {st.message}")
    # 被別的視窗擋住
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    eng.guard = lambda x, y: "別的程式的視窗「Chrome」"
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "stopped", max_iters=200)
    check("點擊目標被別的視窗擋住 → 停手且沒點過", st.kind == "stopped" and "Chrome" in st.message and len(world.clicks) == 0,
          f"{st.kind} {st.message}")
    # 使用者按著滑鼠
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    eng._busy = lambda: True
    eng.start_autoplay()
    for _ in range(30):
        eng.step()
        clock.t += 0.15
    check("使用者按著滑鼠 → 不點", len(world.clicks) == 0)


def test_transient_frames() -> None:
    print("[8] 動畫中途的髒畫面（寶石數量不對）不會被拿去規劃")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    eng.start_autoplay()
    # 先跑幾步讓引擎建立基準
    run(eng, clock, lambda s: eng.moves_done >= 2)
    moves_before = eng.moves_done
    clicks_before = len(world.clicks)
    real = world.analyze

    def flying(img, palette):
        info = real(img, palette)
        if info.kind == "level":
            board = info.board
            for t in board.tubes:
                if t.cells:
                    t.cells = t.cells[:-1]          # 少一顆＝寶石在半空中
                    break
        return info

    eng._analyze = flying
    for _ in range(30):
        st = eng.step()
        clock.t += 0.15
    check("寶石數量不對的畫面 → 一律等待、不點擊", len(world.clicks) == clicks_before and st.kind == "settling",
          f"{st.kind} {st.message}")
    eng._analyze = real
    st, n = run(eng, clock, lambda s: s.kind == "solved")
    check("畫面恢復後照常走完", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")


def test_hidden_level() -> None:
    print("[9] 2-1（14 根管、4 顆問號、3 個藍罐）多種真相都能自動過關")
    import random
    rng = random.Random(3)
    pz = puzzle_from_expect("lvl2-1_start.png")
    cons = S.check_consistency(pz)
    pool = []
    for c, n in cons.deficits.items():
        pool += [c] * n
    jars = [i for i, k in enumerate(pz.kinds) if k == "jar"]
    ok_all, worst = True, 0
    fails = []
    for r in range(4):
        fill = pool[:]
        rng.shuffle(fill)
        order = list(reversed(jars)) if r % 2 else None
        clock = Clock()
        world = FakeWorld(clock, [SG.from_puzzle(pz, fill, jar_order=order)])
        eng = make_engine(world, clock)
        eng.start_autoplay()
        st, n = run(eng, clock, lambda s: s.kind in ("solved", "stopped", "stuck"), max_iters=4000)
        ok = st.kind == "solved" and world.game.solved()
        ok_all &= ok
        worst = max(worst, world.game.steps)
        if not ok:
            fails.append(f"真相{r}: {st.kind} {st.message}")
    check(f"4 種真相全部過關（最多 {worst} 步）", ok_all, "; ".join(fails))


def test_layout_change() -> None:
    print("[10] 管子排列突然變了（換關）→ 這一關的暫存全部作廢")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"]),
                              game_from("lvl1-3_0_start.png", ["magenta"])])
    eng = make_engine(world, clock)
    eng.start_autoplay()
    run(eng, clock, lambda s: eng.moves_done >= 3)
    eng._banned.add((0, 1))
    world.cur = 1                            # 直接跳到另一關（沒經過結算畫面）
    world.solved_at = None
    for _ in range(4):
        eng.step()
        clock.t += 0.15
    new_gems = sum(len(t.cells) for t in world.game.observe_board().tubes)
    check("換關後黑名單清空、基準寶石數重設成新關的數量", eng._banned == set() and eng._total_gems == new_gems,
          f"banned={eng._banned} total={eng._total_gems} 新關={new_gems}")
    st, n = run(eng, clock, lambda s: s.kind == "solved")
    check("新的一關照常走完", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")


def _strip_top_gem(board: V.Board, tube_i: int) -> None:
    """模擬橫幅蓋住某根管子最上面那顆寶石（讀起來像空的）。"""
    t = board.tubes[tube_i]
    if t.cells:
        t.cells = t.cells[:-1]


def test_banner_covers_gem() -> None:
    print("[12] 橫幅蓋住寶石（9/20 實機：「你完成了一個寶匣歸類！」蓋住最上排最上面一顆 → 顏色對不上 → 誤判無解停手）")
    # 12a 橫幅一開始就在（引擎第一眼看到的就是被蓋住的盤面）：等它消失、期間不點、消失後走完
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    real = world.analyze
    banner_until = clock.t + 4.0

    def banner(img, palette):
        info = real(img, palette)
        if info.kind == "level" and clock.t < banner_until:
            _strip_top_gem(info.board, 0)
        return info

    eng._analyze = banner
    eng.start_autoplay()
    st = None
    while clock.t < banner_until - 0.3:
        st = eng.step()
        clock.t += 0.15
    check("橫幅期間：不停手、不點擊、顯示「等一下」", eng.autoplay and len(world.clicks) == 0 and st.kind == "settling",
          f"autoplay={eng.autoplay} clicks={len(world.clicks)} {st.kind}: {st.message}")
    st, n = run(eng, clock, lambda s: s.kind in ("solved", "stopped", "stuck"))
    check("橫幅消失後照常走完整關", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")

    # 12b 橫幅一直不走（其實是顏色真的讀錯）：等到 problem_timeout 才停手，且存下畫面
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock, problem_timeout=5.0)
    real = world.analyze

    def forever(img, palette):
        info = real(img, palette)
        if info.kind == "level":
            _strip_top_gem(info.board, 0)
        return info

    eng._analyze = forever
    eng.start_autoplay()
    st, n = run(eng, clock, lambda s: s.kind == "stopped", max_iters=200)
    check("顏色一直對不上 → 逾時才停手、沒點過、訊息講清楚",
          st.kind == "stopped" and len(world.clicks) == 0 and "顏色" in st.message, f"{st.kind}: {st.message}")

    # 12c 寶石總數基準被誤設偏低（在橫幅期間建立的）：讀到更多且顏色湊得齊 → 基準往上修，不卡死
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock, problem_timeout=5.0)
    eng.start_autoplay()
    run(eng, clock, lambda s: eng.moves_done >= 2)
    eng._total_gems -= 1
    st, n = run(eng, clock, lambda s: s.kind in ("solved", "stopped", "stuck"))
    check("基準偏低 → 自動修正並走完", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")


def test_layout_jitter() -> None:
    print("[13] 動畫讓管子位置晃動（實機：升起/光環讓管底偏 2~14px）≠ 換關，不能清掉這一關的暫存")
    clock = Clock()
    world = FakeWorld(clock, [game_from("lvl1-2_0_start.png", ["violet"])])
    eng = make_engine(world, clock)
    eng.start_autoplay()
    run(eng, clock, lambda s: eng.moves_done >= 3)
    planner, level_moves, replans = eng._planner, eng._level_moves, eng._planner.replans
    real = world.analyze
    shift = {"dy": 0.0}

    def jitter(img, palette):
        info = real(img, palette)
        if info.kind == "level":
            for t in info.board.tubes[2:4]:
                t.py += shift["dy"]
        return info

    eng._analyze = jitter
    for dy in (5.0, 14.0, -9.0, 14.0, 0.0):
        shift["dy"] = dy
        for _ in range(4):
            eng.step()
            clock.t += 0.15
    check("管子位置晃動 5~14px：沒被當成換關（規劃器、本關步數都還在）",
          eng._planner is planner and eng._level_moves >= level_moves,   # 步數只會往上走、不會歸零
          f"planner 換了={eng._planner is not planner} 本關步數 {level_moves}→{eng._level_moves}")
    eng._analyze = real
    st, n = run(eng, clock, lambda s: s.kind == "solved")
    check("晃動後照常走完", st.kind == "solved" and world.game.solved(), f"{st.kind}: {st.message}")
    check("沒有因為晃動重新規劃很多次", eng._planner.replans - replans <= 2, f"多重規劃 {eng._planner.replans - replans} 次")


def test_real_banner_frames() -> None:
    print("[14] 9/20 實機兩張「橫幅蓋住寶石」截圖（真辨識）：等橫幅消失，不誤判無解、不亂點")
    from PIL import Image
    data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata")
    for name in ("lvl1-6_banner_covers_blue.png", "lvl1-7_banner_covers_magenta.png"):
        img = np.array(Image.open(os.path.join(data, name)).convert("RGB"))
        clock = Clock()
        clicks = []

        class G:
            def grab(self, region):
                return img

        cfg = E.Config()
        cfg.region = {"left": 0, "top": 0, "width": img.shape[1], "height": img.shape[0]}
        eng = E.Engine(cfg, grabber=G(), clicker=lambda x, y, hold=0.06: clicks.append((x, y)), guard=None,
                       busy=lambda: False, sleep=clock.sleep, clock=clock.now, palette=V.Palette())
        eng.start_autoplay()
        st = None
        for _ in range(40):                     # 6 秒（橫幅實際約 2~3 秒；逾時 12 秒才停手）
            st = eng.step()
            clock.t += 0.15
        check(f"{name}: 等待中、沒停手、沒點擊", eng.autoplay and not clicks and st.kind == "settling",
              f"autoplay={eng.autoplay} clicks={len(clicks)} {st.kind}: {st.message}")


def test_predict_and_compatible() -> None:
    print("[11] 預測與驗收函式")
    cells = [["a", "b", "b"], ["c", "b"], []]
    kinds = ["normal"] * 3
    pred = E.predict_cells(cells, kinds, (0, 1))
    check("整串搬：b,b 搬到 c,b 上 → [c,b,b,b]、來源剩 [a]", pred == [["a"], ["c", "b", "b", "b"], []], str(pred))
    check("放不下整串 → 預測不合法", E.predict_cells([["a", "b", "b"], ["c", "b", "b", "b"], []], kinds, (0, 1)) is None)
    check("看不見的格子當萬用（顯現了什麼都算對）",
          E.compatible([["a"], ["x"]], ["normal"] * 2, [["a"], ["?"]], ["normal"] * 2))
    check("已知的格子對不上 → 不一致", not E.compatible([["a"], ["x"]], ["normal"] * 2, [["a"], ["y"]], ["normal"] * 2))
    check("藍罐鎖 → 一般管算一致", E.compatible([["a"]], ["normal"], [["a"]], ["jar"]))
    check("其他種類變化 → 不一致", not E.compatible([["a"]], ["fixed"], [["a"]], ["normal"]))



def test_real_frames() -> None:
    print("[12] 真實截圖 + 真實辨識 → 點擊座標（不假造辨識，驗證座標對得上畫面上的管子與按鈕）")
    from test_vision import load

    class G:
        def __init__(self, name: str) -> None:
            self.name = name

        def grab(self, region):
            return load(self.name)

    def fresh(name: str):
        clock = Clock()
        clicks = []
        img = load(name)
        cfg = E.Config()
        cfg.region = {"left": 0, "top": 0, "width": img.shape[1], "height": img.shape[0]}
        grab = G(name)
        eng = E.Engine(cfg, grabber=grab, clicker=lambda x, y, hold=0.06: clicks.append((x, y)), guard=None,
                       busy=lambda: False, sleep=clock.sleep, clock=clock.now, palette=V.Palette())
        return eng, clock, clicks, grab, img

    eng, clock, clicks, grab, img = fresh("lvl1-2_0_start.png")
    board = V.build_board(img, V.Palette())
    pz = S.Puzzle(kinds=[t.kind for t in board.tubes], cells=[list(t.cells) for t in board.tubes])
    exp = S.Planner().plan(pz).first
    eng.start_autoplay()
    run(eng, clock, lambda st: len(clicks) >= 2, max_iters=40)
    check("關卡畫面：點了兩下（來源、目標）", len(clicks) == 2, str(clicks))
    if len(clicks) == 2:
        (x0, y0), (x1, y1) = clicks
        src, dst = board.tubes[exp[0]], board.tubes[exp[1]]
        check(f"第一下點在來源管 {src.label()} 的管身上", abs(x0 - src.px) <= 2 and abs(y0 - src.py) <= 2, f"({x0},{y0}) vs ({src.px:.0f},{src.py:.0f})")
        check(f"第二下點在目標管 {dst.label()} 的管身上", abs(x1 - dst.px) <= 2 and abs(y1 - dst.py) <= 2, f"({x1},{y1}) vs ({dst.px:.0f},{dst.py:.0f})")
        h = img.shape[0]
        check("兩下都落在盤面範圍內（不在畫面邊緣的雜物上）", 0.15 * h < y0 < 0.9 * h and 0.15 * h < y1 < 0.9 * h)

    eng, clock, clicks, grab, img = fresh("lvl1-2_4_clear_reward.png")
    eng.start_autoplay()
    run(eng, clock, lambda st: len(clicks) >= 1, max_iters=40)
    h, w = img.shape[:2]
    check("獎勵畫面：點了一下、位置在按鈕上方的空白處",
          len(clicks) == 1 and 0.3 * w < clicks[0][0] < 0.7 * w and 0.45 * h < clicks[0][1] < 0.75 * h, str(clicks))

    eng, clock, clicks, grab, img = fresh("lvl1-2_5_clear_result.png")
    eng.start_autoplay()
    run(eng, clock, lambda st: len(clicks) >= 1, max_iters=40)
    h, w = img.shape[:2]
    check("結算畫面：點在「下一關」按鈕上（右邊那顆黃鈕）",
          len(clicks) == 1 and abs(clicks[0][0] - 0.682 * w) < 0.03 * w and abs(clicks[0][1] - 0.849 * h) < 0.03 * h, str(clicks))
    check("點了「下一關」算一關", eng.levels_done == 1)

    eng, clock, clicks, grab, img = fresh("lvl2-1_start.png")
    st, n = run(eng, clock, lambda s: s.kind == "ok" and s.move is not None, max_iters=40)
    check("2-1（14 管、問號、藍罐）：自動操控關閉時只給建議、不點", st.kind == "ok" and st.move is not None and not clicks,
          f"{st.kind} {st.message}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    test_single_level()
    test_semi_auto()
    test_level_chain()
    test_max_levels()
    test_dropped_click()
    test_deaf_move_banned()
    test_stop_conditions()
    test_transient_frames()
    test_hidden_level()
    test_layout_change()
    test_banner_covers_gem()
    test_layout_jitter()
    test_real_banner_frames()
    test_predict_and_compatible()
    test_real_frames()
    print(f"\n{_passed} 項通過，{_failed} 項失敗")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
