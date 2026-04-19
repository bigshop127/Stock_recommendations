
const { parseJsonSafe } = require('../utils/outputSanitizer');

// 模擬 DeepSeek-R1 真實輸出：<think> 思維鏈 + markdown fences
const r1Output = `<think>
讓我分析這個病患資料。首先掃描紅旗...
夜間劇痛確實是重要警訊，我應該將其置頂。
好，現在輸出 JSON。
</think>
\`\`\`json
{
  "pathway_id": "shoulder_001",
  "red_flags": ["夜間劇痛"],
  "interventions": ["立即轉介骨科"]
}
\`\`\``;

try {
  const result = parseJsonSafe(r1Output, 'test');
  console.log('✅ 解析成功:');
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('❌ 解析失敗:', e.message);
}

// 邊界測試：純淨 JSON（無污染）
const cleanOutput = `{"pathway_id":"clean","red_flags":[]}`;
const r2 = parseJsonSafe(cleanOutput, 'clean-test');
console.log('\n✅ 純淨 JSON 也正常:', r2.pathway_id);
