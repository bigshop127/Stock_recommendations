import React, { useEffect, useRef, useState } from 'react';
import { FolderPlus, Check } from 'lucide-react';
import { getFolders, getFolderList, subscribeFolders, addToFolder, removeFromFolder } from '../lib/userStore';
import type { FolderId } from '../lib/userStore';

interface FolderPickerButtonProps {
  code: string;
  name: string;
}

/** 個股頁按鈕：點開可複選要把這檔股票加入／移出哪些資料夾（跟側邊欄資料夾雲端同步）。 */
export const FolderPickerButton: React.FC<FolderPickerButtonProps> = ({ code, name }) => {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState(() => getFolders());
  const [folderList, setFolderList] = useState(() => getFolderList());
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeFolders(() => {
    setFolders(getFolders());
    setFolderList(getFolderList());
  }), []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [open]);

  const isIn = (id: FolderId) => (folders[id] || []).some((s) => s.code === code);
  const toggle = (id: FolderId) => {
    if (isIn(id)) removeFromFolder(id, code);
    else addToFolder(id, { code, name, added_at: new Date().toISOString() });
  };
  const memberCount = folderList.filter((f) => isIn(f.id)).length;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors duration-150 ${
          memberCount > 0
            ? 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20'
            : 'bg-zinc-800 text-zinc-300 border-border hover:bg-zinc-700'
        }`}
        title="加入資料夾"
      >
        <FolderPlus className="w-3.5 h-3.5" />
        {memberCount > 0 ? `已加入 ${memberCount} 個資料夾` : '加入資料夾'}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl py-1 w-52 text-xs">
          <div className="px-3 py-1.5 text-zinc-500 font-semibold border-b border-zinc-800">
            加入資料夾（可複選）
          </div>
          {folderList.map((f) => {
            const checked = isIn(f.id);
            return (
              <button
                key={f.id}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(f.id); }}
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-zinc-800/60 text-left text-zinc-300 transition-colors"
              >
                <span className="truncate">{f.label}</span>
                <span className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'border-zinc-600'}`}>
                  {checked && <Check className="w-3 h-3 text-white" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
