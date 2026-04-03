const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { DDGEmailProvider } = require('./src/ddgProvider');
const { TempMailProvider } = require('./src/tempMailProvider');
const { BrowserbaseService } = require('./src/browserbaseService');
const { OAuthService } = require('./src/oauthService');
const { MailService } = require('./src/mailService');
const { generateRandomName, generateRandomPassword } = require('./src/randomIdentity');
const config = require('./src/config');

const TARGET_COUNT = parseInt(process.argv[2], 10) || 1;
const usedCodes = new Set(); // Track used verification codes to avoid reuse

function generateUserData() {
    const fullName = generateRandomName();
    const password = generateRandomPassword();
    const age = 25 + Math.floor(Math.random() * 16);
    const birthYear = new Date().getFullYear() - age;
    const birthMonth = 1 + Math.floor(Math.random() * 12);
    const birthDay = 1 + Math.floor(Math.random() * 28);
    return { fullName, password, age, birthMonth, birthDay, birthYear };
}

async function solveTurnstile(page) {
    try {
        const frames = page.frames();
        const frame = frames.find(f =>
            f.url().includes('cloudflare') || f.url().includes('turnstile') ||
            f.url().includes('challenge') || f.url().includes('captcha') || f.url().includes('hcaptcha')
        );
        if (frame) {
            await page.waitForTimeout(3000);
            for (const sel of ['input[type="checkbox"]', '.mark', '#challenge-stage', '#checkbox']) {
                const loc = frame.locator(sel).first();
                if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
                    console.log('[Turnstile] clicking:', sel);
                    await loc.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(5000);
                    return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

async function detectVerificationCodePage(page) {
    try {
        const t = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        if (t.includes('Check your inbox') || t.includes('Enter the code') ||
            t.includes('\u68c0\u67e5\u60a8\u7684\u6536\u4ef6\u7bb1') || t.includes('\u9a8c\u8bc1\u7801')) return true;
        if (await page.locator('input[inputmode="numeric"]').count() > 0) return true;
        if (await page.locator('input[name="code"], input[autocomplete="one-time-code"]').count() > 0) return true;
        if (page.url().includes('email-verification')) return true;
    } catch (e) {}
    return false;
}

/**
 * Detect and handle "about-you" / personal info page (both Phase1 and Phase2)
 * The page may ask for: full name + age, OR full name + birthday.
 * We handle both variants.
 */
async function handleAboutYouPage(page, userData) {
    const url = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const isAboutYou = url.includes('about-you') ||
        bodyText.includes('确认一下你的年龄') ||
        bodyText.includes('你的年龄是多少') ||
        bodyText.includes('Tell us about you') ||
        bodyText.includes('Verify your age') ||
        bodyText.includes('How old are you') ||
        bodyText.includes('完成帐户创建');
    
    if (!isAboutYou) return false;
    
    console.log('[AboutYou] Detected about-you page, URL:', url);
    console.log('[AboutYou] Page text preview:', bodyText.substring(0, 300));
    
    // Debug: log ALL inputs on the page
    try {
        const allPageInputs = page.locator('input');
        const totalInputs = await allPageInputs.count();
        console.log('[AboutYou] Total inputs on page:', totalInputs);
        for (let i = 0; i < totalInputs; i++) {
            const inp = allPageInputs.nth(i);
            const vis = await inp.isVisible().catch(() => false);
            const attrs = {
                name: await inp.getAttribute('name').catch(() => ''),
                type: await inp.getAttribute('type').catch(() => ''),
                placeholder: await inp.getAttribute('placeholder').catch(() => ''),
                value: await inp.inputValue().catch(() => ''),
                visible: vis,
            };
            console.log(`[AboutYou] Input[${i}]:`, JSON.stringify(attrs));
        }
    } catch (e) { console.log('[AboutYou] Input scan error:', e.message); }

    // ===== Fill NAME field =====
    const nameSelectors = [
        'input[name="name"]',
        'input[name="full_name"]',
        'input[name="fullName"]',
        'input[name="first-name"]',
        'input[name="firstName"]',
    ];
    
    let nameFilled = false;
    for (const sel of nameSelectors) {
        const inp = page.locator(sel).first();
        if (await inp.isVisible({ timeout: 1000 }).catch(() => false)) {
            await inp.click({ force: true }).catch(() => {});
            await inp.fill(userData.fullName);
            const val = await inp.inputValue().catch(() => '');
            console.log('[AboutYou] Name filled via:', sel, '->', val);
            nameFilled = true;
            break;
        }
    }
    if (!nameFilled) {
        console.log('[AboutYou] ⚠️ Could not find name field!');
    }
    
    // ===== Check if birthday picker is showing (year/month/day selects) =====
    // If so, try clicking "使用你的年龄" or similar link to switch to age input mode
    const ageInput = page.locator('input[name="age"]').first();
    const ageVisible = await ageInput.isVisible({ timeout: 500 }).catch(() => false);
    
    if (!ageVisible) {
        // Try to switch from birthday picker to age mode
        const switchSelectors = [
            'button:has-text("使用你的年龄")',
            'a:has-text("使用你的年龄")',
            'button:has-text("使用年龄")',
            'a:has-text("使用年龄")',
            'button:has-text("Use your age")',
            'a:has-text("Use your age")',
            'button:has-text("Use age")',
        ];
        let switched = false;
        for (const sel of switchSelectors) {
            const link = page.locator(sel).first();
            if (await link.isVisible({ timeout: 500 }).catch(() => false)) {
                const txt = await link.innerText().catch(() => '?');
                console.log('[AboutYou] Switching to age mode via:', txt);
                await link.click({ force: true }).catch(() => {});
                await page.waitForTimeout(1500);
                switched = true;
                break;
            }
        }
        
        // If no switch link found, try setting the hidden birthday field directly
        if (!switched) {
            console.log('[AboutYou] No age/switch link found, setting hidden birthday via JS...');
            const bdayValue = `${userData.birthYear}-${String(userData.birthMonth).padStart(2, '0')}-${String(userData.birthDay).padStart(2, '0')}`;
            await page.evaluate((val) => {
                const hidden = document.querySelector('input[name="birthday"]');
                if (hidden) {
                    // Set value using native setter to trigger React state update
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(hidden, val);
                    hidden.dispatchEvent(new Event('input', { bubbles: true }));
                    hidden.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log('Set hidden birthday to:', val);
                }
            }, bdayValue);
            console.log('[AboutYou] Hidden birthday set via JS');
            await page.waitForTimeout(1000);
        }
    }
    
    // ===== Fill AGE field (new format: just a number like "28") =====
    const ageSelectors = [
        'input[name="age"]',
        'input[name="user_age"]',
        'input[placeholder*="年龄"]',
        'input[placeholder*="age" i]',
        'input[aria-label*="年龄"]',
        'input[aria-label*="age" i]',
    ];
    
    const ageValue = String(userData.age);
    let ageFilled = false;
    
    for (const sel of ageSelectors) {
        const inp = page.locator(sel).first();
        if (await inp.isVisible({ timeout: 1000 }).catch(() => false)) {
            await inp.click({ force: true }).catch(() => {});
            await inp.fill(ageValue);
            const val = await inp.inputValue().catch(() => '');
            console.log('[AboutYou] Age filled via:', sel, '->', val);
            ageFilled = true;
            break;
        }
    }
    
    // ===== Fill BIRTHDAY field (old format: MM/DD/YYYY) =====
    if (!ageFilled) {
        const bdaySelectors = [
            'input[name="birthday"]',
            'input[name="dateOfBirth"]',
            'input[name="date_of_birth"]',
            'input[name="birthdate"]',
            'input[placeholder*="生日"]',
            'input[placeholder*="birth" i]',
            'input[placeholder*="YYYY"]',
        ];
        
        const bdayStr = String(userData.birthMonth).padStart(2, '0') + '/' + 
                        String(userData.birthDay).padStart(2, '0') + '/' + 
                        userData.birthYear;
        
        for (const sel of bdaySelectors) {
            const inp = page.locator(sel).first();
            if (await inp.isVisible({ timeout: 1000 }).catch(() => false)) {
                await inp.click({ force: true }).catch(() => {});
                await inp.fill(bdayStr);
                console.log('[AboutYou] Birthday filled via:', sel, '->', bdayStr);
                ageFilled = true;
                break;
            }
        }
    }
    
    // Fallback: if neither age nor birthday found, try the second visible input
    if (!ageFilled) {
        console.log('[AboutYou] No age/birthday field found by name, trying second visible input...');
        const allInputs = page.locator('input');
        const count = await allInputs.count();
        let visIdx = 0;
        for (let i = 0; i < count; i++) {
            const inp = allInputs.nth(i);
            if (await inp.isVisible().catch(() => false)) {
                visIdx++;
                if (visIdx === 2) {
                    await inp.click({ force: true }).catch(() => {});
                    await inp.fill(ageValue);
                    const val = await inp.inputValue().catch(() => '');
                    console.log('[AboutYou] Age filled via generic 2nd input:', val);
                    ageFilled = true;
                    break;
                }
            }
        }
    }
    
    if (!ageFilled) {
        console.log('[AboutYou] ⚠️ Could not find age/birthday field!');
    }
    
    await page.waitForTimeout(1000);
    
    // Click submit button (use force:true because overlays can block)
    const submitSelectors = [
        'button:has-text("完成帐户创建")',
        'button:has-text("Complete")',
        'button:has-text("Continue")',
        'button:has-text("继续")',
        'button:has-text("Agree")',
        'button:has-text("Submit")',
        'button[type="submit"]',
    ];
    
    for (const sel of submitSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            const btnText = await btn.innerText().catch(() => '?');
            console.log('[AboutYou] Clicking submit:', btnText, `(${sel})`);
            await btn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(3000);
            break;
        }
    }
    
    // Handle age confirmation dialog:
    // "你正在将出生日期设置为 YYYY年M月D日" with "确定" (Confirm) / "取消" (Cancel)
    const confirmSelectors = [
        'button:has-text("确定")',
        'button:has-text("Confirm")',
        'button:has-text("OK")',
        'button:has-text("Yes")',
    ];
    for (const sel of confirmSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            const btnText = await btn.innerText().catch(() => '?');
            console.log('[AboutYou] Age confirmation dialog found! Clicking:', btnText);
            await btn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(3000);
            break;
        }
    }
    
    // After confirmation, try clicking submit again if still on about-you
    if (page.url().includes('about-you')) {
        for (const sel of submitSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                console.log('[AboutYou] Re-clicking submit after dialog');
                await btn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(3000);
                break;
            }
        }
        
        // Check for another dialog
        for (const sel of confirmSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                console.log('[AboutYou] Second confirmation dialog, clicking confirm');
                await btn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(3000);
                break;
            }
        }
    }
    
    // Check if form had errors
    const postText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    if (postText.includes('无法根据该信息') || postText.includes('请输入有效年龄') || 
        postText.includes('Cannot create') || postText.includes('invalid age') ||
        postText.includes('Please try again')) {
        console.log('[AboutYou] ⚠️ Form error after submit:', postText.substring(0, 200));

        await page.screenshot({ path: `error_aboutyou_${Date.now()}.png` });
    }
    
    console.log('[AboutYou] Post-submit URL:', page.url());
    return true;
}

