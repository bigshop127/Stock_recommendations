const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

const FINANCE_PROGRESS_PATH = path.join(__dirname, 'data', 'finance_progress.json');

function getFinanceProgress() {
    if (!fs.existsSync(FINANCE_PROGRESS_PATH)) return { tasks: [] };
    return JSON.parse(fs.readFileSync(FINANCE_PROGRESS_PATH, 'utf8'));
}

function saveFinanceProgress(data) {
    fs.writeFileSync(FINANCE_PROGRESS_PATH, JSON.stringify(data, null, 4));
}

app.get('/api/finance/status', (req, res) => {
    res.json(getFinanceProgress());
});

app.post('/api/finance/update', (req, res) => {
    const { id, status, progress, message } = req.body;
    if (!id || !status) return res.status(400).json({ success: false, message: 'id and status required' });
    const data = getFinanceProgress();
    const task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ success: false, message: `Task ${id} not found` });
    task.status = status;
    if (progress !== undefined) task.progress = progress;
    if (message !== undefined) task.message = message;
    task.updatedAt = new Date().toISOString();
    saveFinanceProgress(data);
    console.log(`[Finance] ${id} -> ${status}${progress ? ' (' + progress + ')' : ''}`);
    res.json({ success: true, task });
});

const ALLOWED_SCRIPTS = ['puhui_synthesize.js', 'sync_to_obsidian.js'];

app.post('/api/run-script', (req, res) => {
    const { script } = req.body;
    if (!script || !ALLOWED_SCRIPTS.includes(script)) {
        return res.status(403).json({ success: false, message: `Script not allowed. Allowed: ${ALLOWED_SCRIPTS.join(', ')}` });
    }
    console.log(`[Puhui] Running script: ${script}`);
    exec(`node scripts/${script}`, { cwd: __dirname }, (error, stdout, stderr) => {
        if (error) {
            console.error(`[Script Error] ${script}: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message, stderr });
        }
        console.log(`[Script Done] ${script}: ${stdout.substring(0, 200)}`);
        res.json({ success: true, stdout: stdout.substring(0, 1000) });
    });
});

app.listen(port, () => {
    console.log(`Puhui finance API server: http://localhost:${port}`);
});
