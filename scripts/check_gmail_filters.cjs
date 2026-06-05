/**
 * check_gmail_filters.cjs — 列出 Gmail filter + Gmail 設定（forwarding/vacation/labels）
 * 找出為何 Oracle 信沒進來
 */
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

function httpsPost(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function httpsGet(url, token) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
            });
        }).on('error', reject);
    });
}
async function getAccessToken() {
    const body = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
    }).toString();
    const res = await httpsPost({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, body);
    return res.access_token;
}

async function main() {
    const token = await getAccessToken();

    console.log('--- Gmail filters ---');
    const filters = await httpsGet('https://gmail.googleapis.com/gmail/v1/users/me/settings/filters', token);
    console.log(JSON.stringify(filters, null, 2));

    console.log('\n--- Forwarding addresses ---');
    const fwd = await httpsGet('https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses', token);
    console.log(JSON.stringify(fwd, null, 2));

    console.log('\n--- Auto-forwarding ---');
    const autoFwd = await httpsGet('https://gmail.googleapis.com/gmail/v1/users/me/settings/autoForwarding', token);
    console.log(JSON.stringify(autoFwd, null, 2));

    console.log('\n--- Profile ---');
    const profile = await httpsGet('https://gmail.googleapis.com/gmail/v1/users/me/profile', token);
    console.log(JSON.stringify(profile, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
