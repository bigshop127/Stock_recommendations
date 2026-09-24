import { describe, it, expect } from 'vitest';
import { hasFlag, splitFlags } from './reportFlags';

describe('reportFlags', () => {
  it('把台灣／美國旗拆出來，其餘文字保留', () => {
    expect(splitFlags('🇹🇼 台股評估')).toEqual([{ flag: 'tw' }, { text: ' 台股評估' }]);
    expect(splitFlags('美股🇺🇸與台股🇹🇼')).toEqual([{ text: '美股' }, { flag: 'us' }, { text: '與台股' }, { flag: 'tw' }]);
  });
  it('沒有旗幟就是單一文字段；其他國旗維持原樣', () => {
    expect(splitFlags('大盤與美股觀察')).toEqual([{ text: '大盤與美股觀察' }]);
    expect(splitFlags('🇳🇴 挪威')).toEqual([{ text: '🇳🇴 挪威' }]);
    expect(hasFlag('🇹🇼')).toBe(true);
    expect(hasFlag('🇳🇴')).toBe(false);
  });
});