/**
 * Handle "add-phone" page by looking for skip/later option
 */
async function handleAddPhonePage(page) {
    const url = page.url();
    if (!url.includes('add-phone')) return false;
    
    console.log('[AddPhone] Detected add-phone page:', url);
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    console.log('[AddPhone] Page text:', bodyText.substring(0, 300));
    
    // Try to find skip/later/not now button
    const skipSelectors = [
        'button:has-text("Skip")',
        'button:has-text("跳过")',
        'button:has-text("Later")',
        'button:has-text("以后再说")',
        'button:has-text("Not now")',
        'button:has-text("暂不")',
        'a:has-text("Skip")',
        'a:has-text("跳过")',
        'a:has-text("Later")',
        'a:has-text("以后再说")',
        'a:has-text("Not now")',
        '[data-testid="skip"]',
        '[data-testid="skip-button"]',
    ];
    
    for (const sel of skipSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            const txt = await btn.innerText().catch(() => '?');
            console.log('[AddPhone] Found skip button:', txt, `(${sel})`);
            await btn.click();
            await page.waitForTimeout(3000);
            console.log('[AddPhone] After skip URL:', page.url());
            return true;
        }
    }
    
    // Try any link/button that might skip
    console.log('[AddPhone] No skip button found, checking all buttons...');
    const allButtons = page.locator('button, a');
    const btnCount = await allButtons.count();
    for (let i = 0; i < btnCount; i++) {
        const btn = allButtons.nth(i);
        if (await btn.isVisible().catch(() => false)) {
            const txt = await btn.innerText().catch(() => '');
            const href = await btn.getAttribute('href').catch(() => '');
            console.log(`[AddPhone] Button[${i}]: "${txt}" href=${href}`);
        }
    }
    
    // Take screenshot for debugging
    await page.screenshot({ path: `stuck_addphone_${Date.now()}.png` });
    return false;
}

