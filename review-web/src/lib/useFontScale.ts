/**
 * 表格字體大小倍率（記在瀏覽器）。每個表格用自己的 key，互不影響。
 * 倍率限制在 0.8～2.0；壞值或讀不到（私密視窗）一律回預設 1。
 */
import { useCallback, useState } from 'react';

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 2;
export const FONT_SCALE_STEP = 0.1;

const clamp = (v: number) => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(v * 10) / 10));

export function loadFontScale(key: string): number {
  try {
    const v = parseFloat(localStorage.getItem(`review-fs-${key}`) ?? '');
    return Number.isFinite(v) ? clamp(v) : 1;
  } catch {
    return 1;
  }
}

export function useFontScale(key: string): [number, (v: number) => void] {
  const [scale, setScale] = useState(() => loadFontScale(key));
  const set = useCallback((v: number) => {
    const c = clamp(v);
    setScale(c);
    try { localStorage.setItem(`review-fs-${key}`, String(c)); } catch { /* 私密視窗：不記住也能用 */ }
  }, [key]);
  return [scale, set];
}
