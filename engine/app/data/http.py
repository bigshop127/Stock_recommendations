"""對外 REST 共用工具：retry + 逾時（FinMind / 富果 共用）。

頻率限制（429）與暫時性錯誤（5xx / 連線逾時）→ 指數退避重試；
其餘 4xx（金鑰錯、找不到）→ 直接拋出明確錯誤，不重試。
"""
from __future__ import annotations

import requests
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import settings

_session = requests.Session()


class TransientHTTPError(Exception):
    """可重試的暫時性錯誤（429 / 5xx）。"""


class DataSourceError(RuntimeError):
    """數據源回傳的不可重試錯誤（金鑰、參數、找不到資料）。"""


def _should_retry_status(code: int) -> bool:
    return code == 429 or 500 <= code < 600


_RETRY = dict(
    retry=retry_if_exception_type((TransientHTTPError, requests.ConnectionError, requests.Timeout)),
    wait=wait_exponential(multiplier=1, min=1, max=20),
    stop=stop_after_attempt(settings.http_max_retry),
    reraise=True,
)


def _check(resp: requests.Response, url: str) -> None:
    if _should_retry_status(resp.status_code):
        raise TransientHTTPError(f"{resp.status_code} from {url}")
    if resp.status_code >= 400:
        raise DataSourceError(f"HTTP {resp.status_code} from {url}: {resp.text[:300]}")


@retry(**_RETRY)
def get_json(url: str, *, params: dict | None = None, headers: dict | None = None) -> dict | list:
    """GET → JSON，含 retry。429/5xx 重試；其他錯誤拋 DataSourceError。"""
    resp = _session.get(url, params=params, headers=headers, timeout=settings.http_timeout)
    _check(resp, url)
    return resp.json()


@retry(**_RETRY)
def get_text(
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    encoding: str | None = None,
) -> str:
    """GET → 純文字（RSS / HTML / CSV）。`encoding` 可強制（如 TAIFEX 的 big5）。"""
    resp = _session.get(url, params=params, headers=headers, timeout=settings.http_timeout)
    _check(resp, url)
    if encoding:
        resp.encoding = encoding
    return resp.text


@retry(**_RETRY)
def post_text(
    url: str,
    *,
    data: dict | None = None,
    headers: dict | None = None,
    encoding: str | None = None,
) -> str:
    """POST 表單 → 純文字（TAIFEX 下載 CSV 走 POST）。`encoding` 可強制 big5。"""
    resp = _session.post(url, data=data, headers=headers, timeout=settings.http_timeout)
    _check(resp, url)
    if encoding:
        resp.encoding = encoding
    return resp.text
