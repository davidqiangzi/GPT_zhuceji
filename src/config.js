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
    // DDG Email Alias
    ddgToken: "gedahwprf3lzeyvbbvxjcddrfpb42bw9vozs7ztdcnwtqxhni3yoh3cy43iwp9",
    
    // Mail Inbox
    mailInboxUrl: "https://bfe6955e.temp-mail-telegram-bjv.pages.dev/?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZGRyZXNzIjoidG1waXR0aWUzMkB4eHgueHh4MSIsImFkZHJlc3NfaWQiOjN9.BRKTyPuJvLS6DYxsMCZLtgnqaoSY-Mer512B7tSVw9M",
    
    // OAuth
    oauthClientId: config.oauthClientId || 'app_EMoamEEZ73f0CkXaXp7hrann',
    oauthRedirectPort: parseInt(config.oauthRedirectPort, 10) || 1455,
};
