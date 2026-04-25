#!/usr/bin/env node
'use strict';
// Debug script: check what the notifications/mentions page renders
const { connectBrowser } = require('../scraper/lib/browser');

(async () => {
  const browser = await connectBrowser();
  const page = await browser.newPage();

  await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await new Promise(r => setTimeout(r, 2_000));

  const url = page.url();
  console.log('URL:', url);

  // List tabs
  const tabs = await page.$$('[role="tab"]');
  console.log('Tabs found:', tabs.length);
  for (const tab of tabs) {
    const label = await tab.evaluate(el => el.innerText).catch(() => '');
    console.log('  TAB:', JSON.stringify(label));
    if (/mentions/i.test(label)) {
      console.log('  -> clicking Mentions tab');
      await tab.click();
      await new Promise(r => setTimeout(r, 1_500));
    }
  }

  await page.evaluate(() => window.scrollBy(0, 800));
  await new Promise(r => setTimeout(r, 1_000));

  const articles = await page.$$('article[data-testid="tweet"]');
  console.log('Articles (tweet):', articles.length);

  const cells = await page.$$('[data-testid="cellInnerDiv"]');
  console.log('Cell divs:', cells.length);

  // Sample first 3 articles
  for (let i = 0; i < Math.min(3, articles.length); i++) {
    const info = await articles[i].evaluate(el => {
      const link = el.querySelector('a[href*="/status/"]');
      const text = el.querySelector('[data-testid="tweetText"]');
      const user = el.querySelector('[data-testid="User-Name"]');
      return {
        href: link ? link.href : null,
        text: text ? text.innerText.slice(0, 80) : null,
        user: user ? user.innerText.split('\n')[0] : null,
      };
    });
    console.log(`  Article[${i}]:`, JSON.stringify(info));
  }

  await page.close();
  browser.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
