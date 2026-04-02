const path = require('path');
const fs = require('fs');
const { DDGEmailProvider } = require('./src/ddgProvider');
const { BrowserbaseService } = require('./src/browserbaseService');
const { OAuthService } = require('./src/oauthService');
const { generateRandomName, generateRandomPassword } = require('./src/randomIdentity');
const config = require('./src/config');

// 目标生成数量
const TARGET_COUNT = parseInt(process.argv[2], 10) || 1;

// 已知的失败/错误页面特征
const FAILURE_PATTERNS = [
    'auth/error',
    'access_denied',
    'account_deactivated',
    'too_many_requests',
    'blocked',
    'challenge/recaptcha',
    'signup_disabled',
    'rate_limit',
    'error_code=',
];

function isFailureUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return FAILURE_PATTERNS.some(p => lower.includes(p));
}

function isMissionAccomplishedUrl(url) {
    return typeof url === 'string'
        && url.startsWith('data:text/html')
        && url.includes('MISSION_ACCOMPLISHED');
}

function isExpectedCallbackUrl(expectedCallbackUrl, currentUrl) {
    try {
        const expected = new URL(expectedCallbackUrl);
        const current = new URL(currentUrl);

        return current.protocol === expected.protocol
            && current.hostname === expected.hostname
            && current.port === expected.port
            && current.pathname === expected.pathname
            && (current.searchParams.has('code') || current.searchParams.has('error'));
    } catch (error) {
        return false;
    }
}

/**
 * 生成随机用户数据
 */
function generateUserData() {
    const fullName = generateRandomName();
    const password = generateRandomPassword();
    
    // 生成出生日期 (25-40岁)
    const age = 25 + Math.floor(Math.random() * 16);
    const birthYear = new Date().getFullYear() - age;
    const birthMonth = 1 + Math.floor(Math.random() * 12);
    const birthDay = 1 + Math.floor(Math.random() * 28);
    const birthDate = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;
    
    return {
        fullName,
        password,
        age,
        birthDate,
        birthMonth,
        birthDay,
        birthYear
    };
}

/**
 * 第一阶段：ChatGPT 注册
 */
async function phase1(emailProvider, browserbase, userData) {
    console.log('\n=========================================');
    console.log('[阶段1] 开始 ChatGPT 注册流程');
    console.log('=========================================');
    
    // 创建会话
    const session = await browserbase.createSession();
    
    // 构建 Agent Goal
    const goal = `请打开chatgpt的对话页面，然后点击创建一个账户，使用${emailProvider.getEmail()}作为邮箱，${userData.password}作为密码。

重要规则：
1. 如果你看到 Cloudflare 的 "Verify you are human" 验证页面，请点击复选框通过验证。如果遇到图形验证码（CAPTCHA），请尝试完成它。
2. 当需要去邮箱收件箱查看验证码时，必须打开一个【新标签页】访问邮箱链接 ${config.mailInboxUrl}，拿到验证码后切回原来的注册标签页填入验证码。绝对不要在注册页面直接跳转到邮箱链接，否则注册表单状态会丢失。
3. 等待邮件验证码时，如果收件箱里还没有看到最新的验证码邮件，请每隔 5 秒刷新一次收件箱页面，最多等待 90 秒。
4. 使用 ${userData.fullName} 作为全名。
5. 出生日期为 ${userData.birthYear} 年 ${userData.birthMonth} 月 ${userData.birthDay} 日（年龄为 ${userData.age} 岁）。如果页面是下拉框分别选择月、日、年对应的值；如果是输入框则输入 ${userData.birthDate}；如果要填年龄则填 ${userData.age}。
6. 创建账户完成后立刻导航到 \`data:text/html,<html><head><title>MISSION_ACCOMPLISHED</title></head><body style=\"background:black;color:lime;display:flex;justify-content:center;align-items:center;height:100vh;font-family:monospace;\"><h1>> TASK COMPLETED SUCCESSFULLY _</h1></body></html>\`，等待15秒并结束。
7. 页面加载和一般操作等待不超过 5 秒。`;
    
    console.log('[阶段1] Agent Goal 已准备');
    
    // 发送 Agent 任务（不等待 EventStream）
    browserbase.sendAgentGoal(goal).catch(e => {
        console.error(`[阶段1] Agent 任务流异常: ${e.message}`);
    });
    
    // 连接 CDP 监控 URL 变化
    const wsUrl = session.wsUrl;
    if (!wsUrl) {
        throw new Error('无法从 sessionUrl 中提取 WSS 地址');
    }
    
    console.log('[阶段1] 开始监控页面 URL 变化，等待到达 MISSION_ACCOMPLISHED 页面...');
    
    // 监控直到到达 MISSION_ACCOMPLISHED 页面
    const finalUrl = await browserbase.connectToCDP(wsUrl, {
        targetLabel: 'MISSION_ACCOMPLISHED 页面',
        targetMatcher: isMissionAccomplishedUrl,
        onUrlChange: (url) => {
            console.log(`[阶段1] URL 变化: ${url}`);
            // 快速检测失败页面，返回 Error 对象让 CDP 监控终止
            if (isFailureUrl(url)) {
                return new Error(`[阶段1] 检测到失败页面，提前终止: ${url}`);
            }
        },
        onTargetReached: (url) => {
            console.log(`[阶段1] 检测到 MISSION_ACCOMPLISHED 页面，注册流程完成！`);
            return url;
        },
        timeout: 600000 // 10分钟超时（从30分钟缩短）
    });
    
    console.log(`[阶段1] 最终 URL: ${finalUrl}`);
    browserbase.disconnect();
    
    return true;
}

