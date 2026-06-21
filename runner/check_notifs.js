const { connectBrowser, getXPage } = require("./cdp");
(async () => {
  const browser = await connectBrowser();
  const page    = await getXPage(browser);

  await page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await new Promise(r => setTimeout(r, 2_500));

  const tabs = await page.$$eval('[role="tab"]', els => els.map(e => e.innerText.trim()));
  console.log("Tabs:", JSON.stringify(tabs));

  for (const t of await page.$$('[role="tab"]')) {
    const label = await t.evaluate(el => el.innerText).catch(() => "");
    if (/mentions/i.test(label)) {
      await t.click();
      await new Promise(r => setTimeout(r, 1_500));
      console.log("Clicked mentions tab");
      break;
    }
  }

  await new Promise(r => setTimeout(r, 1_000));

  const articles = await page.$$eval('article[data-testid="tweet"]', els => els.map(a => {
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const userEl = a.querySelector('[data-testid="User-Name"]');
    const link   = a.querySelector('a[href*="/status/"]');
    const id     = link && link.href.match(/\/status\/(\d+)/) ? link.href.match(/\/status\/(\d+)/)[1] : "";
    return { id, user: userEl ? userEl.innerText.split("\n")[0] : "", text: textEl ? textEl.innerText.slice(0, 120) : "" };
  }));
  console.log("Articles found:", articles.length);
  console.log(JSON.stringify(articles, null, 2));

  browser.disconnect();
})().catch(e => console.error(e.message));
