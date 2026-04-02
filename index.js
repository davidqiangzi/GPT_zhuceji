const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { DDGEmailProvider } = require('./src/ddgProvider');
const { TempMailProvider } = require('./src/tempMailProvider');
const { BrowserbaseService } = require('./src/browserbaseService');
const { OAuthService } = require('./src/oauthService');
const { MailService } = require('./src/mailService');
const { generateRandomName, generateRandomPassword } = require('./src/randomIdentity');
const config = require('./src/config');

// 目标生成数量
const TARGET_COUNT = parseInt(process.argv[2], 10) || 1;

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
 * 阶段一：自动填写注册表单
 */
async function phase1(page, emailProvider, userData, mailService) {
    console.log('\n=========================================');
    console.log('[阶段1] 开始 ChatGPT 注册流程 (Playwright)');
    console.log('=========================================');
    
    const email = emailProvider.getEmail();
    const codeReceivedTimestamp = Date.now();

    console.log(`[阶段1] 导航到注册页面...`);
    await page.goto('https://chatgpt.com/#signup', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 1. 输入邮箱
    console.log(`[阶段1] 等待邮箱输入框...`);
    const emailLocator = page.locator('input[type="email"], input[name="email"]').first();
    await emailLocator.waitFor({ state: 'visible', timeout: 30000 });
    await emailLocator.fill(email);
    
    console.log(`[阶段1] 提交邮箱...`);
    const submitBtn = page.locator('button[type="submit"], button:has-text("Continue")').locator('visible=true').first();
    await submitBtn.click();

    // 2. 输入密码 (遇到Turnstile的话可能稍慢，所以 timeout 设长一点)
    console.log(`[阶段1] 等待密码输入框...`);
    const pwdLocator = page.locator('input[type="password"], input[name="password"]').first();
    await pwdLocator.waitFor({ state: 'visible', timeout: 60000 });
    await pwdLocator.fill(userData.password);
    
    console.log(`[阶段1] 提交密码...`);
    await submitBtn.click();

    // 3. 收取验证码
    console.log(`[阶段1] 正在后台收取验证码邮件...`);
    const verificationCode = await mailService.waitForVerificationCode({
        pollInterval: 5000,
        timeout: 90000,
        fromFilter: 'openai',
        afterTimestamp: codeReceivedTimestamp
    });
    console.log(`[阶段1] ✅ 收到验证码: ${verificationCode}`);

    // 等待验证码页面出现并填入
    console.log(`[阶段1] 填入验证码...`);
    // ChatGPT验证码框有可能是6个分开的单输入框，这里直接向页面暴力注入按键，或者寻找符合条件的输入框
    try {
        const codeInput = page.locator('input[inputmode="numeric"], input[name="code"]').first();
        await codeInput.waitFor({ state: 'visible', timeout: 30000 });
        await codeInput.click();
        await page.keyboard.type(verificationCode, { delay: 100 });
    } catch (e) {
        console.log(`[阶段1] 无法用常规方式找到验证码输入框，可能是意外页面: ${e.message}`);
    }

    // 4. 等待个人信息表单 (可能没有)
    try {
        console.log(`[阶段1] 正在检查是否需要填充个人信息 (姓名/生日)...`);
        const fnLocator = page.locator('input[name="first-name"], input[name="firstName"]').first();
        await fnLocator.waitFor({ state: 'visible', timeout: 15000 });
        
        await fnLocator.fill(userData.fullName.split(' ')[0]);
        await page.locator('input[name="last-name"], input[name="lastName"]').first().fill(userData.fullName.split(' ')[1] || 'Smith');
        
        // 填写生日 MM/DD/YYYY
        const bdLocator = page.locator('input[name="birthday"], input[name="dateOfBirth"]').first();
        if (await bdLocator.isVisible()) {
            await bdLocator.fill(`${String(userData.birthMonth).padStart(2,'0')}/${String(userData.birthDay).padStart(2,'0')}/${userData.birthYear}`);
        }

        // 提交
        await page.locator('button:has-text("Agree"), button:has-text("Continue")').first().click();
        console.log(`[阶段1] 个人信息已提交`);
    } catch (e) {
        console.log(`[阶段1] 跳过个人信息，看起来未弹出或已满足`);
    }

    console.log(`[阶段1] 等待注册状态最终汇聚下发...`);
    await page.waitForTimeout(8000); 
    console.log(`[阶段1] ✅ ChatGPT 注册环境准备完毕`);
    return true;
}

/**
 * 阶段二：OAuth 授权
 */
async function phase2(page, emailProvider, oauthService) {
    console.log('\n=========================================');
    console.log('[阶段2] 开始 Codex OAuth 授权流程 (Playwright)');
    console.log('=========================================');
    
    oauthService.regeneratePKCE();
    const authUrl = oauthService.getAuthUrl();
    console.log(`[阶段2] 跳转到 OAuth: ${authUrl.substring(0, 100)}...`);

    let callbackUrl = null;
    
    // 拦截任何到 oAuth 重定向的回调 (localhost)
    page.on('framenavigated', frame => {
        const url = frame.url();
        if (url.includes('http://localhost') && (url.includes('code=') || url.includes('error='))) {
            callbackUrl = url;
            console.log(`[阶段2] ⚡ 拦截到回调 URL: ${url}`);
        }
    });

    try {
        await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
        // Chromium 请求 localhost 确实会抛出 net::ERR_CONNECTION_REFUSED
        if (page.url().includes('localhost')) {
            callbackUrl = page.url();
        }
    }

    if (!callbackUrl) {
        console.log(`[阶段2] 检查是否需要手动点击授权...`);
        try {
            const authBtn = page.locator('button:has-text("Authorize"), button:has-text("Allow")').first();
            if (await authBtn.isVisible({ timeout: 5000 })) {
                await authBtn.click();
                await page.waitForTimeout(5000); // Wait for redirect to localhost
            }
        } catch(e) {}
    }

    if (!callbackUrl) {
        callbackUrl = page.url();
    }

    if (!callbackUrl || !callbackUrl.includes('code=')) {
        throw new Error(`[阶段2] 未能获取到授权回调 code，当前 URL: ${callbackUrl}`);
    }

    // 提取授权参数
    const params = oauthService.extractCallbackParams(callbackUrl);
    if (!params || params.error) {
        throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
    }
    
    console.log(`[阶段2] ✅ 成功获取授权码: ${params.code.substring(0, 10)}...`);
    
    // 用授权码换取 Token
    const tokenData = await oauthService.exchangeTokenAndSave(params.code, emailProvider.getEmail());
    
    return tokenData;
}

/**
 * 单次注册流程
 */
async function runSingleRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次全新的注册与授权流程 (Playwright)');
    console.log('=========================================');
    
    const emailProvider = new TempMailProvider(config.mailApiBaseUrl, 'spd100.shop');
    const browserbase = new BrowserbaseService();
    const oauthService = new OAuthService();
    let browser = null;
    
    try {
        // 0. 生成用户数据
        const userData = generateUserData();
        console.log(`[主程序] 用户数据已产生: ${userData.fullName} | ${userData.age} | ${userData.password}`);
        
        // 1. 生成独立的临时邮箱
        await emailProvider.generateAlias();
        
        // 2. 初始化 MailService
        const mailService = new MailService(config.mailApiBaseUrl, emailProvider.getJwt());
        
        // 3. 创建 Browserbase 会话
        const session = await browserbase.createSession();
        
        console.log(`[主程序] 正在连接 Browserbase CDP: ${session.wsUrl}`);
        browser = await chromium.connectOverCDP(session.wsUrl);
        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();
        
        // 4. 第一阶段：ChatGPT 注册
        await phase1(page, emailProvider, userData, mailService);
        
        // 5. 第二阶段：Codex OAuth 授权
        const tokenData = await phase2(page, emailProvider, oauthService);
        
        console.log('[主程序] 🎉 本次注册流程圆满结束！');
        console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
        
        return true;
        
    } catch (error) {
        console.error('[主程序] ❌ 本次任务执行失败:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

/**
 * 后备的基础代码流管理
 */
async function checkTokenCount() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) {
        return 0;
    }
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
    return files.length;
}

function archiveExistingTokens() {
    const outputDir = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(outputDir)) return;
    
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('token_') && f.endsWith('.json'));
    for (const file of files) {
        const oldPath = path.join(outputDir, file);
        const newPath = path.join(outputDir, `old_${file}`);
        fs.renameSync(oldPath, newPath);
    }
}

async function startBatch() {
    console.log(`[启动] 开始执行 Codex 远程注册机 (Playwright版) , 目标数量: ${TARGET_COUNT}`);
    
    if (!config.browserbaseApiKey) {
        console.error('[错误] 未配置 browserbaseApiKey，请检查 config.js');
        process.exit(1);
    }
    
    archiveExistingTokens();
    
    while (true) {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            console.log(`\n[完成] Token 数量 (${currentCount}) 达标程序退出。`);
            break;
        }
        
        console.log(`\n[进度] 目前 Token 数量 ${currentCount} / 目标 ${TARGET_COUNT}`);
        
        try {
            await runSingleRegistration();
        } catch (error) {
            const cooldown = 20000 + Math.random() * 20000;
            console.error(`[主程序] 注册失败，冷却 ${Math.round(cooldown / 1000)} 秒后重试...`);
            await new Promise(r => setTimeout(r, cooldown));
        }
    }
}

startBatch().catch(console.error);