/**
 * 第二阶段：Codex OAuth 授权
 */
async function phase2(emailProvider, browserbase, oauthService, userData) {
    console.log('\n=========================================');
    console.log('[阶段2] 开始 Codex OAuth 授权流程');
    console.log('=========================================');
    
    // 重新生成 PKCE 参数
    oauthService.regeneratePKCE();
    
    // 获取 OAuth URL
    const authUrl = oauthService.getAuthUrl();
    console.log(`[阶段2] OAuth URL: ${authUrl.substring(0, 100)}...`);
    
    // 创建新的会话
    const session = await browserbase.createSession();
    
    // 构建 Agent Goal
    const goal = `选择导航到 ${authUrl}，使用 ${emailProvider.getEmail()} 作为邮箱，${userData.password} 作为密码登录。

重要规则：
1. 如果你看到 Cloudflare 的 "Verify you are human" 验证页面，请点击复选框通过验证。
2. 如果页面显示已经登录或者提示需要验证邮箱验证码，请打开一个【新标签页】访问邮箱 ${config.mailInboxUrl}，每隔 5 秒刷新一次收件箱页面，最多等待 90 秒获取验证码，拿到验证码后切回原来的标签页填入。
3. 成功登录后，选择授权登录到 Codex。
4. 地址跳转到 localhost 回调链接后，会出现无法访问的页面，这是正常的，记录当前完整 URL 并结束即可。
5. 页面加载和一般操作等待不超过 5 秒。`;
    
    console.log('[阶段2] Agent Goal 已准备');
    
    // 发送 Agent 任务
    browserbase.sendAgentGoal(goal).catch(e => {
        console.error(`[阶段2] Agent 任务流异常: ${e.message}`);
    });
    
    // 连接 CDP 监控 URL 变化
    const wsUrl = session.wsUrl;
    if (!wsUrl) {
        throw new Error('无法从 sessionUrl 中提取 WSS 地址');
    }
    
    console.log('[阶段2] 开始监控页面 URL 变化，等待 localhost 回调...');
    
    // 监控直到到达 localhost
    const callbackUrl = await browserbase.connectToCDP(wsUrl, {
        targetLabel: 'localhost 回调',
        targetMatcher: (url) => isExpectedCallbackUrl(oauthService.redirectUri, url),
        onUrlChange: (url) => {
            console.log(`[阶段2] URL 变化: ${url}`);
            // 快速检测失败页面，返回 Error 对象让 CDP 监控终止
            if (isFailureUrl(url)) {
                return new Error(`[阶段2] 检测到失败页面，提前终止: ${url}`);
            }
        },
        onTargetReached: (url) => {
            console.log(`[阶段2] 检测到 localhost 回调！`);
            return url;
        },
        timeout: 600000 // 10分钟超时
    });
    
    console.log(`[阶段2] 回调 URL: ${callbackUrl}`);
    
    // 提取授权参数
    const params = oauthService.extractCallbackParams(callbackUrl);
    if (!params || params.error) {
        throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
    }
    
    if (!params.code) {
        throw new Error('回调 URL 中未找到授权码');
    }
    
    console.log(`[阶段2] 成功获取授权码: ${params.code.substring(0, 10)}...`);
    
    // 用授权码换取 Token
    const tokenData = await oauthService.exchangeTokenAndSave(params.code, emailProvider.getEmail());
    
    browserbase.disconnect();
    
    return tokenData;
}

