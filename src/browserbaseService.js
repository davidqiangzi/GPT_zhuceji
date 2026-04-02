const axios = require('axios');
const config = require('./config');

class BrowserbaseService {
    constructor() {
        this.sessionId = null;
        this.sessionUrl = null;
        this.wsUrl = null;
        this.apiKey = config.browserbaseApiKey;
        this.projectId = config.browserbaseProjectId;
    }

    /**
     * 创建新的 Browserbase 会话 (官方 API)
     * @returns {Promise<{sessionId: string, sessionUrl: string, wsUrl: string}>}
     */
    async createSession() {
        if (!this.apiKey || !this.projectId) {
            throw new Error('未配置 Browserbase API Key 或 Project ID');
        }

        try {
            console.log('[Browserbase] 正在通过官方 API 创建隐身会话...');
            // POST /v1/sessions to create a session
            const response = await axios.post(
                'https://api.browserbase.com/v1/sessions',
                {
                    projectId: this.projectId,
                    browserSettings: {
                        viewport: { width: 1280, height: 800 }
                    }
                },
                {
                    headers: {
                        'X-BB-API-Key': this.apiKey,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const data = response.data;
            this.sessionId = data.id;

            // Compute standard Playwright CDP connection URL
            this.wsUrl = `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${this.sessionId}`;
            // Optional: Inspector UI url to watch the magic happen
            this.sessionUrl = `https://www.browserbase.com/sessions/${this.sessionId}`;

            console.log(`[Browserbase] ✅ 会话已创建: ${this.sessionId}`);
            console.log(`[Browserbase] 👁️‍🗨️ Inspector (需要登录官网查看): ${this.sessionUrl}`);

            return {
                sessionId: this.sessionId,
                sessionUrl: this.sessionUrl,
                wsUrl: this.wsUrl
            };
        } catch (error) {
            console.error('[Browserbase] 创建会话失败:', error.message);
            if (error.response) {
                console.error('[Browserbase] 响应状态:', error.response.status);
                console.error('[Browserbase] 响应数据:', JSON.stringify(error.response.data));
            }
            throw error;
        }
    }
}

module.exports = { BrowserbaseService };