async function fillAndSubmitEmail(page, email) {
    const el = page.locator('input[type="email"], input[name="email"], input[name="username"]').locator('visible=true').first();
    if (!await el.isVisible({ timeout: 3000 }).catch(() => false)) return false;
    await el.fill(email);
    console.log('[fillEmail]', email);
    for (let i = 0; i < 3; i++) {
        const cu = page.url();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        for (const s of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("\u7ee7\u7eed")']) {
            try { const b = page.locator(s).first(); if (await b.isVisible() && await b.isEnabled()) await b.click({ timeout: 5000 }).catch(() => {}); } catch (e) {}
        }
        await solveTurnstile(page);
        await page.waitForTimeout(3000);
        if (page.url() !== cu || await page.locator('input[type="password"]').isVisible().catch(() => false) || await detectVerificationCodePage(page)) {
            console.log('[fillEmail] transitioned');
            return true;
        }
    }
    return false;
}

/**
 * Helper: fill verification code on current page, polling mail service
 */
async function handleVerificationCode(page, mailService, label) {
    console.log('[' + label + '] Polling for verification code...');
    console.log('[' + label + '] Current URL before poll:', page.url());
    
    // Debug: log all visible inputs on the page
    try {
        const allInputs = page.locator('input');
        const inputCount = await allInputs.count();
        console.log('[' + label + '] Found', inputCount, 'input elements on page');
        for (let i = 0; i < Math.min(inputCount, 10); i++) {
            const inp = allInputs.nth(i);
            const vis = await inp.isVisible().catch(() => false);
            if (vis) {
                const attrs = {
                    name: await inp.getAttribute('name').catch(() => ''),
                    type: await inp.getAttribute('type').catch(() => ''),
                    inputmode: await inp.getAttribute('inputmode').catch(() => ''),
                    autocomplete: await inp.getAttribute('autocomplete').catch(() => ''),
                    placeholder: await inp.getAttribute('placeholder').catch(() => ''),
                    id: await inp.getAttribute('id').catch(() => ''),
                };
                console.log(`[${label}] Input[${i}] visible:`, JSON.stringify(attrs));
            }
        }
    } catch (e) { console.log('[' + label + '] Debug input scan error:', e.message); }

    const codeRequestTime = Date.now();
    console.log(`[${label}] Code request timestamp: ${new Date(codeRequestTime).toISOString()}`);
    
    const pollStart = Date.now();
    let code = null;
    while (Date.now() - pollStart < 120000) {
        try {
            code = await mailService.waitForVerificationCode({ 
                pollInterval: 5000, 
                timeout: 15000, 
                fromFilter: 'openai'
            });
            if (code && usedCodes.has(code)) {
                console.log(`[${label}] Code ${code} already used, waiting for new one...`);
                code = null;
                continue;
            }
            if (code) break;
        } catch (e) {}
    }
    if (!code) throw new Error('[' + label + '] Code timeout');
    usedCodes.add(code);
    console.log('[' + label + '] Got code:', code, '(total used:', usedCodes.size, ')');

    const urlBefore = page.url();
    let codeFilled = false;

    // Strategy 1: Try single code input field
    for (const sel of ['input[name="code"]', 'input[inputmode="numeric"]', 'input[autocomplete="one-time-code"]']) {
        const inp = page.locator(sel).first();
        if (await inp.isVisible({ timeout: 2000 }).catch(() => false)) {
            await inp.click();
            await inp.fill('');
            // Try fill first, then type as fallback
            await inp.fill(code);
            const filled = await inp.inputValue().catch(() => '');
            console.log(`[${label}] Filled via ${sel}, value now: "${filled}"`);
            if (!filled || filled !== code) {
                console.log(`[${label}] Fill didn't stick, trying keyboard type...`);
                await inp.click();
                await inp.fill('');
                await page.keyboard.type(code, { delay: 80 });
                const typed = await inp.inputValue().catch(() => '');
                console.log(`[${label}] After type, value: "${typed}"`);
            }
            codeFilled = true;
            break;
        }
    }

    // Strategy 2: OTP-style individual digit inputs (6 separate inputs)
    if (!codeFilled) {
        const otpInputs = page.locator('input[type="text"], input[type="number"], input[type="tel"]');
        const otpCount = await otpInputs.count();
        console.log(`[${label}] Checking for OTP-style inputs: found ${otpCount}`);
        if (otpCount >= 4 && otpCount <= 8) {
            console.log(`[${label}] Attempting OTP digit-by-digit fill (${otpCount} inputs)`);
            for (let i = 0; i < Math.min(code.length, otpCount); i++) {
                const digitInput = otpInputs.nth(i);
                if (await digitInput.isVisible().catch(() => false)) {
                    await digitInput.click();
                    await digitInput.fill(code[i]);
                    await page.waitForTimeout(100);
                }
            }
            codeFilled = true;
            console.log(`[${label}] OTP digits filled`);
        }
    }

    // Strategy 3: Last resort - try any visible text input
    if (!codeFilled) {
        console.log(`[${label}] Fallback: trying any visible text input`);
        const anyInput = page.locator('input[type="text"]').first();
        if (await anyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await anyInput.click();
            await anyInput.fill('');
            await page.keyboard.type(code, { delay: 80 });
            codeFilled = true;
            console.log(`[${label}] Code typed into fallback text input`);
        }
    }

    if (!codeFilled) {
        console.log(`[${label}] ⚠️ WARNING: Could not find any input to fill code!`);
        await page.screenshot({ path: `error_code_noinput_${Date.now()}.png` });
    }

    // Submit the code
    await page.waitForTimeout(1000);
    console.log(`[${label}] Submitting code...`);
    
    // Try Enter key first
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    
    // Check if page changed
    let urlAfter = page.url();
    console.log(`[${label}] After Enter: URL ${urlBefore} -> ${urlAfter}`);
    
    if (urlAfter === urlBefore || urlAfter.includes('email-verification')) {
        // Try clicking Continue/Submit button
        for (const sel of [
            'button:has-text("继续")', 
            'button:has-text("Continue")', 
            'button[type="submit"]',
            'button:has-text("Verify")',
            'button:has-text("验证")',
        ]) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                const btnText = await btn.innerText().catch(() => '?');
                console.log(`[${label}] Clicking button: "${btnText}" (${sel})`);
                await btn.click().catch(() => {});
                await page.waitForTimeout(3000);
                break;
            }
        }
    }

    urlAfter = page.url();
    console.log(`[${label}] Post-submit URL: ${urlAfter}`);
    
    // Check for "code incorrect" error and retry with resend
    let bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    let retryCount = 0;
    
    while (retryCount < 3 && urlAfter.includes('email-verification')) {
        // Check for code incorrect error
        if (bodyText.includes('代码不正确') || bodyText.includes('incorrect') || 
            bodyText.includes('invalid') || bodyText.includes('expired') || bodyText.includes('wrong code')) {
            retryCount++;
            console.log(`[${label}] ⚠️ Code incorrect! Retry ${retryCount}/3...`);
            
            // Click "Resend email" / "重新发送电子邮件"
            for (const sel of [
                'button:has-text("重新发送电子邮件")',
                'button:has-text("Resend")',
                'a:has-text("重新发送")',
                'a:has-text("Resend")',
            ]) {
                const resendBtn = page.locator(sel).first();
                if (await resendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    console.log(`[${label}] Clicking resend: ${sel}`);
                    await resendBtn.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(3000);
                    break;
                }
            }
            
            // Wait for fresh code (mark timestamp NOW for fresh code)
            const resendTime = Date.now();
            console.log(`[${label}] Waiting for fresh code after resend...`);
            let freshCode = null;
            const freshPollStart = Date.now();
            while (Date.now() - freshPollStart < 60000) {
                try {
                    freshCode = await mailService.waitForVerificationCode({ 
                        pollInterval: 5000, timeout: 15000, fromFilter: 'openai'
                    });
                    if (freshCode && !usedCodes.has(freshCode) && freshCode !== code) {
                        break;
                    }
                    freshCode = null;
                } catch (e) {}
            }
            
            if (!freshCode) {
                console.log(`[${label}] No fresh code received after resend`);
                continue;
            }
            
            usedCodes.add(freshCode);
            code = freshCode;
            console.log(`[${label}] Got fresh code: ${code}`);
            
            // Fill the fresh code
            const codeInput = page.locator('input[name="code"], input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
            if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                await codeInput.click({ force: true }).catch(() => {});
                await codeInput.fill('');
                await codeInput.fill(code);
                const v = await codeInput.inputValue().catch(() => '');
                console.log(`[${label}] Fresh code filled: ${v}`);
            }
            
            // Submit
            await page.waitForTimeout(500);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            
            // Click Continue if visible
            for (const sel of ['button:has-text("继续")', 'button:has-text("Continue")', 'button[type="submit"]']) {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await btn.click().catch(() => {});
                    await page.waitForTimeout(3000);
                    break;
                }
            }
            
            urlAfter = page.url();
            bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
            console.log(`[${label}] After retry ${retryCount}: URL=${urlAfter}`);
        } else {
            // No error but still on verification page, just wait
            console.log(`[${label}] Still on verification page, waiting...`);
            await page.waitForTimeout(5000);
            urlAfter = page.url();
            bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
            if (!urlAfter.includes('email-verification')) break;
            
            // Take screenshot
            await page.screenshot({ path: `stuck_verification_${Date.now()}.png` });
            console.log(`[${label}] ⚠️ STUCK on email-verification. Body:`, bodyText.substring(0, 300));
            break;
        }
    }
    
    return code;
}

