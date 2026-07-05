"use strict";
/**
 * LinkedIn — activity engine over a HelmStack browser session.
 *
 * The engine is app-agnostic: it knows how to drive LinkedIn (post, scrape,
 * like, comment) but not *what* to post, *which* posts matter, or *how* to log.
 * Those are injected into engage() as hooks (score / generateComment / callbacks),
 * so this file has zero coupling to any host app.
 *
 * How LinkedIn is driven (the non-obvious bits):
 *   POSTING     — the share composer is isolated in cross-origin anti-automation
 *                 iframes, so UI automation is unreliable. We instead call
 *                 LinkedIn's own contentcreation API with a same-origin fetch
 *                 (session cookies ride along; CSRF token comes from JSESSIONID).
 *   ENGAGEMENT  — feed posts are top-frame div[role=listitem] blocks with hashed
 *                 class names and no data-urn, so we select by role/aria-label/text
 *                 and stamp data-hs-idx during scrape to target actions reliably.
 *                 The comment submit button is text "Comment" with NO aria-label
 *                 (the action-bar toggle *has* aria-label "Comment").
 */

const FEED_URL = "https://www.linkedin.com/feed/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

class LinkedIn {
  /**
   * @param {import('./client').HelmStackClient} client
   * @param {object} [opts]
   * @param {string} [opts.ownHandleHint] Lowercase name substring used to skip
   *   the account's own posts during engagement (e.g. "sebastian hunter").
   * @param {(msg:string)=>void} [opts.log] Progress logger (default console.log).
   */
  constructor(client, { ownHandleHint = "", log } = {}) {
    this.c = client;
    this.ownHandleHint = ownHandleHint.toLowerCase();
    this.log = log || ((m) => console.log(`[linkedin] ${m}`));
    this.tab = null;
  }

  async _eval(body, timeout = 20000) {
    return this.c.evaluate(this.tab, `(function(){${body}\n})()`, { timeout });
  }

  // ── Session / tab ───────────────────────────────────────────────────────────
  async ensureTab() {
    this.tab = await this.c.ensureTab(/https:\/\/(www\.)?linkedin\.com/, FEED_URL);
    return this.tab;
  }

  async sessionOk() {
    try {
      const cookies = await this.c.getCookies(this.tab);
      return cookies.some((c) => c.name === "li_at");
    } catch {
      return false;
    }
  }

  async gotoFeed() {
    await this.c.navigate(this.tab, FEED_URL);
    await this.c.waitReady(this.tab, { tag: "linkedin" });
    await sleep(2500);
  }

  // ── Posting (via LinkedIn's own content-creation API) ───────────────────────
  /**
   * Publish a text post.
   * @returns {Promise<{posted:boolean, url?:string|null, reason?:string, dryRun?:boolean}>}
   */
  async post(text, { dryRun = false } = {}) {
    const url = await this.c.tabUrl(this.tab).catch(() => "");
    if (!/linkedin\.com/.test(url)) await this.gotoFeed();

    if (dryRun) {
      this.log(`DRY RUN — would publish ${text.length} chars`);
      return { posted: false, reason: "dry_run", dryRun: true };
    }

    const textLiteral = JSON.stringify(text);
    const expr = `(async function(){
      var m=document.cookie.match(/JSESSIONID="?([^";]+)"?/);
      if(!m) return JSON.stringify({error:"no_csrf_cookie"});
      var body={visibleToConnectionsOnly:false, externalAudienceProviders:[], commentaryV2:{text:${textLiteral}, attributes:[]}, origin:"FEED", allowedCommentersScope:"ALL", postState:"PUBLISHED", media:[]};
      try{
        var r=await fetch("https://www.linkedin.com/voyager/api/contentcreation/normShares",{
          method:"POST", credentials:"include",
          headers:{"csrf-token":m[1],"content-type":"application/json","accept":"application/vnd.linkedin.normalized+json+2.1"},
          body:JSON.stringify(body)
        });
        var t=await r.text();
        var mm=t.match(/urn:li:activity:(\\d+)/);
        return JSON.stringify({status:r.status, activity: mm?mm[0]:null, body:t.slice(0,180)});
      }catch(e){ return JSON.stringify({error:e.message}); }
    })()`;

    let res = {};
    try {
      res = JSON.parse(await this.c.evaluate(this.tab, expr, { timeout: 30000 }));
    } catch (err) {
      return { posted: false, reason: `eval_failed:${err.message}` };
    }
    if (res.error) return { posted: false, reason: res.error };
    if (res.status === 201 || res.status === 200) {
      const postUrl = res.activity ? `https://www.linkedin.com/feed/update/${res.activity}/` : null;
      this.log(`published${postUrl ? `: ${postUrl}` : ""}`);
      return { posted: true, url: postUrl };
    }
    return { posted: false, reason: `http_${res.status}: ${(res.body || "").slice(0, 120)}` };
  }

