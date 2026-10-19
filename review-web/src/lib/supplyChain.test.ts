import { describe, expect, it } from 'vitest';
import teardownHtml from '../../public/teardown/index.html?raw';
import { buildSupplyChainIndex, extractTeardownData } from './supplyChainBuild';
import type { TeardownData } from './supplyChainBuild';
import { SUPPLY_CHAIN_CODES, supplyChainDetail, supplyChainLabel, supplyChainOf } from './supplyChain';
import indexJson from './supplyChainIndex.json';

describe('AI 產業鏈索引', () => {
  it('跟 3D 頁同步（換了 3D 頁沒重產會在這裡擋下：node tools/build-supply-chain-index.ts）', () => {
    expect(buildSupplyChainIndex(extractTeardownData(teardownHtml))).toEqual(indexJson);
  });

  it('只收有台股代號的公司', () => {
    expect(SUPPLY_CHAIN_CODES).toContain('2330');
    expect(SUPPLY_CHAIN_CODES.every((c) => /^\d{4}$/.test(c))).toBe(true);
    expect(supplyChainOf('NVDA')).toBeNull();
  });

  it('日月光出現在 CoWoS 封裝與封測檢測，照產業鏈順序', () => {
    const ase = supplyChainOf('3711')!;
    expect(ase.spots.map((s) => [s.scene, s.parts])).toEqual([
      ['cowos', ['C4 凸塊']],
      ['test', ['打線與封膠']],
    ]);
    expect(supplyChainLabel(ase)).toBe('AI 產業鏈：CoWoS 封裝・封測檢測');
    expect(supplyChainDetail(ase)).toContain('封測・CoWoS 封裝：C4 凸塊');
  });
});

describe('buildSupplyChainIndex', () => {
  const data: TeardownData = {
    meta: { asOf: '2026 年 10 月' },
    stageOrder: ['up', 'down'],
    stages: { up: { n: '上游', sc: ['a'] }, down: { n: '下游', sc: ['b', 'c'] } },
    scenes: {
      // 物件順序故意跟產業鏈順序不同
      c: { st: 'down', n: '場景C', ps: ['p3'], co: [['', ['甲']]] },
      a: { st: 'up', n: '場景A', ps: ['p1', 'p2'] },
      b: { st: 'down', n: '場景B', ps: ['p4'], co: [['', ['乙', '外商']]] },
    },
    parts: {
      p1: { n: '零件1', co: [['', ['甲', '外商']]] },
      p2: { n: '零件2', co: [['群組', ['甲']], ['另一群組', ['甲']]] },
      p3: { n: '零件3' },
      p4: { n: '零件4', co: [['', ['乙']]] },
    },
    companies: { 甲: { n: '甲公司', tw: '1111' }, 乙: { n: '乙公司', tw: '2222' }, 外商: { n: 'Foreign' } },
  };

  it('場景照階段順序、零件不重複、只在場景層級出現時零件清單是空的', () => {
    const idx = buildSupplyChainIndex(data);
    expect(Object.keys(idx.companies)).toEqual(['1111', '2222']);
    expect(idx.companies['1111'].spots).toEqual([
      { scene: 'a', sceneName: '場景A', stageName: '上游', parts: ['零件1', '零件2'] },
      { scene: 'c', sceneName: '場景C', stageName: '下游', parts: [] },
    ]);
    expect(idx.companies['2222'].spots).toEqual([
      { scene: 'b', sceneName: '場景B', stageName: '下游', parts: ['零件4'] },
    ]);
  });

  it('標籤超過三個場景時收合', () => {
    const many = {
      name: 'X',
      spots: ['一', '二', '三', '四'].map((n) => ({ scene: n, sceneName: n, stageName: '上游', parts: [] })),
    };
    expect(supplyChainLabel(many)).toBe('AI 產業鏈：一・二・三 等 4 處');
  });

  it('找不到資料表就報錯', () => {
    expect(() => extractTeardownData('<html></html>')).toThrow('找不到');
  });
});
