const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

const PROGRESS_PATH = path.join(__dirname, 'data', 'progress.json');

function getProgress() {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
}

function saveProgress(data) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(data, null, 4));
}

app.get('/api/status', (req, res) => {
    const data = getProgress();
    // 自動更新目錄偵測狀態
    data.chapters.forEach(ch => {
        const id = ch.id;
        const refinedPath = path.join(__dirname, '2_refined_chatgpt', `${id}.json`);
        let refinedValid = false;
        if (fs.existsSync(refinedPath)) {
            try {
                JSON.parse(fs.readFileSync(refinedPath, 'utf8'));
                refinedValid = true;
            } catch (e) {
                console.error(`[Error] ${id}.json 格式錯誤`);
                refinedValid = false;
            }
        }

        ch.steps = {
            raw: fs.existsSync(path.join(__dirname, '1_raw_notebooklm', `${id}.txt`)),
            refined: refinedValid,
            final: fs.existsSync(path.join(__dirname, '3_final_ccb', `${id}.md`))
        };

        // 如果檔案存在但驗證失敗，特別標註
        if (fs.existsSync(refinedPath) && !refinedValid) {
            ch.status = 'error_format';
        } else if (ch.steps.final) ch.status = 'completed';
        else if (ch.steps.refined) ch.status = 'refining';
        else if (ch.steps.raw) ch.status = 'extracting';
    });
    res.json(data);
});

app.post('/api/lock/:id', (req, res) => {
    const { user } = req.body;
    const data = getProgress();
    const ch = data.chapters.find(c => c.id === req.params.id);
    if (ch && (!ch.lockedBy || ch.lockedBy === user)) {
        ch.lockedBy = user;
        saveProgress(data);
        res.json({ success: true, message: `${ch.name} 已被 ${user} 鎖定` });
    } else {
        res.status(403).json({ success: false, message: '該項目已被他人鎖定' });
    }
});

app.post('/api/unlock/:id', (req, res) => {
    const data = getProgress();
    const ch = data.chapters.find(c => c.id === req.params.id);
    if (ch) {
        ch.lockedBy = null;
        saveProgress(data);
        res.json({ success: true, message: `${ch.name} 已解除鎖定` });
    } else {
        res.status(404).json({ success: false, message: '找不到該項目' });
    }
});

app.get('/api/raw/:name', (req, res) => {
    const filePath = path.join(__dirname, '1_raw_notebooklm', `${req.params.name.toLowerCase()}.txt`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('內容尚未提取');
    }
});

const { exec } = require('child_process');

app.post('/api/run-ccb/:name', (req, res) => {
    const name = req.params.name.toLowerCase();
    console.log(`[CCB] 啟動執行：${name}`);
    
    // 執行 CCB 處理腳本
    exec(`node scripts/ccb_processor.js ${name}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`[CCB Error] ${error.message}`);
            return res.status(500).json({ success: false, message: 'CCB 執行失敗' });
        }
        
        console.log(`[CCB Output] ${stdout}`);
        
        // 完成後自動解鎖
        const data = getProgress();
        const ch = data.chapters.find(c => c.id === name);
        if (ch) {
            ch.lockedBy = null;
            saveProgress(data);
        }
        
        res.json({ success: true, message: `${name} 流程圖生成成功並已解鎖！` });
    });
});

app.listen(port, () => {
    console.log(`PT 協作平台運作中：http://localhost:${port}`);
});