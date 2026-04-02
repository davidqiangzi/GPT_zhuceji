const path = require('path');
const fs = require('fs');
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
    const goal1a = `请导航到 https://chatgpt.com/#signup 进行账户注册，使用 ${emailProvider.getEmail()} 作为邮箱，${userData.password} 作为密码。

重要规则：
1. 如果你看到 Cloudflare 的 "Verify you are human" 验证页面，请点击复选框通过验证。如果遇到图形验证码（CAPTCHA），请尝试完成它。
2. 输入邮箱和密码后提交，等待页面跳转到邮箱验证页面（会显示要求输入验证码）。
3. 到达邮箱验证码输入页面后，请【停下来等待】，不要做任何操作，不要去邮箱页面，验证码会由系统自动提供给你。
4. 页面加载和一般操作等待不超过 5 秒。`;
    
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
    const goal1c = `当前页面应该是邮箱验证码输入页面。请在验证码输入框中输入验证码: ${verificationCode}，然后点击提交/继续按钮。

接下来：
1. 如果需要填写个人信息，使用 ${userData.fullName} 作为全名。
2. 出生日期为 ${userData.birthYear} 年 ${userData.birthMonth} 月 ${userData.birthDay} 日（年龄为 ${userData.age} 岁）。如果页面是下拉框分别选择月、日、年对应的值；如果是输入框则输入 ${userData.birthDate}；如果要填年龄则填 ${userData.age}。
3. 如果你看到 Cloudflare 的 "Verify you are human" 验证页面，请点击复选框通过验证。
4. 创建账户完成后立刻导航到 \`data:text/html,<html><head><title>MISSION_ACCOMPLISHED</title></head><body style=\"background:black;color:lime;display:flex;justify-content:center;align-items:center;height:100vh;font-family:monospace;\"><h1>> TASK COMPLETED SUCCESSFULLY _</h1></body></html>\`，等待15秒并结束。
5. 页面加载和一般操作等待不超过 5 秒。`;
    
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
    const goal = `导航到以下 OAuth 授权链接: ${authUrl}

重要规则：
1. 如果你看到 Cloudflare 的 "Verify you are human" 验证页面，请点击复选框通过验证。
2. 你应该已经处于登录状态。如果页面直接显示授权确认页面（如 "Allow access" 或类似按钮），直接点击同意授权。
3. 如果意外需要登录，使用 ${emailProvider.getEmail()} 作为邮箱，${userData.password} 作为密码。如果需要邮箱验证码，打开【新标签页】访问 ${config.mailInboxUrl} 获取，每隔 5 秒刷新，最多等待 90 秒。
4. 地址跳转到 localhost 回调链接后，会出现无法访问的页面，这是正常的，记录当前完整 URL 并结束即可。
5. 页面加载和一般操作等待不超过 5 秒。`;
    
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
    
    const emailProvider = new TempMailProvider(config.mailApiBaseUrl, 'mail.spd100.shop');
    const browserbase = new BrowserbaseService();
    const oauthService = new OAuthService();
    
    try {
        // 0. 生成用户数据
        const userData = generateUserData();
        console.log(`[主程序] 用户数据已生成:`);
        console.log(`  - 姓名: ${userData.fullName}`);
        console.log(`  - 年龄: ${userData.age}`);
        console.log(`  - 出生日期: ${userData.birthDate}`);
        
        // 1. 创建临时邮箱（每次注册一个新地址，验证码直接进入可 API 读取的收件箱）
        await emailProvider.generateAlias();
        
        // 2. 用新创建邮箱的 JWT 初始化 MailService
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
