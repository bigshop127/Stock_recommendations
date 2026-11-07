import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { _resetStockNameCache, lookupStockName, looksLikeCode, pickName } from './stockNames';

describe('pickName', () => {
  it('只收代號完全相符的那一筆', () => {
    const hits = [{ code: '23080', name: '別檔' }, { code: '2308', name: '台達電' }];
    expect(pickName('2308', hits)).toBe('台達電');
  });
  it('ETF 代號大小寫不敏感', () => {
    expect(pickName('00631l', [{ code: '00631L', name: '元大台灣50正2' }])).toBe('元大台灣50正2');
  });
  it('只有前綴相符 → null', () => {
    expect(pickName('230', [{ code: '2308', name: '台達電' }])).toBeNull();
  });
  it('空資料或名稱是空字串 → null', () => {
    expect(pickName('2308', [])).toBeNull();
    expect(pickName('2308', null)).toBeNull();
    expect(pickName('2308', [{ code: '2308', name: '  ' }])).toBeNull();
    expect(pickName('', [{ code: '', name: 'x' }])).toBeNull();
  });
});

describe('looksLikeCode', () => {
  it('台股／ETF 代號', () => {
    for (const c of ['2330', '00631L', '00981A', '6274', ' 8358 ']) expect(looksLikeCode(c)).toBe(true);
  });
  it('不像代號就不查', () => {
    for (const c of ['', '台積', '23', 'AAPL', '2330 ABC', '1234567']) expect(looksLikeCode(c)).toBe(false);
  });
});

describe('lookupStockName', () => {
  beforeEach(() => { _resetStockNameCache(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const ok = (results: { code: string; name: string }[], degraded?: boolean) =>
    ({ query: '', count: results.length, results, source: 't', ...(degraded ? { degraded } : {}) });

  it('查到就回名稱，同一代號第二次不再打 API', async () => {
    const spy = vi.spyOn(api, 'symbolSearch').mockResolvedValue(ok([{ code: '3037', name: '欣興' }]));
    expect(await lookupStockName('3037')).toBe('欣興');
    expect(await lookupStockName('3037')).toBe('欣興');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('同時多次查同一檔只送一次請求', async () => {
    const spy = vi.spyOn(api, 'symbolSearch').mockResolvedValue(ok([{ code: '6274', name: '台燿' }]));
    const r = await Promise.all([lookupStockName('6274'), lookupStockName('6274')]);
    expect(r).toEqual(['台燿', '台燿']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('確定沒有這檔 → null 並記住（不重複打）', async () => {
    const spy = vi.spyOn(api, 'symbolSearch').mockResolvedValue(ok([]));
    expect(await lookupStockName('9999')).toBeNull();
    expect(await lookupStockName('9999')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('網路錯誤或服務降級 → null、不快取，下次還會再試', async () => {
    const spy = vi.spyOn(api, 'symbolSearch')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(ok([], true))
      .mockResolvedValueOnce(ok([{ code: '8358', name: '金居' }]));
    expect(await lookupStockName('8358')).toBeNull();
    expect(await lookupStockName('8358')).toBeNull();
    expect(await lookupStockName('8358')).toBe('金居');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('不像代號的字串直接略過、不打 API', async () => {
    const spy = vi.spyOn(api, 'symbolSearch').mockResolvedValue(ok([]));
    expect(await lookupStockName('台積電')).toBeNull();
    expect(await lookupStockName('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
