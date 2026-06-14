"""agent 提示詞載入器（階段5）。

提示詞落地成 `.md`（繁中、吃我們的台股結構化格式），與程式分離方便調校。
`load("technical_analyst")` → 讀同目錄 `technical_analyst.md` 全文當 system prompt。
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_DIR = Path(__file__).parent


@lru_cache(maxsize=None)
def load(name: str) -> str:
    path = _DIR / f"{name}.md"
    return path.read_text(encoding="utf-8").strip()
