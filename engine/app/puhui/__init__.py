"""老王情報層（階段 4）— 唯讀消費 `reports/**/*.md`。

phase4 盤點修正：舊提示詞與 ROADMAP §0 寫的 `data/puhui_analysis/*.json`
**從未存在、且被 gitignore**。真實獨家資產是 git 追蹤的 `reports/**/*.md`（每日老王報告原文，
固定模板）。本層即是「舊提示詞口中那個不存在 JSON 的真正產生者」：
確定性 Markdown 解析器（無 LLM）→ 結構化老王情報 → 餵階段3 情緒因子 + 融合訊號 + 觀察清單。

子模組：
- `mapping`：emoji 色碼（🔴看多/🟠觀察/🟢看空，**語意與股市相反**）+ 操作建議關鍵詞 → signal/score。
- `parser`：純函式解析器，吃報告原文，吐 PuhuiDaily（雙模板：新版 span/emoji、舊版單表格）。
- `repo`：檔案索引 / 落地快取 / name↔code 反查 / 缺當日報告 fallback。
- `blend`：量化 × 老王 融合（衝突標記、信心調整、water_level × regime 取較嚴）。
- `watchlist`：自動觀察清單（波段/當沖雙分數雙排序）。

對 Node 既有產物**唯讀**：不寫 `reports/`、不碰 `puhui_cache.json`、不動 `puhui_daily.cjs`。
"""
