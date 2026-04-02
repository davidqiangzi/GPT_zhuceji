const { chromium } = require('playwright-core');
const axios = require('axios');

(async () => {
  try {
    const response = await axios.post(
      'https://gemini.browserbase.com/api/session',
      { timezone: 'HKT' }
    );
    const data = response.data;
    const wsMatch = data.sessionUrl.match(/wss=([^&]+)/);
    let wsUrl = wsMatch ? decodeURIComponent(wsMatch[1]) : null;
    const idx = wsUrl.indexOf('/devtools/page');
    if (idx !== -1) wsUrl = wsUrl.substring(0, idx);
    wsUrl = 'wss://' + wsUrl;

    console.log("Connecting to", wsUrl);
    const browser = await chromium.connectOverCDP(wsUrl);
    console.log("Connected!", await browser.version());
    await browser.close();
  } catch (e) {
    console.error("Test error:", e.message);
  }
})();
