const path = require('path');
const fs = require('fs');
const { DDGEmailProvider } = require('./src/ddgProvider');
const { TempMailProvider } = require('./src/tempMailProvider');
const { BrowserbaseService } = require('./src/browserbaseService');
const { OAuthService } = require('./src/oauthService');
const { MailService } = require('./src/mailService');
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
 * 检测是否到达邮箱验证码页面
 */
function isEmailVerificationUrl(url) {
    return typeof url === 'string' && url.includes('email-verification');
}

/**
 * 第一阶段：ChatGPT 注册
 * 拆分为两个子阶段：
 *   1a. Agent 填表直到出现验证码页面
 *   1b. Node.js 通过 API 获取验证码，Agent 填入验证码并完成注册
 */
async function phase1(emailProvider, browserbase, wsUrl, userData, mailService) {
    console.log('\n=========================================');
    console.log('[阶段1] 开始 ChatGPT 注册流程');
    console.log('=========================================');
    
    // =============================================
    // 子阶段 1a：Agent 填写注册表单，直到到达邮箱验证页面
    // =============================================
    const goal1a = `Navigate directly to https://chatgpt.com/#signup to register a new account. Use ${emailProvider.getEmail()} as the email, and ${userData.password} as the password.

CRITICAL RULES:
1. If you see a Cloudflare "Verify you are human" checkbox, click it. Complete any CAPTCHAs if they appear.
2. After submitting the email and password, wait for the page to navigate to the email verification step (where it asks for a code).
3. ONCE YOU REACH THE EMAIL VERIFICATION PAGE: STOP IMMEDIATELY. Do NOT attempt to check the email yourself. Just wait on the code input screen.
4. Keep page load and interaction delays under 5 seconds.`;
    
    console.log('[阶段1a] 发送填表任务...');
    
    const codeReceivedTimestamp = Date.now();
    
    browserbase.sendAgentGoal(goal1a).catch(e => {
        console.error(`[阶段1a] Agent 任务流异常: ${e.message}`);
    });
    
    // 监控直到到达 email-verification 页面
    console.log('[阶段1a] 等待到达邮箱验证页面...');
    await browserbase.connectToCDP(wsUrl, {
        targetLabel: '邮箱验证页面',
        targetMatcher: isEmailVerificationUrl,
        onUrlChange: (url) => {
            console.log(`[阶段1a] URL 变化: ${url}`);
            if (isFailureUrl(url)) {
                return new Error(`[阶段1a] 检测到失败页面，提前终止: ${url}`);
            }
        },
        onTargetReached: (url) => {
            console.log(`[阶段1a] ✅ 到达邮箱验证页面！`);
            return url;
        },
        timeout: 300000 // 5分钟超时
    });
    
    // =============================================
    // 子阶段 1b：Node.js 通过 API 获取验证码
    // =============================================
    console.log('[阶段1b] 开始通过 API 轮询验证码...');
    
    const verificationCode = await mailService.waitForVerificationCode({
        pollInterval: 5000,
        timeout: 90000,
        fromFilter: 'openai',
        afterTimestamp: codeReceivedTimestamp
    });
    
    console.log(`[阶段1b] ✅ 验证码已获取: ${verificationCode}`);
    
    // =============================================
    // 子阶段 1c：Agent 填入验证码并完成注册
    // =============================================
    const goal1c = `You should currently be on the email verification code screen. Enter the verification code: ${verificationCode} into the input fields, and then click submit/continue.

AFTER VERIFICATION:
1. If prompted for personal details, use ${userData.fullName} as the Full Name.
2. The birthday is ${userData.birthYear}-${userData.birthMonth}-${userData.birthDay} (Age: ${userData.age}). Select the appropriate dropdowns or input fields. If asked for age directly, enter ${userData.age}.
3. If you see a Cloudflare "Verify you are human" checkbox, click it.
4. IMMEDIATELY after your account is fully created, navigate directly to exactly: \`data:text/html,<html><head><title>MISSION_ACCOMPLISHED</title></head><body style=\"background:black;color:lime;display:flex;justify-content:center;align-items:center;height:100vh;font-family:monospace;\"><h1>> TASK COMPLETED SUCCESSFULLY _</h1></body></html>\`. Wait on this screen for 15 seconds.
5. Keep page load and interactions under 5 seconds.`;
    
    console.log('[阶段1c] 发送验证码填入任务...');
    
    browserbase.sendAgentGoal(goal1c).catch(e => {
        console.error(`[阶段1c] Agent 任务流异常: ${e.message}`);
    });
    
    // 监控直到到达 MISSION_ACCOMPLISHED 页面
    const finalUrl = await browserbase.connectToCDP(wsUrl, {
        targetLabel: 'MISSION_ACCOMPLISHED 页面',
        targetMatcher: isMissionAccomplishedUrl,
        onUrlChange: (url) => {
            console.log(`[阶段1c] URL 变化: ${url}`);
            if (isFailureUrl(url)) {
                return new Error(`[阶段1c] 检测到失败页面，提前终止: ${url}`);
            }
        },
        onTargetReached: (url) => {
            console.log(`[阶段1c] 检测到 MISSION_ACCOMPLISHED 页面，注册流程完成！`);
            return url;
        },
        timeout: 600000 // 10分钟超时
    });
    
    console.log(`[阶段1] 最终 URL: ${finalUrl}`);
    // 注意：不在这里 disconnect，保留会话供 Phase2 复用
    
    return true;
}

