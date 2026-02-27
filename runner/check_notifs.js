const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:18801');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  const tabs = await page.$$eval('[role="tab"]', els => els.map(e => e.innerText.trim()));
  console.log('Tabs:', JSON.stringify(tabs));

  for (const t of await page.$$('[role="tab"]')) {
    const label = await t.innerText().catch(() => '');
    if (/mentions/i.test(label)) {
      await t.click();
      await page.waitForTimeout(1500);
      console.log('Clicked mentions tab');
      break;
    }
  }

  await page.waitForTimeout(1000);

  const articles = await page.$$eval('article[data-testid="tweet"]', els => els.map(a => {
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const userEl = a.querySelector('[data-testid="User-Name"]');
    const link   = a.querySelector('a[href*="/status/"]');
    const id     = link && link.href.match(/\/status\/(\d+)/) ? link.href.match(/\/status\/(\d+)/)[1] : '';
    return { id, user: userEl ? userEl.innerText.split('\n')[0] : '', text: textEl ? textEl.innerText.slice(0, 120) : '' };
  }));
  console.log('Articles found:', articles.length);
  console.log(JSON.stringify(articles, null, 2));

  await browser.close();
})().catch(e => console.error(e.message));
