"""重建測試用的盤面圖 `board.png`。

原本的測資是一張真實遊戲截圖，放在 Claude 的暫存圖片快取裡 —— 那個目錄
每傳一張新圖就會覆蓋掉舊的，2026-08-15 果然被蓋掉，測試整片紅。
測資改放進 repo，並且由這支腳本從 `templates.json`（使用者實際標記過的
水果外觀）重新拼出來，這樣任何人 clone 下來都跑得動。

    python testdata/make_board.py

畫的時候要顧到 vision.py 真正依賴的三個特徵，不然 autofit 會吸不準：

  * 每格的圖要填滿整格，格與格之間只留一條細縫。縫留太寬會在邊緣能量上
    變成「一個邊界兩條峰」，_estimate_pitch 的自相關就會被帶偏。
  * 縫必須比格子中心暗。_fit_axis 的相位完全靠「中心亮度 − 格線亮度」決定。
  * 號碼徽章要放在 BADGE_BOX 指到的位置 —— 那個框是相對於「內縮之後的取樣
    範圍」量的，不是相對於整格。放對了不同編號之間才有足夠的區隔度。

每格的圖是樣板裡那張 16x16 縮圖放大，所以顏色與輪廓是真的，只是解析度低。
要做徽章數字辨識那種需要清晰筆畫的工作時，請換一張真截圖。
"""

import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vision as V  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(os.path.dirname(HERE), "templates.json")
OUT = os.path.join(HERE, "board.png")

# 這幾個常數 test_app.py 與 test_vision.py 都寫死了，改這裡要一起改
CANVAS = (560, 560)
REGION = (56, 56, 450, 452)     # left, top, width, height
BOARD = [1, 1, 5, 2, 2, 3, 6, 1, 0, 5, 1, 7, 0, 0, 0, 1]
INSET = 0.10                    # 要跟 Config 的預設值一致
# 每格四邊各留多少 px 當格縫（縫寬 = 2*SEAM）。縫太寬的話，格線位置在
# _fit_axis 的分數上會出現一段「怎麼擺都一樣暗」的平台，相位就會卡在平台邊緣。
SEAM = 2


def cell_thumbs(path):
    """label -> (整格縮圖, 徽章縮圖)，都是 16x16x3。同標籤有多張時取第一張。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for item in data["templates"]:
        lbl = int(item["label"])
        if lbl in out:
            continue
        raw = np.asarray(item["px"], dtype=np.uint8)
        out[lbl] = (raw[:V.BLOCK].reshape(V.THUMB, V.THUMB, 3),
                    raw[V.BLOCK:].reshape(V.THUMB, V.THUMB, 3))
    return out


def digit_font(px):
    """找一個粗體字型畫徽章上的號碼。找不到就退回 PIL 內建點陣字。"""
    for name in ("verdanab.ttf", "tahomabd.ttf", "arialbd.ttf", "calibrib.ttf"):
        try:
            return ImageFont.truetype(os.path.join(r"C:\Windows\Fonts", name), px)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_digit(canvas, box, text, font):
    """在徽章框正中央畫白色號碼。

    真實畫面上這個數字是清晰的白色筆畫，樣板縮圖只有 16px，放大回去糊成一團，
    害得外觀相近的水果（1 號蘋果 vs 2 號橘子）幾乎分不開。把數字重畫清楚，
    測資才有跟真截圖同一個等級的區隔度。
    """
    x0, y0, x1, y1 = box
    im = Image.fromarray(canvas[y0:y1, x0:x1])
    d = ImageDraw.Draw(im)
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    d.text(((x1 - x0 - (r - l)) / 2 - l, (y1 - y0 - (b - t)) / 2 - t),
           text, fill=(255, 255, 255), font=font)
    canvas[y0:y1, x0:x1] = np.asarray(im)


def paste(canvas, thumb, box):
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return
    im = Image.fromarray(thumb).resize((x1 - x0, y1 - y0), Image.BILINEAR)
    canvas[y0:y1, x0:x1] = np.asarray(im)


def main():
    if not os.path.exists(TEMPLATES):
        print(f"找不到樣板庫：{TEMPLATES}\n請先在輔助器裡標記一輪水果。")
        return 1
    thumbs = cell_thumbs(TEMPLATES)
    missing = sorted({v for v in BOARD if v not in thumbs})
    if missing:
        print(f"樣板庫裡缺這些水果：{missing}")
        return 1

    left, top, width, height = REGION
    empty = thumbs[0][0].reshape(-1, 3)
    seam_color = np.percentile(empty, 8, axis=0)        # 空格裡最暗的那一段＝真實格縫的顏色
    canvas = np.zeros((CANVAS[1], CANVAS[0], 3), dtype=np.uint8)
    # 盤面外圍要「不比格縫暗」，用空格的平均色當外框。畫得比格縫暗的話，
    # _fit_axis 會發現「把最外側那兩條格線往外推一點，分數更高」，整個吸偏 6px。
    canvas[:, :] = empty.mean(axis=0).astype(np.uint8)
    # 暗帶要往盤面外多畫 SEAM px。內部每條格縫左右各 SEAM、共 2*SEAM 寬，
    # 最外兩條如果只有內側那一半，_fit_axis 找到的相位就會整體往內縮 3px。
    canvas[top - SEAM:top + height + SEAM, left - SEAM:left + width + SEAM] = seam_color

    cells = V.Grid(4, 4, 0.0).cell_boxes(width, height)   # 整格的邊界
    crops = V.Grid(4, 4, INSET).cell_boxes(width, height)  # 之後真正會被取樣的那一塊
    bl, bt, br, bb = V.BADGE_BOX
    font = digit_font(int((crops[0][3] - crops[0][1]) * (bb - bt) * 0.72))

    for i, ((x0, y0, x1, y1), (cx0, cy0, cx1, cy1)) in enumerate(zip(cells, crops)):
        full, badge = thumbs[BOARD[i]]
        paste(canvas, full, (left + x0 + SEAM, top + y0 + SEAM,
                             left + x1 - SEAM, top + y1 - SEAM))
        # 徽章疊在取樣範圍的 BADGE_BOX 上，讓 raw_feature 的後半段真的吃到數字
        cw, ch = cx1 - cx0, cy1 - cy0
        box = (left + cx0 + int(cw * bl), top + cy0 + int(ch * bt),
               left + cx0 + int(cw * br), top + cy0 + int(ch * bb))
        paste(canvas, badge, box)
        if BOARD[i]:
            draw_digit(canvas, box, str(BOARD[i]), font)

    Image.fromarray(canvas).save(OUT)
    print(f"寫好 {OUT}  {CANVAS[0]}x{CANVAS[1]}  盤面 {BOARD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
