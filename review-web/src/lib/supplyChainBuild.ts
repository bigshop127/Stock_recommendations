/**
 * AI 產業鏈 3D 頁（public/teardown/index.html）的廠商資料 → 個股頁用的小索引。
 *
 * 3D 頁的內容全在它自己的 <script id="data"> JSON 裡；個股頁只需要「這個代號出現在哪些場景／零件」，
 * 不值得為一個標籤去抓 750KB 的 3D 頁，所以先算好存成 supplyChainIndex.json。
 * 換新版 3D 頁後跑 `node tools/build-supply-chain-index.ts` 重產（supplyChain.test.ts 會擋不同步）。
 *
 * 這支刻意不 import 任何東西：tools/ 的產生腳本直接用 node 跑它。
 */

type CoGroups = [string, string[]][];

export interface TeardownData {
  meta: { asOf: string };
  stageOrder: string[];
  stages: Record<string, { n: string; sc: string[] }>;
  scenes: Record<string, { st: string; n: string; ps: string[]; co?: CoGroups }>;
  parts: Record<string, { n: string; co?: CoGroups }>;
  companies: Record<string, { n: string; tw?: string }>;
}

export interface SupplyChainSpot {
  scene: string;      // 3D 頁場景代號，如 'cowos'
  sceneName: string;  // 'CoWoS 封裝'
  stageName: string;  // '封測'
  parts: string[];    // 這個場景裡列到它的零件；只出現在場景層級「代表廠商」時是空的
}

export interface SupplyChainCompany {
  name: string;       // 3D 頁上的名稱，如 '日月光投控 ASE'
  spots: SupplyChainSpot[];
}

export interface SupplyChainIndex {
  asOf: string;
  companies: Record<string, SupplyChainCompany>;  // key＝台股代號
}

export function extractTeardownData(html: string): TeardownData {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('3D 頁裡找不到 <script id="data"> 資料表');
  return JSON.parse(m[1]) as TeardownData;
}

/** 跟 3D 頁的 INDEX 同一套走法：先看零件的代表廠商，再補場景層級的；場景照產業鏈順序（上游 → 下游） */
export function buildSupplyChainIndex(data: TeardownData): SupplyChainIndex {
  const companies: Record<string, SupplyChainCompany> = {};
  for (const sk of data.stageOrder.flatMap((st) => data.stages[st].sc)) {
    const scene = data.scenes[sk];
    const hits = new Map<string, string[]>();
    for (const id of scene.ps) {
      const part = data.parts[id];
      for (const [, keys] of part.co ?? []) {
        for (const c of keys) {
          const names = hits.get(c) ?? [];
          if (!names.includes(part.n)) names.push(part.n);
          hits.set(c, names);
        }
      }
    }
    for (const [, keys] of scene.co ?? []) for (const c of keys) if (!hits.has(c)) hits.set(c, []);
    for (const [c, parts] of hits) {
      const co = data.companies[c];
      if (!co?.tw) continue;
      const entry = (companies[co.tw] ??= { name: co.n, spots: [] });
      entry.spots.push({ scene: sk, sceneName: scene.n, stageName: data.stages[scene.st].n, parts });
    }
  }
  return { asOf: data.meta.asOf, companies };
}
