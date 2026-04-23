const fs = require('fs');
const path = require('path');

const chapterId = process.argv[2] || 'cervical';
const jsonPath = path.join(__dirname, '../2_refined_chatgpt', `${chapterId}.json`);
const outputPath = path.join(__dirname, '../3_final_ccb', `${chapterId}.md`);

if (!fs.existsSync(jsonPath)) {
    console.error(`Error: JSON file not found at ${jsonPath}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

let mermaid = `graph TD\n`;

data.logic_tree.forEach(node => {
    const text = node.text.replace(/"/g, "'");
    
    // 判斷節點形狀
    if (node.options) {
        mermaid += `    ${node.id}{${text}}\n`;
        for (const [option, nextId] of Object.entries(node.options)) {
            mermaid += `    ${node.id} -->|${option}| ${nextId}\n`;
        }
    } else {
        if (node.id === 'start' || node.id === 'reassess') {
            mermaid += `    ${node.id}([${text}])\n`;
        } else {
            mermaid += `    ${node.id}[${text}]\n`;
        }
    }

    // 處理 next 連接
    if (node.next) {
        node.next.forEach(nextId => {
            mermaid += `    ${node.id} --> ${nextId}\n`;
        } );
    }

    // 特殊樣式：緊急轉介
    if (node.id.includes('urgent') || node.id.includes('referral')) {
        mermaid += `    style ${node.id} fill:#ffcccc,stroke:#ff0000\n`;
    }
});

const content = `# ${data.part} 臨床思維導圖

\`\`\`mermaid
${mermaid}
\`\`\`

## 💎 Clinical Pearls (臨床珍珠)
${data.clinical_pearls.map(p => `- ${p}`).join('\n')}
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, content);
console.log(`[CCB] Successfully generated Markdown for ${chapterId}`);