/**
 * reportFlags.ts — 把文字裡的國旗 emoji 拆出來（純函式，可單測）。
 *
 * Windows 的 Chrome／Edge 沒有國旗字型，🇹🇼 會被畫成兩個字母「TW」（實測：79 份報告裡 72 份的
 * 「🇹🇼 台股評估與選股邏輯」標題都會中招），看起來像亂碼。Android／iOS／Mac 沒這問題，
 * 但為了各平台一致，統一改用 CSS 畫的小旗（見 reportMarkdown.css 的 .rpt-flag）。
 * 只處理報告實際出現過的台灣與美國；其他旗幟維持原樣（各平台自己的字型決定怎麼顯示）。
 */
export type FlagCode = 'tw' | 'us';

export type TextPart = { text: string } | { flag: FlagCode };

const FLAG_RE = /(🇹🇼|🇺🇸)/u;
const FLAG_OF: Record<string, FlagCode> = { '🇹🇼': 'tw', '🇺🇸': 'us' };

export const FLAG_LABEL: Record<FlagCode, string> = { tw: '台灣', us: '美國' };

export function hasFlag(text: string): boolean {
  return FLAG_RE.test(text);
}

/** 依序切成純文字與旗幟；不含旗幟就回傳單一文字段。 */
export function splitFlags(text: string): TextPart[] {
  const parts: TextPart[] = [];
  for (const piece of text.split(FLAG_RE)) {
    if (piece === '') continue;
    const flag = FLAG_OF[piece];
    parts.push(flag ? { flag } : { text: piece });
  }
  return parts;
}
