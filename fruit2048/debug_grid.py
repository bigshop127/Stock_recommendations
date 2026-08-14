"""切格對位除錯工具。校準怎麼調都不對的時候用這個看問題出在哪。

    python debug_grid.py <圖檔>                          # 自動吸附整張圖
    python debug_grid.py <圖檔> <left> <top> <w> <h>     # 指定範圍

會輸出兩張圖到 _debug/：
  overlay.png  — 原圖畫上格線，用來確認範圍對不對
  cells.png    — 16 格切出來排成一張，附每格的縮圖特徵
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw

import vision as V

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_debug")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1

    path = argv[1]
    full = Image.open(path).convert("RGB")
    rows = int(argv[6]) if len(argv) > 6 else 4
    cols = int(argv[7]) if len(argv) > 7 else 4
    inset = float(argv[8]) if len(argv) > 8 else 0.10

    if len(argv) >= 6:
        left, top, width, height = (int(x) for x in argv[2:6])
    else:
        fit = V.autofit(np.asarray(full), rows, cols)
        if fit is None:
            print("autofit 失敗，請手動指定範圍")
            return 1
        left, top, width, height = fit
        print(f"autofit → left={left} top={top} width={width} height={height}")

    grid = V.Grid(rows, cols, inset)
    region = np.asarray(full.crop((left, top, left + width, top + height)))
    os.makedirs(OUT_DIR, exist_ok=True)

    # --- overlay：整張圖上標出範圍與每格的取樣區 ---
    over = full.copy()
    d = ImageDraw.Draw(over)
    d.rectangle([left, top, left + width - 1, top + height - 1], outline=(0, 255, 0), width=2)
    for x0, y0, x1, y1 in grid.cell_boxes(width, height):
        d.rectangle([left + x0, top + y0, left + x1, top + y1], outline=(255, 0, 255), width=1)
    over.save(os.path.join(OUT_DIR, "overlay.png"))

    # --- cells：切出來的格子 + 特徵縮圖並排 ---
    crops = grid.crops(region)
    cw = max(c.shape[1] for c in crops)
    ch = max(c.shape[0] for c in crops)
    pad, foot = 6, 44
    sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + pad + foot) + pad), (30, 30, 30))
    sd = ImageDraw.Draw(sheet)
    for i, crop in enumerate(crops):
        r, c = divmod(i, cols)
        x = pad + c * (cw + pad)
        y = pad + r * (ch + pad + foot)
        sheet.paste(Image.fromarray(crop), (x, y))
        raw = V.raw_feature(crop)
        whole = raw[:V.BLOCK].reshape(V.THUMB, V.THUMB, 3)
        badge = raw[V.BLOCK:].reshape(V.THUMB, V.THUMB, 3)
        sheet.paste(Image.fromarray(whole).resize((36, 36), Image.NEAREST), (x, y + ch + 2))
        sheet.paste(Image.fromarray(badge).resize((36, 36), Image.NEAREST), (x + 40, y + ch + 2))
        sd.text((x + 80, y + ch + 14), f"#{i}\nr{r}c{c}", fill=(200, 200, 200))
    sheet.save(os.path.join(OUT_DIR, "cells.png"))

    # --- 兩兩格子的距離：確認不同水果分得開 ---
    vecs = np.stack([V.normalize(V.raw_feature(c)) for c in crops])
    dist = np.abs(vecs[:, None, :] - vecs[None, :, :]).mean(axis=2)
    np.fill_diagonal(dist, 1e9)
    i, j = np.unravel_index(np.argmin(dist), dist.shape)
    print(f"範圍 {width}x{height}，每格取樣 {cw}x{ch}，inset={inset}")
    print(f"最像的兩格是 #{i} 與 #{j}，距離 {dist[i, j]:.1f}")
    print(f"  （如果這兩格其實是同一種水果或都是空格，那很正常；")
    print(f"    如果是不同水果而距離 < {V.DEFAULT_MIN_MARGIN * 2:.0f}，代表切格沒對準）")
    print(f"輸出 → {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