async function phase1(page, emailProvider, userData, mailService) {
    console.log('\n========= Phase 1: Registration =========');
    const email = emailProvider.getEmail();

    await page.goto('https://chatgpt.com/auth/login?screen_hint=signup', { waitUntil: 'load', timeout: 60000 });
    console.log('[Phase1] URL:', page.url());

    // Click signup if needed
    if (!(await page.locator('input[type="email"], input[name="email"], input[name="username"]').locator('visible=true').count() > 0)) {
        const sb = page.locator('[data-testid="signup-button"], button:has-text("Sign up"), button:has-text("\u6ce8\u518c")').locator('visible=true').first();
        if (await sb.isVisible({ timeout: 5000 }).catch(() => false)) { await sb.click(); await page.waitForTimeout(3000); }
    }
    await solveTurnstile(page);

    // Wait for email input
    const el = page.locator('input[type="email"], input[name="email"], input[name="username"]').locator('visible=true').first();
    for (let i = 0; i < 15; i++) {
        try { await el.waitFor({ state: 'visible', timeout: 5000 }); break; } catch (e) { await solveTurnstile(page); }
        if (i === 14) throw new Error('Email input not found');
    }

    await fillAndSubmitEmail(page, email);

    // Detect page type with recovery
    const pwdLoc = page.locator('input[type="password"], input[name="password"]').locator('visible=true').first();
    let flowType = 'unknown';
    for (let i = 0; i < 40; i++) {
        try {
            const pc = await page.content().catch(() => '');
            if (pc.includes('Operation timed out') || pc.includes('Something went wrong') || pc.includes('Access Denied')) {
                console.log('[Phase1] Page error, reloading...');
                await page.reload({ waitUntil: 'load' }).catch(() => {}); await page.waitForTimeout(5000);
            }
            const ev = await page.locator('input[type="email"], input[name="email"], input[name="username"]').locator('visible=true').first().isVisible({ timeout: 500 }).catch(() => false);
            if (ev) { console.log('[Phase1] Back on email page'); await fillAndSubmitEmail(page, email); continue; }
            if (await pwdLoc.isVisible({ timeout: 1000 }).catch(() => false)) { flowType = 'password'; console.log('[Phase1] PASSWORD page'); break; }
            if (await detectVerificationCodePage(page)) { flowType = 'verification'; console.log('[Phase1] VERIFICATION page'); break; }
        } catch (err) { if (err.message.includes('closed')) throw err; }
        await solveTurnstile(page);
        if (page.url().includes('/api/auth/error')) {
            await page.goto('https://chatgpt.com/auth/login?screen_hint=signup', { waitUntil: 'load' });
            await page.waitForTimeout(3000); await fillAndSubmitEmail(page, email);
        }
        if (i % 5 === 0 && i > 0) console.log('[Phase1] Waiting...', i * 2, 's');
        await page.waitForTimeout(2000);
    }

    if (flowType === 'unknown') {
        await page.screenshot({ path: 'error_flow_' + Date.now() + '.png' });
        throw new Error('Flow timeout. URL: ' + page.url());
    }

    if (flowType === 'password') {
        await pwdLoc.fill(userData.password);
        console.log('[Phase1] Password filled');
        for (let j = 0; j < 3; j++) {
            const cu = page.url();
            await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
            for (const s of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("\u7ee7\u7eed")']) {
                try { const b = page.locator(s).first(); if (await b.isVisible() && await b.isEnabled()) await b.click({ timeout: 5000 }).catch(() => {}); } catch (e) {}
            }
            await solveTurnstile(page);
            if (page.url() !== cu || await detectVerificationCodePage(page)) { console.log('[Phase1] Password OK'); break; }
            if (j === 2) { await page.reload({ waitUntil: 'load' }).catch(() => {}); await page.waitForTimeout(5000); }
        }
    }

    // Handle verification code
    await handleVerificationCode(page, mailService, 'Phase1');

    // Post-code password setup (new flow)
    if (flowType === 'verification') {
        await page.waitForTimeout(3000);
        const pp = page.locator('input[type="password"]').first();
        if (await pp.isVisible({ timeout: 10000 }).catch(() => false)) {
            await pp.fill(userData.password);
            const cp = page.locator('input[type="password"]').nth(1);
            if (await cp.isVisible({ timeout: 2000 }).catch(() => false)) await cp.fill(userData.password);
            await page.keyboard.press('Enter'); await page.waitForTimeout(3000);
        }
    }

    // Personal info / about-you page
    console.log('[Phase1] Checking for personal info page... URL:', page.url());
    for (let attempt = 0; attempt < 3; attempt++) {
        const handled = await handleAboutYouPage(page, userData);
        if (handled) {
            console.log('[Phase1] Personal info handled (attempt', attempt + 1, ')');
            await page.waitForTimeout(3000);
            // Check if we moved past the page
            if (!page.url().includes('about-you')) {
                console.log('[Phase1] ✅ Moved past about-you page');
                break;
            }
            console.log('[Phase1] Still on about-you, retrying...');
        } else {
            // Try old-style personal info form
            try {
                const fn = page.locator('input[name="first-name"], input[name="firstName"]').first();
                if (await fn.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await fn.fill(userData.fullName.split(' ')[0]);
                    await page.locator('input[name="last-name"], input[name="lastName"]').first().fill(userData.fullName.split(' ')[1] || 'Smith');
                    const bd = page.locator('input[name="birthday"], input[name="dateOfBirth"]').first();
                    if (await bd.isVisible()) await bd.fill(String(userData.birthMonth).padStart(2, '0') + '/' + String(userData.birthDay).padStart(2, '0') + '/' + userData.birthYear);
                    await page.locator('button:has-text("Agree"), button:has-text("Continue"), button:has-text("\u7ee7\u7eed")').first().click();
                    console.log('[Phase1] Personal info OK (old form)');
                } else {
                    console.log('[Phase1] No personal info form found, continuing...');
                }
            } catch (e) { console.log('[Phase1] Personal info skipped:', e.message); }
            break;
        }
    }

    await page.waitForTimeout(5000);
    console.log('[Phase1] Done. Final URL:', page.url());
    return true;
}