/**
 * 第二阶段：Codex OAuth 授权
 * 复用 Phase1 的会话，浏览器已处于登录状态，无需重新输入密码和验证码
 */
async function phase2(emailProvider, browserbase, wsUrl, oauthService, userData) {
    console.log('\n=========================================');
    console.log('[阶段2] 开始 Codex OAuth 授权流程（复用已登录会话）');
    console.log('=========================================');
    
    // 重新生成 PKCE 参数
    oauthService.regeneratePKCE();
    
    // 获取 OAuth URL
    const authUrl = oauthService.getAuthUrl();
    console.log(`[阶段2] OAuth URL: ${authUrl.substring(0, 100)}...`);
    
    // 构建 Agent Goal - 由于复用会话，浏览器已登录，Prompt 大幅简化
    const goal = `Navigate strictly to the following OAuth authorization link: ${authUrl}

CRITICAL RULES:
1. If you see a Cloudflare "Verify you are human" checkbox, click it.
2. You should already be logged in. If you see the authorization confirmation page (e.g. an "Allow access" or "Authorize" button), click to authorize.
3. If unexpectedly asked to log in, use ${emailProvider.getEmail()} as email and ${userData.password} as password. If an email verification code is required, open a NEW TAB to visit ${config.mailInboxUrl} and refresh every 5 seconds until you find the code, then enter it.
4. After authorization finishes, the page will redirect to a localhost URL. It is NORMAL if this localhost callback page says "Unable to connect" or "Site can't be reached". Just wait 5 seconds and terminate the browser session. Do NOT attempt to fix the localhost error.
5. Keep page load and interaction delays under 5 seconds.`;
    
    console.log('[阶段2] Agent Goal 已准备');
    
    // 在同一个 session 上发送新的 Agent 任务
    browserbase.sendAgentGoal(goal).catch(e => {
        console.error(`[阶段2] Agent 任务流异常: ${e.message}`);
    });
    
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
    
    return tokenData;
}

/**
 * 单次注册流程
 */
async function runSingleRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次全新的注册与授权流程');
    console.log('=========================================');
    
    const emailProvider = new TempMailProvider(config.mailApiBaseUrl, 'spd100.shop');
    const browserbase = new BrowserbaseService();
    const oauthService = new OAuthService();
    
    try {
        // 0. 生成用户数据
        const userData = generateUserData();
        console.log(`[主程序] 用户数据已生成:`);
        console.log(`  - 姓名: ${userData.fullName}`);
        console.log(`  - 年龄: ${userData.age}`);
        console.log(`  - 出生日期: ${userData.birthDate}`);
        
        // 1. 生成独立的临时邮箱
        await emailProvider.generateAlias();
        
        // 2. 初始化 MailService（使用为该邮箱生成的专属 JWT 轮询验证码）
        const mailService = new MailService(config.mailApiBaseUrl, emailProvider.getJwt());
        
        // 3. 创建 Browserbase 会话（只创建一次，两个阶段共享）
        const session = await browserbase.createSession();
        const wsUrl = session.wsUrl;
        if (!wsUrl) {
            throw new Error('无法从 sessionUrl 中提取 WSS 地址');
        }
        
        // 4. 第一阶段：ChatGPT 注册（含 API 验证码获取）
        await phase1(emailProvider, browserbase, wsUrl, userData, mailService);
        
        // 等待 2 秒让浏览器状态稳定
        console.log('[主程序] 等待 2 秒让浏览器状态稳定...');
        await new Promise(r => setTimeout(r, 2000));
        
        // 4. 第二阶段：Codex OAuth 授权（复用同一会话，浏览器保留登录 Cookie）
        const tokenData = await phase2(emailProvider, browserbase, wsUrl, oauthService, userData);
        
        console.log('[主程序] 本次注册流程圆满结束！');
        console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
        
        return true;
        
    } catch (error) {
        console.error('[主程序] 本次任务执行失败:', error.message);
        throw error;
    } finally {
        browserbase.disconnect();
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
        console.error('[错误] 未配置 ddgToken，请检查 config.js 文件');
        process.exit(1);
    }
    if (!config.mailApiBaseUrl) {
        console.error('[错误] 未配置 mailApiBaseUrl，请检查 config.js 文件');
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