  // ── Feed scraping + engagement (top frame) ──────────────────────────────────
  /**
   * Scrape the feed. Stamps each post container with data-hs-idx and returns
   * lightweight descriptors. Own posts (ownHandleHint) are filtered out.
   * @returns {Promise<Array<{idx:number, author:string, text:string, liked:boolean, permalink:string|null}>>}
   */
  async scrapeFeed({ limit = 12 } = {}) {
    await this.gotoFeed();
    for (let i = 0; i < 3; i++) {
      await this.c.evaluate(this.tab, "window.scrollBy(0, window.innerHeight*1.5)").catch(() => {});
      await sleep(1500);
    }
    await this.c.evaluate(this.tab, "window.scrollTo(0,0)").catch(() => {});
    await sleep(800);

    const raw = await this._eval(
      `var items=[].slice.call(document.querySelectorAll('div[role=listitem]')).filter(function(li){ return li.querySelector('button[aria-label=Comment]'); });
       var out=[];
       for(var i=0;i<items.length && out.length<${limit}; i++){
         var li=items[i];
         li.setAttribute('data-hs-idx', String(out.length));
         var authorEl=li.querySelector('span[dir=ltr] span[aria-hidden=true]') || li.querySelector('.update-components-actor__name span[aria-hidden=true]') || li.querySelector('span[aria-hidden=true]');
         var author=authorEl ? (authorEl.innerText||'').trim() : '';
         var textEl=li.querySelector('.update-components-text, .feed-shared-update-v2__description, [data-test-id=main-feed-activity-card__commentary]');
         var text=textEl ? (textEl.innerText||'').trim() : (li.innerText||'').replace(/\\s+/g,' ').trim().slice(0,400);
         var likeBtn=li.querySelector('button[aria-label^=\"Reaction button state\"]');
         var liked=likeBtn ? /liked|selected/i.test(likeBtn.getAttribute('aria-label')||'') || likeBtn.getAttribute('aria-pressed')==='true' : false;
         var linkEl=li.querySelector('a[href*=\"/feed/update/\"], a[href*=\"/posts/\"]');
         var permalink=linkEl ? linkEl.href.split('?')[0] : null;
         out.push({ idx: out.length, author: author, text: text.slice(0,600), liked: liked, permalink: permalink });
       }
       return JSON.stringify(out);`
    );
    let parsed = [];
    try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
    if (this.ownHandleHint) {
      parsed = parsed.filter((p) => !(p.author || "").toLowerCase().includes(this.ownHandleHint));
    }
    return parsed;
  }

  /** Like the post stamped with the given index. Returns true if it registered. */
  async like(idx, { dryRun = false } = {}) {
    if (dryRun) return true;
    const ok = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       if(!li) return false;
       var b=li.querySelector('button[aria-label^=\"Reaction button state\"]');
       if(!b) return false;
       if(/liked|selected/i.test(b.getAttribute('aria-label')||'') || b.getAttribute('aria-pressed')==='true') return 'already';
       b.click(); return true;`
    ).catch(() => false);
    await sleep(1200);
    return ok === true || ok === "already";
  }

  /**
   * Comment on the post stamped with the given index.
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async comment(idx, text, { dryRun = false } = {}) {
    const opened = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       if(!li) return 'no_post';
       var c=li.querySelector('button[aria-label=Comment]');
       if(!c) return 'no_comment_btn';
       c.click(); return 'ok';`
    ).catch((e) => `err:${e.message}`);
    if (opened !== "ok") return { ok: false, reason: `open:${opened}` };
    await sleep(1800);

