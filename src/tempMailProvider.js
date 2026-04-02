const axios = require('axios');
const crypto = require('crypto');

/**
 * 临时邮箱提供者 - 通过 Cloudflare Worker API 创建临时邮箱地址
 * 替代 DDG Email Alias，验证码会直接进入可通过 API 读取的收件箱
 */
class TempMailProvider {
    /**
     * @param {string} workerBaseUrl - Worker 后端 API 地址
     * @param {string} domain - 邮箱域名 (默认 xxx.xxx1)
     */
    constructor(workerBaseUrl, domain = 'xxx.xxx1') {
        this.baseUrl = workerBaseUrl.replace(/\/$/, '');
        this.domain = domain;
        this.emailAddress = null;
        this.jwt = null;
        this.addressId = null;
    }

    /**
     * 生成随机地址名
     * 格式: codex + 随机6位字母数字, 最终地址为 tmp{name}@{domain}（前缀 tmp 由服务端自动加）
     */
    _generateAddressName() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let name = 'codex';
        for (let i = 0; i < 6; i++) {
            name += chars.charAt(crypto.randomInt(chars.length));
        }
        return name;
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
