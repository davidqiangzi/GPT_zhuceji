const { chromium } = require('playwright-core');

(async () => {
  const wsUrl = "wss://connect.browserbase.com/debug/fb34abac-9207-40bc-9350-bc900ff3c6db";
  try {
    console.log("Connecting...");
    const browser = await chromium.connectOverCDP(wsUrl, { timeout: 5000 });
    console.log("Connected!", await browser.version());
    await browser.close();
  } catch (e) {
    console.error("Browser ws:", e.message);
  }
})();
