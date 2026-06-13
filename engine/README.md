# Finance Engine（Python / FastAPI）

台股**多因子量化 + 回測 + 多 agent**引擎，與既有 Node 內容線（`scripts/puhui_daily.cjs`）並存，只透過 HTTP 溝通。本目錄是「財經 APP 整合計畫」的引擎側；全局見 `../docs/ROADMAP.md`。

## 目錄結構（分層 package）

```
engine/
  app/
    main.py        FastAPI 入口 + 路由註冊
    api/           HTTP 路由（階段1：health；階段6：gateway 端點）
    core/          設定/共用（config, 共用型別）
    data/          數據源 client（階段2：FinMind/富果/yfinance/老王 loader）
    factors/       多因子引擎（階段3：swing/daytrade 雙引擎）
    backtest/      向量化回測（階段3，僅 swing）
    agents/        多 agent LLM 決策（階段5）
  tests/           pytest
  requirements.txt / pyproject.toml
```

## 快速啟動（Windows / PowerShell）

```powershell
cd "C:\CC AI Agent\engine"
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

啟動後：
- 健康檢查：http://127.0.0.1:8000/health
- Swagger：http://127.0.0.1:8000/docs

## Node ↔ Python 串接 demo

引擎起來後，從專案根目錄跑：

```powershell
node scripts/engine_healthcheck.cjs
```

成功會印出 `HTTP 200` + JSON，並顯示「✅ Node ↔ Python 串接成功」。

## 測試

```powershell
cd "C:\CC AI Agent\engine"
.\.venv\Scripts\python -m pytest
```

## 階段對應

| 階段 | 在此目錄的產出 |
|---|---|
| 1 | `/health` 骨架、Node↔Python demo、契約定案 |
| 2 | `app/data/` 數據源 client + 快取 |
| 3 | `app/factors/` 雙引擎 + `app/backtest/` 回測 |
| 5 | `app/agents/` 多 agent |
| 6 | `app/api/` gateway 對接端點 |
