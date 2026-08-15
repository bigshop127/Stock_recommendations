"""vision.py 的驗證。用使用者提供的真實遊戲截圖當測資。

    python test_vision.py [截圖路徑]
"""

import os
import sys

import numpy as np
from PIL import Image

import vision as V

# 中文版 Windows 的主控台預設是 cp950，印不出結尾那個 ✅/❌ 就會整支噴
# UnicodeEncodeError —— 測試明明全過，看起來卻像壞了。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 測資圖放在 repo 裡（見 test_app.py 的說明）。
DEFAULT_SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "board.png")

# 從截圖量出來的真值：格縫中心在 x≈41/227.6/414.2/600.8/787.4、y≈35/222.6/410.2/597.8/785.4
TRUE_REGION = V.Region(41, 35, 746, 750)
TOLERANCE_PX = 8

# 截圖上的實際盤面（水果編號，0=空格）
TRUE_BOARD = [
    0, 0, 0, 1,
    0, 1, 0, 2,
    0, 2, 1, 2,
    1, 4, 7, 9,
]

_failures = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{'  ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)
    return ok


def distort(full, region, dx=0, dy=0, noise=0, bright=0, gamma=1.0, scale=1.0):
    img = full[region.top + dy:region.bottom + dy, region.left + dx:region.right + dx]
    if scale != 1.0:
        w, h = region.width, region.height
        im = Image.fromarray(img).resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.BILINEAR)
        img = np.asarray(im.resize((w, h), Image.BILINEAR))
    if gamma != 1.0:
        img = (255.0 * ((img / 255.0) ** gamma)).astype(np.uint8)
    if bright:
        img = np.clip(img.astype(np.int16) + bright, 0, 255).astype(np.uint8)
    if noise:
        rng = np.random.default_rng(7)
        img = np.clip(img.astype(np.int16) + rng.integers(-noise, noise + 1, img.shape), 0, 255).astype(np.uint8)
    return img


# 商店截圖裡每個水果磚塊的位置（左, 上, 右, 下）。盤面截圖最高只到 9，
# 兩位數的徽章只有商店圖有 —— 而那正是讀號碼最容易翻車的地方。
SHOP_TILES = [
    ("shop_8_9.png", 8, (30, 30, 195, 195)),
    ("shop_8_9.png", 9, (30, 255, 195, 420)),
    ("shop_10.png", 10, (45, 45, 205, 205)),
    ("shop_11_12.png", 11, (25, 30, 190, 195)),
    ("shop_11_12.png", 12, (25, 255, 190, 420)),
]


def shop_badges():
    """商店截圖 → [(真值, 徽章圖)]，補齊盤面沒有的 8~12。"""
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    for name, label, (x0, y0, x1, y1) in SHOP_TILES:
        img = np.asarray(Image.open(os.path.join(here, "testdata", name)).convert("RGB"))
        out.append((label, V.badge_of(img[y0:y1, x0:x1])))
    return out


def stress(badge, scale=1.0, bright=0, noise=0):
    """把徽章弄小、弄亮暗、加雜訊，用來測「讀不準的時候會不會亂猜」。"""
    if scale != 1.0:
        h, w = badge.shape[:2]
        badge = np.asarray(Image.fromarray(badge).resize(
            (max(6, int(w * scale)), max(6, int(h * scale))), Image.BILINEAR))
    if bright:
        badge = np.clip(badge.astype(np.int16) + bright, 0, 255).astype(np.uint8)
    if noise:
        rng = np.random.default_rng(5)
        badge = np.clip(badge.astype(np.int16)
                        + rng.integers(-noise, noise + 1, badge.shape), 0, 255).astype(np.uint8)
    return badge


