// 「個股多維度審查」側邊欄資料夾的純邏輯（2026-10-02 手風琴改版）：分區、拖曳排序、篩選、自動展開。
// 抽出來是為了能單元測試；畫面在 components/FolderSidebar.tsx。
import type { FolderDef, FolderGroup, FolderId, FolderMap, UserStock } from './userStore';

/** 舊資料沒有 group 欄位時，這兩個內建資料夾算「我的清單」，其餘都算「族群分類」。 */
const PERSONAL_FOLDER_IDS = new Set(['holdings', 'potential']);

export const SECTIONS: { group: FolderGroup; label: string }[] = [
  { group: 'mine', label: '我的清單' },
  { group: 'sector', label: '族群分類' },
];

/**
 * 分區標頭也放進拖曳清單（不能拖、但會跟著讓位），放下後依「在哪個標頭底下」決定分區——
 * 這樣拖過分區交界時，畫面上看到的位置就是放下後的位置。
 * 前綴帶冒號，資料夾 id 只會是 [a-z0-9_-]，不會撞名。
 */
export const SECTION_HEADER_ID: Record<FolderGroup, string> = {
  mine: 'section:mine',
  sector: 'section:sector',
};

export function folderGroup(f: FolderDef): FolderGroup {
  if (f.group === 'mine' || f.group === 'sector') return f.group;
  return PERSONAL_FOLDER_IDS.has(f.id) ? 'mine' : 'sector';
}

/** 依分區拆開，各區內維持原本陣列順序。 */
export function splitSections(list: FolderDef[]): Record<FolderGroup, FolderDef[]> {
  return {
    mine: list.filter((f) => folderGroup(f) === 'mine'),
    sector: list.filter((f) => folderGroup(f) === 'sector'),
  };
}

/** 畫面由上而下的順序（我的清單在前），也是自動展開時找資料夾的優先順序。 */
export function orderedFolders(list: FolderDef[]): FolderDef[] {
  const s = splitSections(list);
  return [...s.mine, ...s.sector];
}

/** 拖曳清單的完整項目順序：標頭＋該區資料夾。 */
export function sortableIds(list: FolderDef[]): string[] {
  const s = splitSections(list);
  return [
    SECTION_HEADER_ID.mine, ...s.mine.map((f) => f.id),
    SECTION_HEADER_ID.sector, ...s.sector.map((f) => f.id),
  ];
}

/**
 * 拖曳放下：把 activeId 移到 overId 的位置，回傳新的資料夾陣列（每個都寫明 group）。
 * 沒有實際變動（原地放下、拖標頭、id 不認得）回傳 null。
 */
export function applyFolderDrop(list: FolderDef[], activeId: string, overId: string): FolderDef[] | null {
  const ids = sortableIds(list);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  if (activeId === SECTION_HEADER_ID.mine || activeId === SECTION_HEADER_ID.sector) return null;

  const moved = [...ids];
  moved.splice(to, 0, moved.splice(from, 1)[0]);

  const byId = new Map(list.map((f) => [f.id, f]));
  const next: FolderDef[] = [];
  // 拖到「我的清單」標頭上方（第一格）的也算我的清單
  let group: FolderGroup = 'mine';
  for (const id of moved) {
    if (id === SECTION_HEADER_ID.mine) { group = 'mine'; continue; }
    if (id === SECTION_HEADER_ID.sector) { group = 'sector'; continue; }
    const f = byId.get(id);
    if (f) next.push({ ...f, group });
  }

  const before = orderedFolders(list);
  const same = before.length === next.length
    && before.every((f, i) => f.id === next[i].id && folderGroup(f) === next[i].group);
  return same ? null : next;
}

function matchStock(s: UserStock, q: string): boolean {
  return s.code.toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q);
}

/**
 * 頂部篩選：資料夾名稱符合 → 整個資料夾的股票都列；否則只列名稱／代號符合的股票。
 * 回傳 資料夾 id → 要顯示的股票；沒輸入字回傳 null（代表不篩選）。
 */
export function filterFolders(list: FolderDef[], stocks: FolderMap, query: string): Map<FolderId, UserStock[]> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const out = new Map<FolderId, UserStock[]>();
  for (const f of list) {
    const all = stocks[f.id] || [];
    if (f.label.toLowerCase().includes(q)) {
      out.set(f.id, all);
      continue;
    }
    const hit = all.filter((s) => matchStock(s, q));
    if (hit.length > 0) out.set(f.id, hit);
  }
  return out;
}

/**
 * 打開某檔個股時要展開哪個資料夾：目前展開的已經包含它就不動，
 * 否則挑畫面上第一個包含它的；哪個資料夾都沒有就回傳 null（維持原狀）。
 */
export function folderForStock(list: FolderDef[], stocks: FolderMap, code: string, currentOpen: FolderId | null): FolderId | null {
  const has = (id: FolderId) => (stocks[id] || []).some((s) => s.code === code);
  if (currentOpen && list.some((f) => f.id === currentOpen) && has(currentOpen)) return currentOpen;
  const hit = orderedFolders(list).find((f) => has(f.id));
  return hit ? hit.id : null;
}
