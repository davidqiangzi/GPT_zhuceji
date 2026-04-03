const axios = require('axios');
const crypto = require('crypto');

/**
 * 临时邮箱提供者 - 通过 Cloudflare Worker API 创建临时邮箱地址
 * 替代 DDG Email Alias，验证码会直接进入可通过 API 读取的收件箱
 */
class TempMailProvider {
    /**
     * @param {string} workerBaseUrl - Worker 后端 API 地址
     * @param {string} domain - 邮箱域名 (默认 spd100.shop)
     */
    constructor(workerBaseUrl, domain = 'spd100.shop') {
        this.baseUrl = workerBaseUrl.replace(/\/$/, '');
        this.domain = domain;
        this.emailAddress = null;
        this.jwt = null;
        this.addressId = null;
    }

    /**
     * 生成真人化随机地址名
     * 格式: fname.lname.92, 最终地址为 tmp{name}@{domain}
     */
    _generateAddressName() {
        const firstNames = ['james', 'john', 'robert', 'michael', 'william', 'david', 'richard', 'joseph', 'thomas', 'charles', 'christopher', 'daniel', 'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua'];
        const lastNames = ['smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin'];
        
        const fname = firstNames[crypto.randomInt(firstNames.length)];
        const lname = lastNames[crypto.randomInt(lastNames.length)];
        const suffix = crypto.randomInt(10, 999);
        
        return `${fname}.${lname}.${suffix}`;
    }

    /**
     * 创建新的临时邮箱地址
     * @returns {Promise<string>} 完整邮箱地址
     */
    async generateAlias() {
        try {
            const name = this._generateAddressName();
            
            const response = await axios.post(
                `${this.baseUrl}/api/new_address`,
                {
                    name: name,
                    domain: this.domain
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            const data = response.data;
            this.emailAddress = data.address;
            this.jwt = data.jwt;
            this.addressId = data.address_id;

            console.log(`[TempMail] 创建临时邮箱: ${this.emailAddress}`);
            console.log(`[TempMail] Address ID: ${this.addressId}`);
            
            return this.emailAddress;
        } catch (error) {
            console.error('[TempMail] 创建邮箱失败:', error.message);
            if (error.response) {
                console.error('[TempMail] 响应状态:', error.response.status);
                console.error('[TempMail] 响应数据:', JSON.stringify(error.response.data));
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

    /**
     * 获取当前邮箱的 JWT (用于 MailService 轮询)
     * @returns {string|null}
     */
    getJwt() {
        return this.jwt;
    }
}

module.exports = { TempMailProvider };