async function phase2(page, emailProvider, oauthService, password, mailService, userData) {
    console.log('\n========= Phase 2: OAuth =========');
    oauthService.regeneratePKCE();
    const email = emailProvider.getEmail();

    let callbackUrl = null;
    
    // Capture localhost redirects via request events
    // Must check actual hostname, not just string includes (redirect_uri contains 'localhost')
    const isLocalhostUrl = (url) => {
        try { 
            const u = new URL(url); 
            return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; 
        } catch { return false; }
    };
    
    page.on('request', request => {
        const url = request.url();
        if (isLocalhostUrl(url)) {
            console.log('[Phase2] Request to localhost:', url.substring(0, 150));
            if (!callbackUrl) callbackUrl = url;
        }
    });
    
    page.on('requestfailed', request => {
        const url = request.url();
        if (isLocalhostUrl(url)) {
            console.log('[Phase2] Failed request to localhost (expected):', url.substring(0, 150));
            if (!callbackUrl) callbackUrl = url;
        }
    });
    
    // Also listen for frame navigation as backup
    page.on('framenavigated', frame => {
        const url = frame.url();
        if (url.includes('http://localhost') && (url.includes('code=') || url.includes('error='))) {
            callbackUrl = url;
            console.log('[Phase2] Callback via framenavigated:', url.substring(0, 120));
        }
    });

    // Strategy 1: Try prompt=none (reuse existing session from Phase 1)
    const authUrlNone = oauthService.getAuthUrl('none');
    console.log('[Phase2] Trying prompt=none (reuse session)...');
    
    try { 
        await page.goto(authUrlNone, { waitUntil: 'domcontentloaded', timeout: 30000 }); 
    } catch (e) { 
        console.log('[Phase2] Navigation result:', e.message.substring(0, 100));
    }
    
    await page.waitForTimeout(2000);
    console.log('[Phase2] After prompt=none: callbackUrl=', callbackUrl ? callbackUrl.substring(0, 120) : 'null');
    console.log('[Phase2] After prompt=none: pageUrl=', page.url().substring(0, 80));
    
    // Check prompt=none result
    if (callbackUrl && callbackUrl.includes('code=')) {
        console.log('[Phase2] ✅ prompt=none worked! Got auth code');
    } else if (callbackUrl && callbackUrl.includes('error=')) {
        // prompt=none returned login_required or similar error
        try {
            const errorUrl = new URL(callbackUrl);
            console.log('[Phase2] prompt=none error:', errorUrl.searchParams.get('error'));
        } catch (e) {}
        callbackUrl = null;
        
        // Fall back to prompt=login (DO NOT regenerate PKCE - keep same state!)
        console.log('[Phase2] Falling back to prompt=login...');
        const authUrlLogin = oauthService.getAuthUrl('login');
        
        try { await page.goto(authUrlLogin, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch (e) { console.log('[Phase2] Login nav:', e.message.substring(0, 80)); }
    } else {
        // No callback at all - check what page we're on
        const currentUrl = page.url();
        if (currentUrl.includes('chrome-error') || currentUrl.includes('chromewebdata')) {
            console.log('[Phase2] Chrome error - falling back to prompt=login');
            const authUrlLogin2 = oauthService.getAuthUrl('login');
            try { await page.goto(authUrlLogin2, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
            catch (e) { console.log('[Phase2] Login nav:', e.message.substring(0, 80)); }
        } else if (currentUrl.includes('log-in') || currentUrl.includes('authorize')) {
            console.log('[Phase2] On auth page, continuing with login flow...');
        }
    }

    if (callbackUrl && callbackUrl.includes('code=')) {
        console.log('[Phase2] Got callback early, skipping login flow');
    } else {
        await page.waitForTimeout(5000);
        await solveTurnstile(page);
        console.log('[Phase2] Post-redirect:', page.url());

        const onLogin = page.url().includes('auth.openai.com/log-in') ||
            page.url().includes('log-in-or-create-account');

        if (onLogin && !callbackUrl) {
            console.log('[Phase2] Login required, auto-logging in...');

            // Fill email
            for (let a = 0; a < 5; a++) {
                await solveTurnstile(page);
                const ei = page.locator('input[type="email"], input[name="email"], input[name="username"]').locator('visible=true').first();
                if (await ei.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await ei.fill(email);
                    console.log('[Phase2] Email:', email);
                    await page.keyboard.press('Enter'); await page.waitForTimeout(3000);
                    for (const s of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("\u7ee7\u7eed")']) {
                        try { const b = page.locator(s).first(); if (await b.isVisible() && await b.isEnabled()) await b.click({ timeout: 5000 }).catch(() => {}); } catch (e) {}
                    }
                    await page.waitForTimeout(5000);
                    await solveTurnstile(page);

                    // Password
                    const pi = page.locator('input[type="password"]').locator('visible=true').first();
                    if (await pi.isVisible({ timeout: 15000 }).catch(() => false)) {
                        console.log('[Phase2] Password page');
                        await pi.fill(password);
                        await page.keyboard.press('Enter'); await page.waitForTimeout(3000);
                        for (const s of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("\u7ee7\u7eed")']) {
                            try { const b = page.locator(s).first(); if (await b.isVisible() && await b.isEnabled()) await b.click({ timeout: 5000 }).catch(() => {}); } catch (e) {}
                        }
                        await page.waitForTimeout(5000);
                        await solveTurnstile(page);
                    }
                    break;
                }
                console.log('[Phase2] Email input not found, attempt', a + 1);
                await page.waitForTimeout(3000);
            }

            // After login, check for email verification
            console.log('[Phase2] Post-login URL:', page.url());
            if (page.url().includes('email-verification') || await detectVerificationCodePage(page)) {
                console.log('[Phase2] Email verification required during OAuth login!');
                await handleVerificationCode(page, mailService, 'Phase2');
                await page.waitForTimeout(5000);
                console.log('[Phase2] Post-verification URL:', page.url());
            }

            // Handle add-phone page if it appears after verification
            if (page.url().includes('add-phone')) {
                console.log('[Phase2] Add-phone page detected after verification!');
                await handleAddPhonePage(page);
                await page.waitForTimeout(3000);
                console.log('[Phase2] Post-add-phone URL:', page.url());
            }

            // Handle about-you page if it appears after login
            if (page.url().includes('about-you')) {
                console.log('[Phase2] About-you page detected after OAuth login!');
                for (let attempt = 0; attempt < 3; attempt++) {
                    await handleAboutYouPage(page, userData);
                    await page.waitForTimeout(3000);
                    if (!page.url().includes('about-you')) {
                        console.log('[Phase2] ✅ Moved past about-you page');
                        break;
                    }
                    console.log('[Phase2] Still on about-you, attempt', attempt + 2);
                }
            }

            // Wait for OAuth redirect
            console.log('[Phase2] Waiting for OAuth redirect...');
            for (let i = 0; i < 30; i++) {
                if (callbackUrl) break;
                if (page.url().includes('localhost')) { callbackUrl = page.url(); break; }
                
                // Handle add-phone page
                if (page.url().includes('add-phone')) {
                    console.log('[Phase2] add-phone page appeared during redirect wait');
                    await handleAddPhonePage(page);
                    await page.waitForTimeout(3000);
                    continue;
                }
                
                // Handle about-you page if it appears mid-redirect
                if (page.url().includes('about-you')) {
                    console.log('[Phase2] about-you page appeared during redirect wait');
                    await handleAboutYouPage(page, userData);
                    await page.waitForTimeout(3000);
                    continue;
                }
                
                try {
                    const ab = page.locator('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("\u5141\u8bb8")').first();
                    if (await ab.isVisible({ timeout: 2000 })) { console.log('[Phase2] Authorize button'); await ab.click(); await page.waitForTimeout(5000); }
                } catch (e) {}
                await solveTurnstile(page);
                
                if (i % 5 === 0) console.log('[Phase2] Redirect wait iteration', i, 'URL:', page.url());
                await page.waitForTimeout(2000);
            }
        }

        // Final authorize check
        if (!callbackUrl) {
            try {
                const ab = page.locator('button:has-text("Authorize"), button:has-text("Allow")').first();
                if (await ab.isVisible({ timeout: 5000 })) { await ab.click(); await page.waitForTimeout(5000); }
            } catch (e) {}
        }
    }

    if (!callbackUrl) callbackUrl = page.url();
    console.log('[Phase2] Final:', callbackUrl);

    if (!callbackUrl || !callbackUrl.includes('code=')) {
        await page.screenshot({ path: 'error_oauth_' + Date.now() + '.png' });
        throw new Error('[Phase2] No code. URL: ' + callbackUrl);
    }

    const params = oauthService.extractCallbackParams(callbackUrl);
    if (!params || params.error) throw new Error('OAuth: ' + (params?.error_description || params?.error || '?'));

    console.log('[Phase2] Code:', params.code.substring(0, 10) + '...');
    return await oauthService.exchangeTokenAndSave(params.code, email);
}

// Bypasses Phase 2 OAuth Flow: directly extracts accessToken from chatgpt.com session API
async function extractSessionTokenAndSave(page, email, password) {
    console.log('\n========= Phase 2 (Skip OAuth): Fetching Web Session =========');
    await page.goto('https://chatgpt.com/api/auth/session', { waitUntil: 'networkidle', timeout: 30000 });
    
    const content = await page.evaluate(() => document.body.innerText);
    try {
        const session = JSON.parse(content);
        if (!session.accessToken) {
            console.log('[Phase2] Could not find accessToken in session:', content.substring(0, 200));
            throw new Error('No accessToken found in session JSON');
        }
        console.log('[Phase2] ✅ Successfully got accessToken from session API');
        
        let accountId = "";
        try {
            const payloadStr = Buffer.from(session.accessToken.split('.')[1], 'base64').toString('utf8');
            const payload = JSON.parse(payloadStr);
            const apiAuth = payload['https://api.openai.com/auth'] || {};
            accountId = apiAuth.chatgpt_account_id || "";
        } catch (e) {
            console.error('[Phase2] 解析 access_token 获取 account_id 失败:', e.message);
        }
        
        const now = new Date();
        const expiredTime = session.expires ? new Date(session.expires) : new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
        
        const outData = {
            access_token: session.accessToken,
            account_id: accountId,
            disabled: false,
            email: email,
            expired: expiredTime.toISOString().replace(/\.[0-9]{3}Z$/, '+08:00'),
            id_token: session.idToken || "",
            last_refresh: now.toISOString().replace(/\.[0-9]{3}Z$/, '+08:00'),
            refresh_token: session.refreshToken || "",
            type: 'codex'
        };
        
        const outDataWithPassword = { ...outData, password };
        
        const outputDir = path.join(process.cwd(), 'tokens');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const timestamp = Date.now();
        // 1. 保留给第三方导入工具的纯净版
        const cleanFilepath = path.join(outputDir, `token_${timestamp}.json`);
        fs.writeFileSync(cleanFilepath, JSON.stringify(outData, null, 2));
        
        // 2. 带密码的 JSON，供自己内部读取的增强版
        const adminFilepath = path.join(outputDir, `admin_${timestamp}.json`);
        fs.writeFileSync(adminFilepath, JSON.stringify(outDataWithPassword, null, 2));
        
        // 3. 追加 txt 文档的记录
        const accountsFile = path.join(process.cwd(), 'accounts.txt');
        const accountRecord = `Email: ${email} | Password: ${password} | AccountID: ${accountId} | Time: ${new Date().toLocaleString()}\n`;
        fs.appendFileSync(accountsFile, accountRecord);
        
        console.log(`[Phase2] ✅ 纯净 Token 保存至: ${cleanFilepath}`);
        console.log(`[Phase2] ✅ 附带账密 Token 保存至: ${adminFilepath}`);
        return outDataWithPassword;
    } catch(e) {
        console.log('[Phase2] Failed to parse session JSON:', e.message);
        throw e;
    }
}

async function runSingleRegistration() {
    console.log('\n========= New Registration =========');
    const emailProvider = new TempMailProvider(config.mailApiBaseUrl, 'spd100.shop');
    const browserbase = new BrowserbaseService();
    const oauthService = new OAuthService();
    let browser = null, page = null;

    try {
        const userData = generateUserData();
        console.log('[Main] User:', userData.fullName, '| Pwd:', userData.password);
        await emailProvider.generateAlias();
        const dynamicJwt = emailProvider.getJwt();
        console.log('[Main] Mail:', emailProvider.getEmail());
        const mailService = new MailService(config.mailApiBaseUrl, dynamicJwt);

        if (config.useLocalBrowser) {
            try {
                browser = await chromium.launch({ headless: false, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] });
            } catch (err) {
                browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] });
            }
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            page = await ctx.newPage();
        } else {
            const session = await browserbase.createSession();
            browser = await chromium.connectOverCDP(session.wsUrl);
            const ctx = browser.contexts()[0];
            page = ctx.pages()[0] || await ctx.newPage();
        }

        await phase1(page, emailProvider, userData, mailService);
        // Bypassing normal OAuth phase2 entirely!
        const tokenData = await extractSessionTokenAndSave(page, emailProvider.getEmail(), userData.password);
        console.log('[Main] SUCCESS! Email:', tokenData.email);
        return true;
    } catch (error) {
        console.log('[Main] FAILED:', error.stack || error.message || error);
        throw error;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function checkTokenCount() {
    const d = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(d)) return 0;
    return fs.readdirSync(d).filter(f => f.startsWith('token_') && f.endsWith('.json')).length;
}

function archiveExistingTokens() {
    const d = path.join(process.cwd(), 'tokens');
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d).filter(f => f.startsWith('token_') && f.endsWith('.json')))
        fs.renameSync(path.join(d, f), path.join(d, 'old_' + f));
}

async function startBatch() {
    console.log('[Start] Target:', TARGET_COUNT);
    if (!config.useLocalBrowser && !config.browserbaseApiKey) { console.error('[Error] No API key'); process.exit(1); }
    archiveExistingTokens();
    while (true) {
        const c = await checkTokenCount();
        if (c >= TARGET_COUNT) { console.log('[Done]', c); break; }
        console.log('[Progress]', c, '/', TARGET_COUNT);
        try { await runSingleRegistration(); } catch (error) {
            const cd = 20000 + Math.random() * 20000;
            console.error('[Main] Cooldown', Math.round(cd / 1000), 's');
            await new Promise(r => setTimeout(r, cd));
        }
    }
}

startBatch().catch(console.error);
