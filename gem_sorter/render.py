"""面板預覽的繪圖：把「程式讀到的盤面」與「建議的這一步」畫在擷取畫面上。

獨立成一支只用 PIL 的模組（不碰 tkinter），才能在不開視窗的情況下把預覽存成 PNG 檢查。
"""

from __future__ import annotations

import colorsys
from typing import Dict, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

import vision as V

# 顏色名 → 中文簡稱（給人看；新出現的顏色用 h色相）
COLOR_ZH: Dict[str, str] = {
    "green": "綠", "teal": "青", "blue": "藍", "violet": "藍紫",
    "magenta": "紫", "ruby": "桃紅", "fire": "橘紅", "amber": "琥珀",
}


def color_rgb(name: str, palette: Optional[V.Palette]) -> Tuple[int, int, int]:
    """顏色名 → 畫在預覽上的代表色（用色盤的色相，讓使用者一眼核對「程式把它認成哪一色」）。"""
    if name == V.HIDDEN:
        return (10, 10, 10)
    if name == V.COVERED:
        return (110, 130, 150)
    hue = None
    if palette is not None:
        hue = palette.hues.get(name)
    if hue is None:
        hue = V.DEFAULT_PALETTE.get(name)
    if hue is None and name.startswith("h") and name[1:].isdigit():
        hue = float(name[1:])
    if hue is None:
        return (200, 200, 200)
    r, g, b = colorsys.hsv_to_rgb(hue / 360.0, 0.85, 0.95)
    return int(r * 255), int(g * 255), int(b * 255)


def slot_xy(t: V.TubeState, k: int) -> Tuple[float, float]:
    """第 k 格中心（畫面像素）。TubeState 存的是「第 2 格」的中心 (px, py)。"""
    return t.px, t.py + V.SLOT_PITCH * (1 - k) * t.w


def draw_preview(image: np.ndarray, board: Optional[V.Board], move: Optional[Tuple[int, int]],
                 palette: Optional[V.Palette], width: int, height: int,
                 lifted: bool = False) -> Image.Image:
    """回傳縮進 (width, height) 的預覽圖（等比例、置中）。board 為 None 就只縮圖。"""
    h, w = image.shape[:2]
    scale = min(width / w, height / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    im = Image.fromarray(image).resize((nw, nh), Image.BILINEAR).convert("RGB")
    if board is not None:
        d = ImageDraw.Draw(im)
        for t in board.tubes:
            r = max(3.0, 0.17 * t.w * scale)
            for k, name in enumerate(t.cells):
                cx, cy = slot_xy(t, k)
                cx, cy = cx * scale, cy * scale
                fill = color_rgb(name, palette)
                d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill, outline=(255, 255, 255), width=1)
                if name == V.HIDDEN:
                    d.text((cx - 2, cy - 5), "?", fill=(255, 255, 255))
            if t.kind in ("sealed",):
                cx, cy = t.px * scale, t.py * scale
                d.line((cx - r, cy - r, cx + r, cy + r), fill=(255, 90, 90), width=2)
                d.line((cx - r, cy + r, cx + r, cy - r), fill=(255, 90, 90), width=2)
        if move is not None:
            s, dst = move
            for idx, col in ((s, (255, 70, 70)), (dst, (70, 220, 90))):
                t = board.tubes[idx]
                cx, cy = t.px * scale, t.py * scale
                rr = max(8.0, 0.42 * t.w * scale)
                d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=col, width=3)
            a, b = board.tubes[s], board.tubes[dst]
            d.line((a.px * scale, a.py * scale, b.px * scale, b.py * scale), fill=(255, 220, 60), width=2)
    canvas = Image.new("RGB", (width, height), (18, 20, 26))
    canvas.paste(im, ((width - nw) // 2, (height - nh) // 2))
    return canvas