    const focused = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       if(!li) return false;
       var ed=li.querySelector('.ql-editor') || li.querySelector('div[role=textbox]');
       if(!ed) return false; ed.focus(); return true;`
    ).catch(() => false);
    if (!focused) return { ok: false, reason: "editor_not_found" };
    await sleep(500);

    try {
      await this.c.insertText(this.tab, text);
    } catch (err) {
      return { ok: false, reason: `insert:${err.message}` };
    }
    await sleep(1200);

    const got = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
       return ed ? (ed.innerText||'').trim() : '';`
    );
    if (norm(got) !== norm(text)) return { ok: false, reason: "text_verify_failed" };

    if (dryRun) {
      await this._eval(
        `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
         var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
         if(ed){ed.focus();document.execCommand('selectAll');document.execCommand('delete');}
         return true;`
      ).catch(() => {});
      return { ok: false, reason: "dry_run", dryRun: true };
    }

    // Submit button: text "Comment" with NO aria-label (distinguishes it from the
    // action-bar toggle, aria-label "Comment", and reply submits, text "Reply").
    const clicked = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       if(!li) return false;
       var b=[].slice.call(li.querySelectorAll('button')).find(function(x){
         return (x.innerText||'').trim()==='Comment' && !(x.getAttribute('aria-label')||'').trim()
           && x.getAttribute('aria-disabled')!=='true' && !x.disabled && x.offsetParent!==null;
       });
       if(!b) return false; b.click(); return true;`
    ).catch(() => false);
    if (!clicked) return { ok: false, reason: "submit_button_not_found" };
    await sleep(2500);

    const cleared = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
       return ed ? (ed.innerText||'').trim().length===0 : true;`
    ).catch(() => true);
    return cleared ? { ok: true } : { ok: false, reason: "submit_unconfirmed" };
  }

  /**
   * High-level feed engagement: scrape → score → like top-N → comment on top-M.
   * All app-specific behaviour is injected:
   *
   * @param {object} hooks
   * @param {(post)=>number} hooks.score              Relevance score for a post (higher = more relevant).
   * @param {(post)=>Promise<string|null>} [hooks.generateComment]  On-voice comment text, or null to skip.
   * @param {(post,meta)=>Promise<void>} [hooks.onLike]     Called after a successful like.
   * @param {(post,text,meta)=>Promise<void>} [hooks.onComment] Called after a successful comment.
   * @param {(post)=>string} [hooks.keyOf]             Dedup key for a post (default permalink|author+text).
   * @param {Set<string>} [hooks.seen]                 Already-engaged keys (mutated in place).
   * @param {number} [hooks.minScore=1]  Minimum score to act on.
   * @param {number} [hooks.maxLikes=3]
   * @param {number} [hooks.maxComments=1]
   * @param {number} [hooks.scrapeLimit=12]
   * @param {boolean} [hooks.dryRun=false]
   * @returns {Promise<{scraped:number, likes:number, comments:number, ranked:number}>}
   */
  async engage(hooks = {}) {
    const {
      score = () => 0,
      generateComment = null,
      onLike = null,
      onComment = null,
      keyOf = (p) => p.permalink || `${(p.author || "").toLowerCase()}::${(p.text || "").slice(0, 60).toLowerCase()}`,
      seen = new Set(),
      minScore = 1,
      maxLikes = 3,
      maxComments = 1,
      scrapeLimit = 12,
      dryRun = false,
    } = hooks;

    const posts = await this.scrapeFeed({ limit: scrapeLimit });
    this.log(`scraped ${posts.length} feed post(s)`);

    const ranked = posts
      .map((p) => ({ ...p, key: keyOf(p), score: score(p) }))
      .filter((p) => !seen.has(p.key) && p.score >= minScore)
      .sort((a, b) => b.score - a.score);
    this.log(`${ranked.length} relevant, un-engaged post(s) (min score ${minScore})`);

    let likes = 0;
    for (const p of ranked.slice(0, maxLikes)) {
      if (p.liked) { seen.add(p.key); continue; }
      if (await this.like(p.idx, { dryRun })) {
        likes++; seen.add(p.key);
        this.log(`${dryRun ? "[dry] " : ""}liked @${p.author || "?"} (score ${p.score})`);
        if (!dryRun && onLike) await onLike(p, { score: p.score });
      }
    }

    let comments = 0;
    if (generateComment) {
      for (const p of ranked.slice(0, maxComments)) {
        const text = await generateComment(p);
        if (!text) continue;
        const res = await this.comment(p.idx, text, { dryRun });
        if (res.dryRun) { this.log(`[dry] would comment on @${p.author || "?"}: "${text.slice(0, 60)}..."`); comments++; continue; }
        if (res.ok) {
          comments++; seen.add(p.key);
          this.log(`commented on @${p.author || "?"}: "${text.slice(0, 60)}..."`);
          if (onComment) await onComment(p, text, { score: p.score });
        } else {
          this.log(`comment failed for @${p.author || "?"} (${res.reason})`);
        }
      }
    }

    return { scraped: posts.length, likes, comments, ranked: ranked.length };
  }
}

module.exports = { LinkedIn, FEED_URL };
