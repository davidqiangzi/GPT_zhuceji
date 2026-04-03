const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, '..', 'config.json');

// 读取配置文件
function loadConfig() {
    if (!fs.existsSync(configPath)) {
        console.error(`[Config] 配置文件不存在: ${configPath}`);
        return {};
    }
    
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('[Config] 解析配置文件失败:', error.message);
        return {};
    }
}

const config = loadConfig();

module.exports = {
    // Browserbase API Key
    browserbaseApiKey: "bb_live_p1q68QpcHmHRIWExRhq9KE1va38",
    browserbaseProjectId: "996719d8-36d9-4180-9cef-80ffbd2c775e",
    useLocalBrowser: true, // 设置为 true 则使用本地 Playwright 运行，否则使用 Browserbase

    // DDG Email Alias
    ddgToken: "gedahwprf3lzeyvbbvxjcddrfpb42bw9vozs7ztdcnwtqxhni3yoh3cy43iwp9",
    
    // Mail Inbox (前端页面 URL，供 Agent 备用)
    mailInboxUrl: "https://bfe6955e.temp-mail-telegram-bjv.pages.dev/?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZGRyZXNzIjoidG1wdG1wZGRnQHNwZDEwMC5zaG9wIiwiYWRkcmVzc19pZCI6MTN9.eBQQKDLecX3kM8FhHLRp2rITrBAt268UaGrEZdxR28I",
    
    // Mail API (Worker 后端 API，用于程序化获取验证码)
    // JWT 对应收件箱: tmptmpddg@spd100.shop (address_id: 13)
    mailApiBaseUrl: "https://temp-mail-worker.dongchongchao888.workers.dev",
    mailJwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZGRyZXNzIjoidG1wdG1wZGRnQHNwZDEwMC5zaG9wIiwiYWRkcmVzc19pZCI6MTN9.eBQQKDLecX3kM8FhHLRp2rITrBAt268UaGrEZdxR28I",
    
    // OAuth
    oauthClientId: config.oauthClientId || 'app_EMoamEEZ73f0CkXaXp7hrann',
    oauthRedirectPort: parseInt(config.oauthRedirectPort, 10) || 1455,
};