/**
 * 单次注册流程
 */
async function runSingleRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次全新的注册与授权流程');
    console.log('=========================================');
    
    const emailProvider = new DDGEmailProvider();
    const oauthService = new OAuthService();
    
    // 阶段1 和 阶段2 各自使用独立的 BrowserbaseService 实例，避免残留状态干扰
    let browserbase1 = null;
    let browserbase2 = null;
    
    try {
        // 0. 生成用户数据
        const userData = generateUserData();
        console.log(`[主程序] 用户数据已生成:`);
        console.log(`  - 姓名: ${userData.fullName}`);
        console.log(`  - 年龄: ${userData.age}`);
        console.log(`  - 出生日期: ${userData.birthDate}`);
        
        // 1. 生成邮箱别名
        await emailProvider.generateAlias();
        
        // 2. 第一阶段：ChatGPT 注册（使用独立实例）
        browserbase1 = new BrowserbaseService();
        await phase1(emailProvider, browserbase1, userData);
        browserbase1.disconnect();
        
        // 3. 第二阶段：Codex OAuth 授权（使用全新独立实例）
        browserbase2 = new BrowserbaseService();
        const tokenData = await phase2(emailProvider, browserbase2, oauthService, userData);
        browserbase2.disconnect();
        
        console.log('[主程序] 本次注册流程圆满结束！');
        console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
        
        return true;
        
    } catch (error) {
        console.error('[主程序] 本次任务执行失败:', error.message);
        throw error;
    } finally {
        if (browserbase1) browserbase1.disconnect();
        if (browserbase2) browserbase2.disconnect();
    }
}

/**
 * 检查 token 数量
 */
async function checkTokenCount() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) {
        return 0;
    }
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
    return files.length;
}

/**
 * 归档已有 tokens
 */
function archiveExistingTokens() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) return;
    
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
    for (const file of files) {
        const oldPath = path.join(outputDir, file);
        const newPath = path.join(outputDir, `old_${file}`);
        fs.renameSync(oldPath, newPath);
        console.log(`[归档] ${file} → old_${file}`);
    }
}

/**
 * 启动批量注册
 */
async function startBatch() {
    console.log(`[启动] 开始执行 Codex 远程注册机，目标生成数量: ${TARGET_COUNT}`);
    
    // 检查配置
    if (!config.ddgToken) {
        console.error('[错误] 未配置 ddgToken，请检查 config.json 文件');
        process.exit(1);
    }
    if (!config.mailInboxUrl) {
        console.error('[错误] 未配置 mailInboxUrl，请检查 config.json 文件');
        process.exit(1);
    }
    
    // 归档已有的 token 文件
    archiveExistingTokens();
    
    while (true) {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            console.log(`\n[完成] 当前 Token 文件数量 (${currentCount}) 已达到目标 (${TARGET_COUNT})。程序退出。`);
            break;
        }
        
        console.log(`\n[进度] 目前 Token 数量 ${currentCount} / 目标 ${TARGET_COUNT}`);
        
        try {
            await runSingleRegistration();
        } catch (error) {
            const cooldown = 30000 + Math.random() * 30000; // 30-60秒随机冷却
            console.error(`[主程序] 注册失败，冷却 ${Math.round(cooldown / 1000)} 秒后重试...`);
            await new Promise(r => setTimeout(r, cooldown));
        }
    }
}

startBatch().catch(console.error);
