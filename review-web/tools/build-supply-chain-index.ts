// 換新版 AI 產業鏈 3D 頁（public/teardown/index.html）後，重產個股頁用的索引：
//   node tools/build-supply-chain-index.ts
// （Node 22.18 起直接吃 .ts；產出 src/lib/supplyChainIndex.json，要一起 commit）
import { readFileSync, writeFileSync } from 'node:fs';
import { buildSupplyChainIndex, extractTeardownData } from '../src/lib/supplyChainBuild.ts';

const root = new URL('..', import.meta.url);
const html = readFileSync(new URL('public/teardown/index.html', root), 'utf8');
const index = buildSupplyChainIndex(extractTeardownData(html));
writeFileSync(new URL('src/lib/supplyChainIndex.json', root), JSON.stringify(index, null, 1) + '\n');
console.log(`已寫入 src/lib/supplyChainIndex.json：${Object.keys(index.companies).length} 家台股（資料截至 ${index.asOf}）`);
