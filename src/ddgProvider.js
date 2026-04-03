const axios = require('axios');
const config = require('./config');

class DDGEmailProvider {
    constructor() {
        this.token = config.ddgToken;
        this.emailAddress = null;
    }

    /**
     * 生成 DDG 邮箱别名
     * @returns {Promise<string>} 邮箱地址 (xxx@duck.com)
     */
    async generateAlias() {
        try {
            const response = await axios.post(
                'https://quack.duckduckgo.com/api/email/addresses',
                {},
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                        'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(120 + Math.random()*10)}.0.0.0 Safari/537.36`,
                        'Origin': 'https://duckduckgo.com',
                        'Referer': 'https://duckduckgo.com/'
                    }
                }
            );

            // 响应格式: {"address":"a-b-c"}
            const address = response.data.address;
            this.emailAddress = `${address}@duck.com`;
            
            console.log(`[DDG] 生成邮箱别名: ${this.emailAddress}`);
            return this.emailAddress;
        } catch (error) {
            console.error('[DDG] 生成邮箱别名失败:', error.message);
            if (error.response) {
                console.error('[DDG] 响应状态:', error.response.status);
                console.error('[DDG] 响应数据:', error.response.data);
            }
            throw error;
        }
    }

    /**
     * 获取当前邮箱地址
     * @returns {string|null}
     */
    getEmail() {
        return this.emailAddress;
    }
}

module.exports = { DDGEmailProvider };
