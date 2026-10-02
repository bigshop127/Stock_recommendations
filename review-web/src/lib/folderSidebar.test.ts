import { describe, it, expect } from 'vitest';
import {
  folderGroup, splitSections, sortableIds, applyFolderDrop, filterFolders, folderForStock, SECTION_HEADER_ID,
} from './folderSidebar';
import type { FolderDef, FolderMap, UserStock } from './userStore';

const st = (code: string, name: string): UserStock => ({ code, name, added_at: '2026-10-02T00:00:00.000Z' });

// 跟正式資料同形狀：舊資料沒有 group 欄位
const LIST: FolderDef[] = [
  { id: 'holdings', label: '我的持股' },
  { id: 'potential', label: '有潛力的' },
  { id: 'fa', label: '被動元件' },
  { id: 'fb', label: '載板三雄' },
  { id: 'fc', label: '封測雙雄' },
];
const STOCKS: FolderMap = {
  holdings: [st('3711', '日月光投控')],
  potential: [st('2454', '聯發科')],
  fa: [st('2327', '國巨*')],
  fb: [st('3037', '欣興'), st('8046', '南電'), st('3189', '景碩')],
  fc: [st('3711', '日月光投控'), st('6239', '力成')],
};

const H_MINE = SECTION_HEADER_ID.mine;
const H_SECTOR = SECTION_HEADER_ID.sector;
const order = (list: FolderDef[] | null) => list?.map((f) => `${f.id}:${f.group}`);

describe('folderGroup / splitSections', () => {
  it('沒有 group 時：持股、潛力算我的清單，其餘算族群', () => {
    expect(LIST.map(folderGroup)).toEqual(['mine', 'mine', 'sector', 'sector', 'sector']);
  });
  it('有寫 group 就照寫的', () => {
    expect(folderGroup({ id: 'holdings', label: 'x', group: 'sector' })).toBe('sector');
    expect(folderGroup({ id: 'fa', label: 'x', group: 'mine' })).toBe('mine');
  });
  it('分區內維持原本順序，陣列裡穿插也會歸位', () => {
    const mixed: FolderDef[] = [LIST[2], LIST[0], LIST[3], LIST[1]];
    const s = splitSections(mixed);
    expect(s.mine.map((f) => f.id)).toEqual(['holdings', 'potential']);
    expect(s.sector.map((f) => f.id)).toEqual(['fa', 'fb']);
    expect(sortableIds(mixed)).toEqual([H_MINE, 'holdings', 'potential', H_SECTOR, 'fa', 'fb']);
  });
});

describe('applyFolderDrop', () => {
  it('同區內往下拖', () => {
    expect(order(applyFolderDrop(LIST, 'fa', 'fc'))).toEqual([
      'holdings:mine', 'potential:mine', 'fb:sector', 'fc:sector', 'fa:sector',
    ]);
  });
  it('同區內往上拖', () => {
    expect(order(applyFolderDrop(LIST, 'fc', 'fa'))).toEqual([
      'holdings:mine', 'potential:mine', 'fc:sector', 'fa:sector', 'fb:sector',
    ]);
  });
  it('從族群拖到族群標頭上 → 變成我的清單最後一個', () => {
    expect(order(applyFolderDrop(LIST, 'fb', H_SECTOR))).toEqual([
      'holdings:mine', 'potential:mine', 'fb:mine', 'fa:sector', 'fc:sector',
    ]);
  });
  it('從我的清單往下拖到族群標頭 → 變成族群第一個', () => {
    expect(order(applyFolderDrop(LIST, 'potential', H_SECTOR))).toEqual([
      'holdings:mine', 'potential:sector', 'fa:sector', 'fb:sector', 'fc:sector',
    ]);
  });
  it('拖到我的清單標頭上（最上面）也算我的清單', () => {
    expect(order(applyFolderDrop(LIST, 'fc', H_MINE))).toEqual([
      'fc:mine', 'holdings:mine', 'potential:mine', 'fa:sector', 'fb:sector',
    ]);
  });
  it('原地放下、拖標頭、不認得的 id → null', () => {
    expect(applyFolderDrop(LIST, 'fa', 'fa')).toBeNull();
    expect(applyFolderDrop(LIST, H_SECTOR, 'fa')).toBeNull();
    expect(applyFolderDrop(LIST, 'nope', 'fa')).toBeNull();
    expect(applyFolderDrop(LIST, 'fa', 'nope')).toBeNull();
  });
  it('最後一個我的清單拖到族群標頭 → 分區改了，不是 null', () => {
    const r = applyFolderDrop(LIST, 'potential', H_SECTOR);
    expect(r).not.toBeNull();
  });
  it('不會弄丟或複製資料夾，label 保留', () => {
    const r = applyFolderDrop(LIST, 'holdings', 'fc')!;
    expect(r.map((f) => f.id).sort()).toEqual(LIST.map((f) => f.id).sort());
    expect(r.find((f) => f.id === 'holdings')!.label).toBe('我的持股');
  });
});

describe('filterFolders', () => {
  it('空字串不篩選', () => {
    expect(filterFolders(LIST, STOCKS, '  ')).toBeNull();
  });
  it('資料夾名稱符合 → 整個資料夾的股票都列', () => {
    const r = filterFolders(LIST, STOCKS, '三雄')!;
    expect([...r.keys()]).toEqual(['fb']);
    expect(r.get('fb')!.map((s) => s.code)).toEqual(['3037', '8046', '3189']);
  });
  it('股名符合 → 只列那幾檔，出現在每個有它的資料夾', () => {
    const r = filterFolders(LIST, STOCKS, '日月光')!;
    expect([...r.keys()]).toEqual(['holdings', 'fc']);
    expect(r.get('fc')!.map((s) => s.code)).toEqual(['3711']);
  });
  it('代號也能查', () => {
    const r = filterFolders(LIST, STOCKS, '8046')!;
    expect([...r.keys()]).toEqual(['fb']);
    expect(r.get('fb')!.map((s) => s.name)).toEqual(['南電']);
  });
  it('英文不分大小寫', () => {
    const list: FolderDef[] = [{ id: 'x', label: 'CCL三雄' }];
    expect(filterFolders(list, { x: [] }, 'ccl')!.has('x')).toBe(true);
  });
  it('都不符合 → 空的 Map（不是 null）', () => {
    expect(filterFolders(LIST, STOCKS, '台塑')!.size).toBe(0);
  });
});

describe('folderForStock', () => {
  it('目前展開的已經有這檔 → 不動', () => {
    expect(folderForStock(LIST, STOCKS, '3711', 'fc')).toBe('fc');
  });
  it('目前展開的沒有 → 挑畫面上第一個有的（我的清單優先）', () => {
    expect(folderForStock(LIST, STOCKS, '3711', 'fb')).toBe('holdings');
    expect(folderForStock(LIST, STOCKS, '8046', null)).toBe('fb');
  });
  it('依畫面順序，不是陣列順序', () => {
    const list: FolderDef[] = [{ id: 'fc', label: '封測雙雄' }, { id: 'holdings', label: '我的持股' }];
    expect(folderForStock(list, STOCKS, '3711', null)).toBe('holdings');
  });
  it('哪裡都沒有 → null', () => {
    expect(folderForStock(LIST, STOCKS, '9999', 'fb')).toBeNull();
  });
  it('展開中的資料夾已被刪掉 → 重新找', () => {
    expect(folderForStock(LIST, STOCKS, '6239', 'deleted')).toBe('fc');
  });
});
