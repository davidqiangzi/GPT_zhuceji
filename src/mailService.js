const axios = require('axios');

/**
 * 邮件服务 - 通过 API 直接获取验证码
 * 避免让 AI Agent 视觉解析邮箱网页
 */
class MailService {
    /**
     * @param {string} workerBaseUrl - Worker 后端 API 地址
     * @param {string} jwt - 邮箱 JWT Token
     */
    constructor(workerBaseUrl, jwt) {
        this.baseUrl = workerBaseUrl.replace(/\/$/, '');
        this.jwt = jwt;
    }

    /**
     * 获取最新邮件列表
     * @param {number} limit - 获取邮件数量
     * @returns {Promise<{results: Array, count: number}>}
     */
    async getMails(limit = 5) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/mails?limit=${limit}&offset=0`, {
                headers: {
                    'Authorization': `Bearer ${this.jwt}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            return response.data;
        } catch (error) {
            console.error('[MailService] 获取邮件列表失败:', error.message);
            return { results: [], count: 0 };
        }
    }

    /**
     * 获取单封邮件详情
     * @param {number} mailId - 邮件 ID
     * @returns {Promise<object|null>}
     */
    async getMailDetail(mailId) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/mail/${mailId}`, {
                headers: {
                    'Authorization': `Bearer ${this.jwt}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            return response.data;
        } catch (error) {
            console.error('[MailService] 获取邮件详情失败:', error.message);
            return null;
        }
    }

    /**
     * 从邮件内容中提取 OpenAI 验证码（通常是 6 位数字）
     * @param {string} content - 邮件 HTML 或文本内容
     * @returns {string|null} 验证码
     */
    extractVerificationCode(content) {
        if (!content) return null;
        
        // OpenAI 验证码通常是 6 位数字
        // 常见格式: "验证码是 123456" 或 "Your code is 123456" 或直接大字体的 6 位数字
        const patterns = [
            /\b(\d{6})\b/,                          // 通用 6 位数字
            /code[:\s]*(\d{6})/i,                   // "code: 123456" 或 "code is 123456"
            /verification[:\s]*(\d{6})/i,           // "verification: 123456"
            /verify[:\s]*(\d{6})/i,                 // "verify 123456"
        ];

        for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match) {
                return match[1];
            }
        }

        return null;
    }

    /**
     * 轮询等待新的验证码邮件
     * @param {object} options - 配置选项
     * @param {number} options.pollInterval - 轮询间隔（毫秒），默认 5000
     * @param {number} options.timeout - 超时时间（毫秒），默认 90000
     * @param {string} options.fromFilter - 发件人过滤（可选）
     * @param {number} options.afterTimestamp - 只考虑此时间戳之后的邮件（可选）
     * @returns {Promise<string>} 验证码
     */
    async waitForVerificationCode(options = {}) {
        const {
            pollInterval = 5000,
            timeout = 90000,
            fromFilter = null,
            afterTimestamp = null
        } = options;

        const startTime = Date.now();
        const startTs = afterTimestamp || startTime;
        let attempt = 0;

        console.log(`[MailService] 开始轮询验证码邮件（间隔 ${pollInterval / 1000}s，超时 ${timeout / 1000}s）...`);

        while (Date.now() - startTime < timeout) {
            attempt++;
            
            try {
                const data = await this.getMails(5);
                
                if (data.results && data.results.length > 0) {
                    for (const mail of data.results) {
                        // 如果有时间过滤，跳过旧邮件
                        if (afterTimestamp && mail.created_at) {
                            const mailTime = new Date(mail.created_at).getTime();
                            if (mailTime < afterTimestamp) continue;
                        }
                        
                        // 如果有发件人过滤
                        if (fromFilter && mail.source && !mail.source.toLowerCase().includes(fromFilter.toLowerCase())) {
                            continue;
                        }
                        
                        // 先从邮件摘要/主题中尝试提取
                        let code = this.extractVerificationCode(mail.subject || '');
                        
                        if (!code) {
                            // 获取邮件详情
                            const detail = await this.getMailDetail(mail.id);
                            if (detail) {
                                code = this.extractVerificationCode(detail.text || detail.html || detail.raw || '');
                            }
                        }
                        
                        if (code) {
                            console.log(`[MailService] ✅ 成功获取验证码: ${code}（第 ${attempt} 次轮询）`);
                            return code;
                        }
                    }
                }
                
                if (attempt <= 3 || attempt % 5 === 0) {
                    console.log(`[MailService] 第 ${attempt} 次轮询，当前邮件数: ${data.count}，未找到验证码，继续等待...`);
                }
            } catch (error) {
                console.error(`[MailService] 轮询出错: ${error.message}`);
            }

            await new Promise(r => setTimeout(r, pollInterval));
        }

        throw new Error(`[MailService] 等待验证码超时（${timeout / 1000}s）`);
    }
}

module.exports = { MailService };
