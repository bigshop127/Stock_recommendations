"""數據層 live smoke（階段8）——免金鑰公開源即可跑，供 GitHub Actions 無 LLM 備援、
也可本機/VM 手動驗證數據通路是否還活著。

檢查（皆走 FastAPI 真實路徑，非 mock）：
  /health            服務起得來
  /data/book?code=   TWSE MIS 即時五檔（免金鑰）
  /data/market       yfinance 大盤/美股指數（免金鑰）
有 FINMIND_TOKEN 時順帶測 /data/ohlcv（FinMind 日K）。
任一「硬性」檢查失敗 → 退出碼 1（CI 轉紅）。

執行：cd engine && python scripts/smoke_data.py
"""
import os
import sys
from pathlib import Path

# 讓 `python scripts/smoke_data.py` 能匯入 app（把 engine/ 放進 sys.path）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
fails = []


def check(name, ok, info=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  {info}" if info else ""))
    if not ok:
        fails.append(name)


r = client.get("/health")
check("/health 200", r.status_code == 200, r.text[:80])

r = client.get("/data/book", params={"code": "2330"})
check("/data/book TWSE-MIS(2330)", r.status_code == 200, f"status={r.status_code}")

r = client.get("/data/market")
check("/data/market yfinance", r.status_code == 200, f"status={r.status_code}")

if os.getenv("FINMIND_TOKEN"):
    r = client.get("/data/ohlcv", params={"code": "2330"})
    check("/data/ohlcv FinMind(2330)", r.status_code == 200, f"status={r.status_code}")
else:
    print("skip /data/ohlcv（無 FINMIND_TOKEN）")

print("\n" + ("FAILED: " + ", ".join(fails) if fails else "ALL OK"))
sys.exit(1 if fails else 0)