def main():
    shot = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SHOT
    if not os.path.exists(shot):
        print(f"找不到截圖：{shot}")
        return 1

    full = np.asarray(Image.open(shot).convert("RGB"))
    grid = V.Grid(4, 4, 0.10)

    ih, iw = full.shape[:2]

    def clip(left, top, w, h):
        """把範圍裁進圖片內，對應正式流程裡 autofit_screen 對桌面邊界做的裁切。"""
        l, t = max(0, left), max(0, top)
        return l, t, min(left + w, iw) - l, min(top + h, ih) - t

    def try_fit(left, top, w, h):
        left, top, w, h = clip(left, top, w, h)
        fit = V.autofit(full[top:top + h, left:left + w], 4, 4)
        if fit is None:
            return None, None
        got = V.Region(left + fit.left, top + fit.top, fit.width, fit.height)
        d = max(abs(got.left - TRUE_REGION.left), abs(got.top - TRUE_REGION.top),
                abs(got.width - TRUE_REGION.width), abs(got.height - TRUE_REGION.height))
        return got, d

    print("1) autofit：從隨便框的範圍吸附到真正的格線")
    # 模擬「使用者隨手框」：每邊各鬆一點。這些數字必須從 TRUE_REGION 推出來，
    # 不能寫死絕對座標 —— 換一張測資圖時盤面大小就變了，寫死的話十項全紅，
    # 而且看起來像 autofit 壞掉（實際上是測試自己的輸入過期）。
    for ml, mt, mr, mb in [(31, 26, 19, 27), (16, 16, 14, 22), (4, 6, 8, 8),
                           (21, 11, 24, 17), (8, 4, 12, 12), (26, 21, 14, 27),
                           (36, 31, 19, 27), (11, 8, 14, 12), (46, 36, 19, 32),
                           (6, 12, 10, 16)]:
        box = (TRUE_REGION.left - ml, TRUE_REGION.top - mt,
               TRUE_REGION.width + ml + mr, TRUE_REGION.height + mt + mb)
        got, d = try_fit(*box)
        check(f"框 {box}", d is not None and d <= TOLERANCE_PX,
              f"→ {tuple(got)} 最大誤差 {d}px" if got else "autofit 回 None")

    print("2) autofit：框得比盤面還緊時，靠外擴救回來")
    # 比盤面小，正解根本不在搜尋空間裡
    tight = (TRUE_REGION.left + 8, TRUE_REGION.top + 8,
             TRUE_REGION.width - 18, TRUE_REGION.height - 20)
    _, d_tight = try_fit(*tight)
    check("框太緊確實會吸偏（所以必須外擴）", d_tight is not None and d_tight > TOLERANCE_PX,
          f"誤差 {d_tight}px")
    pad = max(8, int(V.AUTOFIT_PAD * max(tight[2], tight[3])))
    got, d = try_fit(tight[0] - pad, tight[1] - pad, tight[2] + 2 * pad, tight[3] + 2 * pad)
    check("外擴一圈之後吸得準", d is not None and d <= TOLERANCE_PX,
          f"→ {tuple(got)} 最大誤差 {d}px" if got else "autofit 回 None")
    check("圖太小 → 回 None 而不是亂猜", V.autofit(full[:20, :20], 4, 4) is None)

    print("3) 切格")
    region = full[TRUE_REGION.top:TRUE_REGION.bottom, TRUE_REGION.left:TRUE_REGION.right]
    crops = grid.crops(region)
    check("切出 16 格", len(crops) == 16)
    check("每格尺寸一致", len({c.shape[:2] for c in crops}) <= 2, f"{sorted({c.shape[:2] for c in crops})}")

    print("4) 樣板比對：學一次之後能認出整盤")
    db = V.TemplateDB()
    rec = V.Recognizer(grid, db)
    fruit_at = [i for i, v in enumerate(TRUE_BOARD) if v]
    empty_at = [i for i, v in enumerate(TRUE_BOARD) if not v]
    # 樣板庫全空 = 第一次使用。第一層沒東西可比，整盤都靠讀格子上的號碼撐著：
    # 有水果的格子讀得出來，空格沒有數字可讀，照規矩留成「不認得」。
    fresh = rec.read(region)
    check("空樣板庫 → 有水果的格子靠號碼讀出來", fresh.badge_indices == fruit_at,
          f"{fresh.badge_indices}")
    check("空樣板庫 → 讀出來的號碼全對",
          [fresh.cells[i] for i in fruit_at] == [TRUE_BOARD[i] for i in fruit_at],
          f"{fresh.cells}")
    check("空樣板庫 → 空格照樣說不認得", fresh.unknown_indices == empty_at,
          f"{fresh.unknown_indices}")
    check("關掉讀號碼 → 16 格全部不認得",
          len(rec.read(region, use_badge=False).unknown_indices) == 16)

    added = rec.learn(crops, TRUE_BOARD)
    print(f"      學到 {added} 張樣板（16 格去重後剩下的不重複外觀）")
    check("樣板庫涵蓋所有出現過的編號", set(db.labels) == set(TRUE_BOARD))

    after = rec.read(region)
    check("再讀一次 → 全部認得", after.ok, f"未知格 {after.unknown_indices}")
    check("辨識結果與真值一致", after.cells == TRUE_BOARD, f"{after.cells}")
    worst = max(m.distance for m in after.matches)
    tight = min(m.margin for m in after.matches if m.margin != float("inf"))
    print(f"      最差匹配距離 {worst:.2f}（門檻 {db.tolerance}）；最小區隔度 {tight:.2f}")
    check("最差距離離門檻還有一倍餘裕", worst < db.tolerance / 2, f"{worst:.2f} < {db.tolerance / 2}")
    check("不同編號之間區隔夠大（>10）", tight > 10, f"{tight:.2f}")

    print("5) 穩態干擾：這些情況都必須照常讀對")
    steady = [
        ("雜訊 ±5", dict(noise=5)), ("雜訊 ±12", dict(noise=12)),
        ("亮度 +15", dict(bright=15)), ("亮度 -15", dict(bright=-15)),
        ("亮度 +30", dict(bright=30)), ("亮度 -30", dict(bright=-30)),
        ("gamma 1.2", dict(gamma=1.2)), ("gamma 0.85", dict(gamma=0.85)),
        ("縮放 0.97", dict(scale=0.97)), ("縮放 1.04", dict(scale=1.04)),
        ("位移 1px", dict(dx=1, dy=1)),
        ("亮度+30 且 雜訊±12", dict(bright=30, noise=12)),
    ]
    for name, kw in steady:
        r = rec.read(distort(full, TRUE_REGION, **kw))
        check(name, r.ok and r.cells == TRUE_BOARD,
              f"未知 {r.unknown_indices}" if not r.ok else "")

    print("6) 校準漂掉：不要求讀對，但絕不能默默讀錯")
    for dx, dy in ((3, 3), (5, 5), (8, 8), (0, 6), (-7, 0)):
        r = rec.read(distort(full, TRUE_REGION, dx=dx, dy=dy))
        silent_wrong = [
            i for i, (got, want) in enumerate(zip(r.cells, TRUE_BOARD))
            if got is not None and got != want
        ]
        check(f"位移 ({dx:+d},{dy:+d}) 沒有默默讀錯", not silent_wrong,
              f"讀對 {sum(1 for g, w in zip(r.cells, TRUE_BOARD) if g == w)}/16、"
              f"標記未知 {len(r.unknown_indices)} 格"
              + (f"、誤判 {silent_wrong}" if silent_wrong else ""))

    print("7) 漂掉時要能判斷成「該重新吸附」而不是「出現新水果」")
    drifted = rec.read(distort(full, TRUE_REGION, dx=6, dy=6))
    check("大量未知 → looks_misaligned=True", drifted.looks_misaligned)
    check("正常畫面 → looks_misaligned=False", not rec.read(region).looks_misaligned)
    # 格線偏掉的時候徽章框也跟著偏。這時候要是讓「讀號碼」去救場，未知格數會
    # 掉下來，該重新吸附的畫面就會看起來像沒事，還會把歪掉的樣板學進樣板庫。
    check("漂掉時不啟用讀號碼", drifted.badge_indices == [], f"{drifted.badge_indices}")

    print("8) 自我修復：漂掉之後重新吸附能救回來")
    drift = V.Region(TRUE_REGION.left + 6, TRUE_REGION.top + 6,
                     TRUE_REGION.width, TRUE_REGION.height)
    pad = max(8, int(V.AUTOFIT_PAD * max(drift.width, drift.height)))
    rough = V.Region(*clip(*drift.expanded(pad)))
    fit = V.autofit(full[rough.top:rough.bottom, rough.left:rough.right], 4, 4)
    check("autofit 有結果", fit is not None)
    if fit:
        healed = V.Region(rough.left + fit.left, rough.top + fit.top, fit.width, fit.height)
        r = rec.read(full[healed.top:healed.bottom, healed.left:healed.right])
        check("重新吸附後恢復正確辨識", r.ok and r.cells == TRUE_BOARD,
              f"→ {tuple(healed)}" + (f" 未知 {r.unknown_indices}" if not r.ok else ""))

    print("9) 新水果：只有一格不認得時不該被當成漂移")
    fake = region.copy()
    boxes = grid.cell_boxes(TRUE_REGION.width, TRUE_REGION.height)
    # 把西瓜那格搬到空格上，翻面＋換色版當成沒見過的水果
    dst, src = boxes[8], boxes[13]
    patch = region[src[1]:src[3], src[0]:src[2]][::-1, :, ::-1]
    patch = np.asarray(Image.fromarray(patch).resize(
        (dst[2] - dst[0], dst[3] - dst[1]), Image.BILINEAR))
    fake[dst[1]:dst[3], dst[0]:dst[2]] = patch
    r = rec.read(fake)
    check("恰好一格不認得", r.unknown_indices == [8], f"{r.unknown_indices}")
    check("不會被誤判成漂移", not r.looks_misaligned)
    n_before = len(db)
    NEW_FRUIT = 11   # 盤面上沒出現過的編號（這遊戲的水果最高到 12）
    rec.learn([r.crops[8]], [NEW_FRUIT])
    check("學會之後樣板增加", len(db) == n_before + 1)
    check("再讀就認得了", rec.read(fake).cells[8] == NEW_FRUIT)
    check("其他格不受影響", rec.read(region).cells == TRUE_BOARD)
    db.remove_label(NEW_FRUIT)

    print("10) 讀格子上的號碼：新水果不必停下來問人")
    samples = [(TRUE_BOARD[i], V.badge_of(crops[i])) for i in fruit_at] + shop_badges()
    got = [V.read_badge_number(b)[0] for _, b in samples]
    want = [v for v, _ in samples]
    check(f"盤面 + 商店共 {len(samples)} 個徽章全部讀對", got == want, f"{got}")
    check("兩位數（10/11/12）也讀得出來",
          [V.read_badge_number(b)[0] for v, b in samples if v >= 10] == [10, 11, 12])
    empty_reads = [V.read_badge_number(V.badge_of(crops[i]))[0] for i in empty_at]
    check("空格不會生出號碼", empty_reads == [None] * len(empty_at), f"{empty_reads}")
    nine = next(b for v, b in samples if v == 9)
    check("超出水果上限的號碼不採用（假裝最高只到 3）",
          V.read_badge_number(nine, max_fruit=3)[0] is None)
    check("徽章切太小 → 棄權而不是硬讀",
          V.read_badge_number(V.badge_of(crops[15])[:6])[0] is None)

    print("11) 讀號碼的底線：可以說不知道，不可以讀錯")
    # 讀錯比讀不到嚴重得多：讀不到只是回去問使用者，讀錯會把假水果學進樣板庫，
    # 之後每一幀都用錯的號碼去解，而且沒有任何跡象。所以這裡只驗「零讀錯」，
    # 棄權多少都算過。
    for name, kw in [("原圖", {}), ("縮到 70%", dict(scale=0.7)), ("縮到 55%", dict(scale=0.55)),
                     ("縮到 40%", dict(scale=0.4)), ("縮到 30%", dict(scale=0.3)),
                     ("放大 150%", dict(scale=1.5)), ("亮度 +70", dict(bright=70)),
                     ("亮度 -60", dict(bright=-60)), ("雜訊 ±35", dict(noise=35)),
                     ("又小又亮又髒", dict(scale=0.6, bright=40, noise=20))]:
        wrong, abstain = [], 0
        for v, b in samples:
            r = V.read_badge_number(stress(b, **kw))[0]
            if r is None:
                abstain += 1
            elif r != v:
                wrong.append(f"{v}→{r}")
        check(f"{name}：沒有讀錯", not wrong,
              f"棄權 {abstain}/{len(samples)}" + (f"、讀錯 {wrong}" if wrong else ""))
    # 空格更不能冒出數字 —— 那會讓求解器以為那格有東西，整盤都跟著算錯。
    for name, kw in [("縮到 55%", dict(scale=0.55)), ("亮度 +70", dict(bright=70)),
                     ("雜訊 ±35", dict(noise=35))]:
        vals = {V.read_badge_number(stress(V.badge_of(crops[i]), **kw))[0] for i in empty_at}
        check(f"{name}：空格還是空的", vals == {None}, f"{sorted(str(v) for v in vals)}")

    print("12) 存檔 / 讀檔 round-trip")
    tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_debug", "_tpl_test.json")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    db.save(tmp)
    db2 = V.TemplateDB.load(tmp)
    check("樣板數量一致", len(db2) == len(db), f"{len(db2)} vs {len(db)}")
    check("讀回來辨識結果不變", V.Recognizer(grid, db2).read(region).cells == TRUE_BOARD)
    check("壞掉的檔案 → 回空樣板庫而不是炸掉", len(V.TemplateDB.load(__file__)) == 0)
    os.remove(tmp)

    print("13) 畫面穩定偵測")
    check("同一張畫面 → 差異 0", V.frame_difference(region, region) == 0.0)
    check("動畫中的畫面 → 差異大",
          V.frame_difference(region, np.roll(region, 40, axis=1)) > V.STABLE_TOLERANCE)
    check("尺寸不同 → 視為不穩定", V.frame_difference(region, region[:-5]) == float("inf"))

    print("14) 兩段式校準：左上一格的框 + 其餘三角落的中心")

    def corners_of(reg, rows=4, cols=4, cell=None, jitter=None):
        """由一個已知的盤面範圍，倒推使用者「應該會點在哪」。"""
        px, py = reg.width / cols, reg.height / rows
        def center(r, c):
            return (reg.left + (c + 0.5) * px, reg.top + (r + 0.5) * py)
        cw, ch = cell if cell else (px * 0.85, py * 0.85)
        tlc = center(0, 0)
        box = V.Region(int(round(tlc[0] - cw / 2)), int(round(tlc[1] - ch / 2)),
                       int(round(cw)), int(round(ch)))
        pts = [center(0, cols - 1), center(rows - 1, cols - 1), center(rows - 1, 0)]
        if jitter:
            rng = np.random.default_rng(11)
            pts = [(p[0] + rng.integers(-jitter, jitter + 1),
                    p[1] + rng.integers(-jitter, jitter + 1)) for p in pts]
            box = V.Region(box.left + int(rng.integers(-jitter, jitter + 1)),
                           box.top + int(rng.integers(-jitter, jitter + 1)),
                           box.width, box.height)
        pts = [(int(round(x)), int(round(y))) for x, y in pts]
        return box, pts

    for target in (TRUE_REGION, V.Region(0, 0, 400, 400),
                   V.Region(317, 88, 612, 613), V.Region(1200, 40, 260, 264)):
        box, pts = corners_of(target)
        cal = V.calibration_from_corners(box, *pts)
        d = max(abs(cal.region.left - target.left), abs(cal.region.top - target.top),
                abs(cal.region.width - target.width), abs(cal.region.height - target.height))
        check(f"還原 {tuple(target)}", d <= 1, f"→ {tuple(cal.region)} 誤差 {d}px")

    box, pts = corners_of(TRUE_REGION)
    cal = V.calibration_from_corners(box, *pts)
    check("格距算得對",
          abs(cal.pitch_x - TRUE_REGION.width / 4) < 1
          and abs(cal.pitch_y - TRUE_REGION.height / 4) < 1,
          f"{cal.pitch_x:.1f} x {cal.pitch_y:.1f}")
    check("點得準時 skew 接近 0", cal.skew < 1.0, f"{cal.skew:.2f}")
    check("inset 由格子大小反推出合理值", 0.04 <= cal.inset <= 0.30, f"{cal.inset:.3f}")

    print("    · 點歪幾個 pixel 也要還原得回來")
    for jitter in (2, 4, 6):
        box, pts = corners_of(TRUE_REGION, jitter=jitter)
        cal = V.calibration_from_corners(box, *pts)
        d = max(abs(cal.region.left - TRUE_REGION.left), abs(cal.region.top - TRUE_REGION.top),
                abs(cal.region.width - TRUE_REGION.width),
                abs(cal.region.height - TRUE_REGION.height))
        check(f"抖動 ±{jitter}px", d <= jitter + 2, f"→ {tuple(cal.region)} 誤差 {d}px")

    print("    · 算出來的範圍＋inset 要真的能辨識")
    box, pts = corners_of(TRUE_REGION, cell=(95, 95))
    cal = V.calibration_from_corners(box, *pts)
    cal_grid = V.Grid(4, 4, cal.inset)
    cal_img = full[cal.region.top:cal.region.bottom, cal.region.left:cal.region.right]
    cal_db = V.TemplateDB()
    cal_rec = V.Recognizer(cal_grid, cal_db)
    cal_rec.learn(cal_grid.crops(cal_img), TRUE_BOARD)
    r = cal_rec.read(cal_img)
    check("學一輪之後全部認得", r.ok and r.cells == TRUE_BOARD,
          f"inset={cal.inset:.3f} 未知 {r.unknown_indices}")
    tightest = min(m.margin for m in r.matches if m.margin != float("inf"))
    check("區隔度沒有因為換 inset 而變差", tightest > 10, f"{tightest:.2f}")

    print("    · 點錯順序要擋下來，而不是算出一個爛範圍")
    box, pts = corners_of(TRUE_REGION)
    for name, bad in (
        ("右上跟左下對調", [pts[2], pts[1], pts[0]]),
        ("三點全部給左上角", [(box.left, box.top)] * 3),
    ):
        try:
            V.calibration_from_corners(box, *bad)
            check(name, False, "沒有擋下來")
        except ValueError as e:
            check(name, "順序" in str(e) or "不合理" in str(e), str(e)[:40])

    print("    · 盤面歪斜時要回報 skew")
    box, pts = corners_of(TRUE_REGION)
    tilted = [(pts[0][0], pts[0][1]), (pts[1][0] + 40, pts[1][1]), pts[2]]
    cal = V.calibration_from_corners(box, *tilted)
    check("點歪一大截 → skew 明顯變大", cal.skew > 10, f"{cal.skew:.1f}")

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
