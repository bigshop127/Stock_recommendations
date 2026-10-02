import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  Trash2,
  Plus,
  X,
  MoreHorizontal,
  Pencil,
  Check,
  Search,
  LayoutDashboard,
  ArrowRightLeft,
} from 'lucide-react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DraggableSyntheticListeners } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  getFolders,
  getFolderList,
  removeFromFolder,
  subscribeFolders,
  moveStock,
  addToFolder,
  addFolder,
  renameFolder,
  deleteFolder,
  setFolderGroup,
  reorderFolders,
} from '../lib/userStore';
import type { FolderDef, FolderGroup, FolderId, UserStock } from '../lib/userStore';
import {
  SECTIONS,
  SECTION_HEADER_ID,
  applyFolderDrop,
  filterFolders,
  folderForStock,
  folderGroup,
  sortableIds,
  splitSections,
} from '../lib/folderSidebar';
import { SymbolSearch } from './SymbolSearch';

const OPEN_KEY = 'review:folders:open';

/** 分區標頭：不能拖，但留在拖曳清單裡讓位，放下時用來判斷落在哪一區。 */
const SectionHeader: React.FC<{ group: FolderGroup; label: string; onAdd: () => void }> = ({ group, label, onAdd }) => {
  const { setNodeRef, transform, transition } = useSortable({
    id: SECTION_HEADER_ID[group],
    disabled: { draggable: true, droppable: false },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="group/section flex items-center justify-between px-1.5 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-zinc-600"
    >
      <span>{label}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 md:opacity-0 md:group-hover/section:opacity-100 transition-opacity"
        title={`在「${label}」新增資料夾`}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
};

/** 可拖曳的資料夾外框；拖曳把手（listeners）交給子元件掛在標頭列上，展開的股票清單不吃拖曳。 */
const SortableFolder: React.FC<{
  id: string;
  disabled: boolean;
  children: (listeners: DraggableSyntheticListeners, isDragging: boolean) => React.ReactNode;
}> = ({ id, disabled, children }) => {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-20 opacity-80' : undefined}
    >
      {children(listeners, isDragging)}
    </div>
  );
};

/**
 * 「個股多維度審查」底下的資料夾區（2026-10-02 改版）：
 * 分「我的清單／族群分類」兩區、每個資料夾一行、一次只展開一個（打開個股時自動展開它所在的資料夾）、
 * 頂部篩選框、拖曳排序（桌機按住拖、手機長按 0.3 秒再拖）。資料夾操作收進「⋯」選單。
 */
export const FolderSidebar: React.FC<{ activeCode: string | null }> = ({ activeCode }) => {
  const [folders, setFolders] = useState(() => getFolders());
  const [folderList, setFolderList] = useState(() => getFolderList());
  const [openId, setOpenId] = useState<FolderId | null>(() => localStorage.getItem(OPEN_KEY));
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [menuFolderId, setMenuFolderId] = useState<FolderId | null>(null);
  const [activeSearchFolder, setActiveSearchFolder] = useState<FolderId | null>(null);
  const [activeDropdownStock, setActiveDropdownStock] = useState<{ folderId: FolderId; code: string } | null>(null);
  const [addingGroup, setAddingGroup] = useState<FolderGroup | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<FolderId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 拖曳放開時滑鼠還停在標頭上，瀏覽器會緊接著補送一次 click——這次點擊不算展開／收合。
  // click 在 mouseup 之後同一輪就派送，setTimeout(0) 一定排在它後面才清旗標。
  const justDraggedRef = useRef(false);
  const markDragEnded = () => {
    justDraggedRef.current = true;
    setTimeout(() => { justDraggedRef.current = false; }, 0);
  };

  useEffect(() => subscribeFolders(() => {
    setFolders(getFolders());
    setFolderList(getFolderList());
  }), []);

  useEffect(() => {
    if (openId) localStorage.setItem(OPEN_KEY, openId);
    else localStorage.removeItem(OPEN_KEY);
  }, [openId]);

  useEffect(() => {
    const close = () => {
      setMenuFolderId(null);
      setActiveDropdownStock(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // 換到另一檔個股時，自動展開它所在的資料夾（每檔只自動一次，之後使用者手動收起就尊重）。
  // 雲端資料晚到時這檔還沒找到資料夾，就等資料到了再試。
  if (!activeCode && autoOpenedFor !== null) {
    setAutoOpenedFor(null);
  } else if (activeCode && autoOpenedFor !== activeCode) {
    const target = folderForStock(folderList, folders, activeCode, openId);
    if (target) {
      setAutoOpenedFor(activeCode);
      if (target !== openId) setOpenId(target);
    }
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );

  const filter = filterFolders(folderList, folders, query);
  const dragDisabled = filter !== null || renamingFolderId !== null;
  const sections = splitSections(folderList);

  const toggleFolder = (id: FolderId) => {
    if (justDraggedRef.current) return;
    setOpenId((cur) => (cur === id ? null : id));
  };

  const handleDragEnd = (e: DragEndEvent) => {
    markDragEnded();
    if (!e.over) return;
    const next = applyFolderDrop(folderList, String(e.active.id), String(e.over.id));
    if (next) reorderFolders(next);
  };

  const submitNewFolder = () => {
    const label = newFolderName.trim();
    if (label && addingGroup) setOpenId(addFolder(label, addingGroup));
    setNewFolderName('');
    setAddingGroup(null);
  };

  const submitRename = (id: FolderId) => {
    const label = renameValue.trim();
    if (label) renameFolder(id, label);
    setRenamingFolderId(null);
    setRenameValue('');
  };

  const handleDeleteFolder = (f: FolderDef) => {
    const count = (folders[f.id] || []).length;
    const msg = count > 0
      ? `確定要刪除資料夾「${f.label}」嗎？裡面的 ${count} 檔個股會一併移除。`
      : `確定要刪除資料夾「${f.label}」嗎？`;
    if (!window.confirm(msg)) return;
    const ok = deleteFolder(f.id);
    if (!ok) window.alert('至少要保留一個資料夾，無法刪除最後一個。');
  };

  const menuItem = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800/80 transition-colors';

  const renderFolderMenu = (f: FolderDef) => {
    const other: FolderGroup = folderGroup(f) === 'mine' ? 'sector' : 'mine';
    const otherLabel = SECTIONS.find((s) => s.group === other)!.label;
    return (
      // 不擋 click 冒泡：點任一項本來就要關選單（window 的 click 會關），
      // 「卡片牆檢視」也要讓 Layout 收起手機選單
      <div className="absolute right-0 top-full mt-1 z-50 w-40 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1 text-[11px] font-normal">
        <button
          className={menuItem}
          onClick={() => { setActiveSearchFolder(f.id); setOpenId(f.id); setMenuFolderId(null); }}
        >
          <Plus className="w-3.5 h-3.5 text-zinc-500" /> 加入個股
        </button>
        <Link to={`/folders?f=${encodeURIComponent(f.id)}`} className={menuItem} onClick={() => setMenuFolderId(null)}>
          <LayoutDashboard className="w-3.5 h-3.5 text-zinc-500" /> 卡片牆檢視
        </Link>
        <button
          className={menuItem}
          onClick={() => { setRenamingFolderId(f.id); setRenameValue(f.label); setMenuFolderId(null); }}
        >
          <Pencil className="w-3.5 h-3.5 text-zinc-500" /> 重新命名
        </button>
        <button
          className={menuItem}
          onClick={() => { setFolderGroup(f.id, other); setMenuFolderId(null); }}
        >
          <ArrowRightLeft className="w-3.5 h-3.5 text-zinc-500" /> 移到「{otherLabel}」
        </button>
        <div className="my-1 border-t border-zinc-800" />
        <button
          className={`${menuItem} text-red-400 hover:text-red-300`}
          onClick={() => { setMenuFolderId(null); handleDeleteFolder(f); }}
        >
          <Trash2 className="w-3.5 h-3.5" /> 刪除資料夾
        </button>
      </div>
    );
  };

  const renderStockRow = (f: FolderDef, stock: UserStock) => {
    const isStockActive = activeCode === stock.code;
    const dropdownOpen = activeDropdownStock?.code === stock.code && activeDropdownStock?.folderId === f.id;
    return (
      <div
        key={stock.code}
        className={`group flex items-center justify-between rounded px-2 py-1 text-xs transition-all duration-150 ${
          isStockActive
            ? 'bg-primary/10 text-primary border border-primary/20 shadow-sm font-medium'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/30 border border-transparent'
        }`}
      >
        <Link to={`/stock/${stock.code}`} className="flex-1 truncate mr-2">
          {stock.name ? `${stock.name} ${stock.code}` : stock.code}
        </Link>
        <div className="flex items-center">
          {/* 移動至其他資料夾 */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuFolderId(null);
                setActiveDropdownStock(dropdownOpen ? null : { folderId: f.id, code: stock.code });
              }}
              className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 p-0.5 rounded transition-all duration-150 mr-1"
              title="移動至其他資料夾"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {dropdownOpen && (
              <div
                className="absolute right-0 top-6 z-50 bg-zinc-900 border border-zinc-800 rounded shadow-xl py-1 w-44 text-[11px]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-zinc-500 font-semibold border-b border-zinc-800">
                  移動至（單選）：
                </div>
                {folderList.filter((dest) => dest.id !== f.id).map((dest) => (
                  <button
                    key={dest.id}
                    onClick={() => {
                      moveStock(f.id, dest.id, stock.code);
                      setActiveDropdownStock(null);
                    }}
                    className="w-full text-left px-2 py-1 hover:bg-primary/20 hover:text-primary transition-colors text-zinc-300"
                  >
                    {dest.label}
                  </button>
                ))}
                <div className="px-2 py-1 text-zinc-500 font-semibold border-t border-b border-zinc-800 mt-1">
                  同時加入（可複選）：
                </div>
                {folderList.filter((dest) => dest.id !== f.id).map((dest) => {
                  const checked = (folders[dest.id] || []).some((s) => s.code === stock.code);
                  return (
                    <button
                      key={`copy-${dest.id}`}
                      onClick={() => {
                        if (checked) removeFromFolder(dest.id, stock.code);
                        else addToFolder(dest.id, { code: stock.code, name: stock.name, added_at: new Date().toISOString() });
                      }}
                      className="w-full flex items-center justify-between px-2 py-1 hover:bg-zinc-800/60 text-left text-zinc-300 transition-colors"
                    >
                      <span className="truncate">{dest.label}</span>
                      <span className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-zinc-600'}`}>
                        {checked && <Check className="w-2.5 h-2.5 text-white" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {/* 移除 */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (window.confirm(`確定要將 ${stock.name || stock.code} 從「${f.label}」移除嗎？`)) {
                removeFromFolder(f.id, stock.code);
              }
            }}
            className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 p-0.5 rounded transition-all duration-150"
            title={`自 ${f.label} 移除`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  const renderFolder = (f: FolderDef, listeners: DraggableSyntheticListeners, isDragging: boolean) => {
    const allStocks = folders[f.id] || [];
    const shownStocks = filter ? filter.get(f.id) || [] : allStocks;
    const isOpen = filter ? true : openId === f.id;
    const isRenaming = renamingFolderId === f.id;
    const hasActive = !!activeCode && allStocks.some((s) => s.code === activeCode);

    return (
      <div>
        {/* 資料夾標頭（一行：箭頭＋名稱＋檔數＋⋯） */}
        <div
          {...(isRenaming ? {} : listeners)}
          className={`group/folder relative flex items-center gap-1 rounded px-1.5 py-1.5 text-xs select-none transition-colors ${
            isDragging ? 'bg-zinc-800 shadow-lg' : 'hover:bg-zinc-800/30'
          } ${isOpen ? 'text-zinc-200' : 'text-zinc-400 hover:text-zinc-200'}`}
          style={{ WebkitTouchCallout: 'none' }}
        >
          {isRenaming ? (
            <div className="flex-1 flex items-center gap-1">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename(f.id);
                  if (e.key === 'Escape') setRenamingFolderId(null);
                }}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200"
              />
              <button onClick={() => submitRename(f.id)} className="text-zinc-400 hover:text-zinc-200 p-0.5">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setRenamingFolderId(null)} className="text-zinc-500 hover:text-zinc-300 p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => toggleFolder(f.id)}
                className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                title={f.label}
              >
                <ChevronRight
                  className={`w-3 h-3 shrink-0 text-zinc-500 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                />
                <span className={`truncate ${isOpen ? 'font-semibold' : ''}`}>{f.label}</span>
                {hasActive && !isOpen && (
                  <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="目前看的個股在這個資料夾" />
                )}
              </button>
              <span className="text-[10px] tabular-nums text-zinc-600 shrink-0">
                {filter && shownStocks.length !== allStocks.length ? `${shownStocks.length}/${allStocks.length}` : allStocks.length}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveDropdownStock(null);
                  setMenuFolderId(menuFolderId === f.id ? null : f.id);
                }}
                className={`p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 shrink-0 transition-opacity ${
                  menuFolderId === f.id ? '' : 'md:opacity-0 md:group-hover/folder:opacity-100'
                }`}
                title="資料夾選項"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {menuFolderId === f.id && renderFolderMenu(f)}
            </>
          )}
        </div>

        {/* 資料夾內搜尋框（從 ⋯ →「加入個股」打開） */}
        {activeSearchFolder === f.id && (
          <div className="p-2 bg-zinc-900/50 rounded border border-zinc-800/80 my-1 mx-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-zinc-500 font-semibold">搜尋股票加入 {f.label}</span>
              <button onClick={() => setActiveSearchFolder(null)} className="text-zinc-500 hover:text-zinc-300">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <SymbolSearch
              autoFocus
              onPick={(hit) => {
                addToFolder(f.id, { code: hit.code, name: hit.name, added_at: new Date().toISOString() });
                setActiveSearchFolder(null);
              }}
            />
          </div>
        )}

        {/* 資料夾內個股 */}
        {isOpen && (
          <div className="pl-4 pb-1 space-y-0.5">
            {shownStocks.length === 0 ? (
              <div className="py-1 px-2 text-[11px] text-zinc-600 italic">尚無個股（從 ⋯ →「加入個股」）</div>
            ) : (
              shownStocks.map((stock) => renderStockRow(f, stock))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ml-4 pl-2 border-l border-zinc-800/80 mt-1 space-y-0.5">
      {/* 頂部篩選框 */}
      <div className="relative px-0.5 pb-1">
        <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2 -mt-0.5 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder="篩選資料夾或個股…"
          className="w-full bg-zinc-900/60 border border-zinc-800 rounded-md pl-7 pr-7 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 -mt-0.5 text-zinc-500 hover:text-zinc-300"
            title="清除篩選"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {filter && filter.size === 0 && (
        <div className="px-2 py-2 text-[11px] text-zinc-600">沒有符合「{query.trim()}」的資料夾或個股</div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => { setMenuFolderId(null); setActiveDropdownStock(null); }}
        onDragEnd={handleDragEnd}
        onDragCancel={markDragEnded}
      >
        <SortableContext items={sortableIds(folderList)} strategy={verticalListSortingStrategy}>
          {SECTIONS.map((sec) => {
            const list = filter ? sections[sec.group].filter((f) => filter.has(f.id)) : sections[sec.group];
            if (filter && list.length === 0) return null;
            return (
              <React.Fragment key={sec.group}>
                <SectionHeader
                  group={sec.group}
                  label={sec.label}
                  onAdd={() => { setAddingGroup(sec.group); setNewFolderName(''); }}
                />
                {addingGroup === sec.group && (
                  <div className="flex items-center gap-1 py-1 px-1.5">
                    <input
                      autoFocus
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitNewFolder();
                        if (e.key === 'Escape') { setAddingGroup(null); setNewFolderName(''); }
                      }}
                      placeholder={`新資料夾名稱（${sec.label}）`}
                      className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                    />
                    <button onClick={submitNewFolder} className="text-zinc-400 hover:text-zinc-200 p-0.5">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => { setAddingGroup(null); setNewFolderName(''); }} className="text-zinc-500 hover:text-zinc-300 p-0.5">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {list.length === 0 && addingGroup !== sec.group && (
                  <div className="px-2 py-1 text-[11px] text-zinc-600 italic">
                    還沒有資料夾（點標頭的 + 新增，或把資料夾拖過來）
                  </div>
                )}
                {list.map((f) => (
                  <SortableFolder key={f.id} id={f.id} disabled={dragDisabled}>
                    {(listeners, isDragging) => renderFolder(f, listeners, isDragging)}
                  </SortableFolder>
                ))}
              </React.Fragment>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
};
