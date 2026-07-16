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
    // A freshly-opened tab may not have its session cookies readable yet; wait
    // for it to settle so sessionOk() doesn't get a false negative.
    await this.c.waitReady(this.tab, { tag: "linkedin", attempts: 15 }).catch(() => {});
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

  /**
   * Publish a post WITH an image via LinkedIn's own media pipeline (register →
   * PUT bytes → normShares with the asset URN) — same same-origin voyager fetch
   * as post(), since the UI composer is iframe-isolated. `imagePath` = a local
   * file; the CALLER deletes it afterward.
   * @returns {Promise<{posted:boolean, url?:string, reason?:string, dryRun?:boolean}>}
   */
  async postImage(text, imagePath, { dryRun = false } = {}) {
    const fs = require("fs");
    let b64, size;
    try { const buf = fs.readFileSync(imagePath); b64 = buf.toString("base64"); size = buf.length; }
    catch (e) { return { posted: false, reason: `read_image:${e.message}` }; }
    const cur = await this.c.tabUrl(this.tab).catch(() => "");
    if (!/linkedin\.com/.test(cur)) await this.gotoFeed();
    if (dryRun) { this.log(`DRY RUN — would post image (${size}b) + ${text.length} chars`); return { posted: false, reason: "dry_run", dryRun: true }; }
    const filename = "image." + ((imagePath.split(".").pop() || "png").toLowerCase());
    const expr = `(async function(){
      var m=document.cookie.match(/JSESSIONID="?([^";]+)"?/); if(!m) return JSON.stringify({error:"no_csrf"});
      var H={"csrf-token":m[1],"content-type":"application/json","accept":"application/vnd.linkedin.normalized+json+2.1"};
      try{
        var reg=await fetch("https://www.linkedin.com/voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload",{method:"POST",credentials:"include",headers:H,body:JSON.stringify({mediaUploadType:"IMAGE_SHARING",fileSize:${size},filename:${JSON.stringify(filename)}})});
        var rj=await reg.json(); var v=rj.data&&rj.data.value; if(!v) return JSON.stringify({error:"register_failed"});
        var bin=atob(${JSON.stringify(b64)}); var arr=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
        var put=await fetch(v.singleUploadUrl,{method:"PUT",credentials:"include",headers:v.singleUploadHeaders||{},body:arr});
        if(!put.ok) return JSON.stringify({error:"put_http_"+put.status});
        await new Promise(r=>setTimeout(r,4000)); // let LinkedIn process the image
        var body={visibleToConnectionsOnly:false,externalAudienceProviders:[],commentaryV2:{text:${JSON.stringify(text)},attributes:[]},origin:"FEED",allowedCommentersScope:"ALL",postState:"PUBLISHED",media:[{category:"IMAGE",mediaUrn:v.urn,tapTargets:[]}]};
        var sh=await fetch("https://www.linkedin.com/voyager/api/contentcreation/normShares",{method:"POST",credentials:"include",headers:H,body:JSON.stringify(body)});
        var st=await sh.text(); var am=st.match(/urn:li:activity:(\\d+)/);
        return JSON.stringify({status:sh.status, activity: am?am[0]:null, body: am?undefined:st.slice(0,160)});
      }catch(e){ return JSON.stringify({error:e.message}); }
    })()`;
    let r = {};
    try { r = JSON.parse(await this.c.evaluate(this.tab, expr, { timeout: 45000 })); }
    catch (e) { return { posted: false, reason: `eval_failed:${e.message}` }; }
    if (r.activity) { const u = `https://www.linkedin.com/feed/update/${r.activity}/`; this.log(`posted image: ${u}`); return { posted: true, url: u }; }
    return { posted: false, reason: r.error || `http_${r.status}:${(r.body || "").slice(0, 120)}` };
  }

  /**
   * Scrape a post permalink's engagement counts (for the post-performance loop).
   * @returns {Promise<{reactions:number, comments:number}>} best-effort; 0 on miss.
   */
  async scrapePostEngagement(url) {
    await this.c.navigate(this.tab, url);
    await this.c.waitReady(this.tab, { tag: "linkedin" }).catch(() => {});
    await sleep(3500);
    await this.c.evaluate(this.tab, "window.scrollBy(0, 450)").catch(() => {});
    await sleep(1200);
    const raw = await this._eval(
      `var out={reactions:null,comments:null};
       var nodes=[].slice.call(document.querySelectorAll('[aria-label]'));
       for(var i=0;i<nodes.length;i++){ var al=nodes[i].getAttribute('aria-label')||'';
         if(out.reactions==null){ var mr=al.match(/([\\d,]+)\\s+reaction/i); if(mr) out.reactions=parseInt(mr[1].replace(/,/g,''),10); }
         if(out.comments==null){ var mc=al.match(/([\\d,]+)\\s+comment/i); if(mc) out.comments=parseInt(mc[1].replace(/,/g,''),10); }
       }
       var sc=document.querySelector('.social-details-social-counts'); var t=sc?(sc.innerText||''):'';
       if(out.comments==null && t){ var c=t.match(/([\\d,]+)\\s+comment/i); if(c) out.comments=parseInt(c[1].replace(/,/g,''),10); }
       if(out.reactions==null && t){ var r=t.match(/([\\d,]+)/); if(r) out.reactions=parseInt(r[1].replace(/,/g,''),10); }
       return JSON.stringify(out);`
    ).catch(() => "{}");
    let m = {}; try { m = JSON.parse(raw || "{}"); } catch {}
    return { reactions: m.reactions || 0, comments: m.comments || 0 };
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
         // Author = the CONTENT author. LinkedIn's feed markup is obfuscated (the
         // old .update-components-actor__* selectors return null), and for
         // engagement-surfaced cards the top avatar is the engager, not the post
         // author. The card text reliably reads "<reason> <Author> • <degree> …"
         // ("… reposted this <Author>", "… likes this <Author>", "Recommended for
         // you <Author>", or just "<Author>"), so parse the author out of it;
         // fall back to the avatar alt ("View <Name>'s profile") for odd cards.
         var full=(li.innerText||'').replace(/\\s+/g,' ').trim();
         var a=full.replace(/^Feed post( number \\d+)?\\s*/i,'')
                   .replace(/^(Recommended for you|Promoted|.*? reposted this|.*? likes this|.*? loves this|.*? celebrates this|.*? commented on this|.*? follows)\\s+/i,'');
         var am=a.match(/^(.{2,60}?)\\s*•/);
         var author=am?am[1].trim():'';
         if(!author){ var imgs=li.querySelectorAll('img[alt]');
           for(var ai=0; ai<imgs.length; ai++){ var im=(imgs[ai].getAttribute('alt')||'').match(/^View (.+?)(?:’|')s profile/i); if(im){ author=im[1].trim(); break; } } }
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

  /**
   * Inbound notifications directed AT us that warrant a reply — mentions,
   * comments on our posts, and replies to our comments. Skips the noise
   * (impressions/analytics, profile views, news digests, bare reactions).
   * Returns [{ id, type: 'mention'|'comment'|'reply', actor, text, href }] where
   * `href` opens the post with the comment box focused (showCommentBox=true).
   */
  async scrapeNotifications({ limit = 20 } = {}) {
    await this.c.navigate(this.tab, "https://www.linkedin.com/notifications/");
    await sleep(3500);
    await this.c.evaluate(this.tab, "window.scrollBy(0, 800)").catch(() => {});
    await sleep(1200);
    const raw = await this._eval(
      `var cards=[].slice.call(document.querySelectorAll('article, .nt-card'));
       var out=[]; var seen={};
       for(var i=0;i<cards.length && out.length<${limit};i++){
         var c=cards[i];
         var text=(c.innerText||'').replace(/\\s+/g,' ').replace(/^Unread notification\\.?\\s*/i,'').trim();
         if(!text||text.length<8||seen[text]) continue; seen[text]=1;
         var type=null;
         if(/mentioned you/i.test(text)) type='mention';
         else if(/commented on (your|this)/i.test(text)) type='comment';
         else if(/replied to (your|you)/i.test(text)) type='reply';
         if(!type) continue;
         var a=c.querySelector('a[href*=\"showCommentBox\"], a[href*=\"highlightedUpdateUrn\"], a[href*=\"/feed/update/\"], a[href*=\"/posts/\"]');
         var href=a?a.href:'';
         var idm=href.match(/comment[^0-9]*?(\\d{15,})/i)||href.match(/activity[^0-9]*?(\\d{15,})/i);
         var id=idm?idm[1]:text.slice(0,60);
         var actor=(text.split(/\\s+(?:mentioned|commented|replied)/i)[0]||'').trim().slice(0,60);
         out.push({ id:id, type:type, actor:actor, text:text.slice(0,500), href:href });
       }
       return JSON.stringify(out);`
    ).catch(() => "[]");
    let arr; try { arr = JSON.parse(raw || "[]"); } catch { return []; }
    // Prefer the comment/activity URN as a stable dedupe id (regex is cleaner here
    // than in-page); fall back to the text slice the scraper already set.
    for (const it of arr) {
      if (!it.href) continue;
      const m = it.href.match(/comment[^0-9]*?(\d{15,})/i) || it.href.match(/activity[^0-9]*?(\d{15,})/i);
      if (m) it.id = m[1];
    }
    return arr;
  }

  /**
   * Reply to a notification by opening its href (LinkedIn focuses the relevant
   * comment box via showCommentBox=true), then typing + submitting into the first
   * visible comment/reply editor. dryRun verifies the editor + text without posting.
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async replyToNotification(href, text, { dryRun = false, type = "reply" } = {}) {
    if (!href) return { ok: false, reason: "no_href" };
    await this.c.navigate(this.tab, href).catch(() => {});
    await sleep(4000);
    // The comment thread renders below the fold; nudge it into view.
    await this.c.evaluate(this.tab, "window.scrollBy(0, 400)").catch(() => {});
    await sleep(1200);
    // No editor exists until an opener is clicked (the showCommentBox URL param
    // isn't honored on direct nav). For a comment/mention → click a "Reply"
    // button; for a post comment → the "Comment" toggle. Try the preferred one,
    // fall back to the other.
    const openers = type === "comment" ? ['aria-label="Comment"', 'aria-label="Reply"'] : ['aria-label="Reply"', 'aria-label="Comment"'];
    let opened = false;
    for (const sel of openers) {
      opened = await this._eval(
        `var b=[].slice.call(document.querySelectorAll('button[${sel}]'))
           .find(function(x){ return x.offsetParent!==null; });
         if(!b) return false; b.click(); return true;`
      ).catch(() => false);
      if (opened) break;
    }
    if (!opened) return { ok: false, reason: "opener_not_found" };
    await sleep(1800);
    // Now the editor is rendered — focus the first visible one.
    const focused = await this._eval(
      `var eds=[].slice.call(document.querySelectorAll('.ql-editor, div[role=textbox]'))
         .filter(function(e){ return e.offsetParent!==null; });
       if(!eds.length) return false;
       var ed=eds[0]; ed.focus(); ed.setAttribute('data-hs-reply','1'); return true;`
    ).catch(() => false);
    if (!focused) return { ok: false, reason: "editor_not_found" };
    await sleep(500);

    try { await this.c.insertText(this.tab, text); }
    catch (err) { return { ok: false, reason: `insert:${err.message}` }; }
    await sleep(1200);

    const got = await this._eval(
      `var ed=document.querySelector('[data-hs-reply="1"]'); return ed ? (ed.innerText||'').trim() : '';`
    ).catch(() => "");
    // Clicking "Reply" can pre-seed an @mention chip for the person, so the editor
    // legitimately holds "@Name " + our text — verify our text is PRESENT, not equal.
    if (!norm(got).includes(norm(text))) return { ok: false, reason: `text_verify_failed(${got.length}/${text.length})` };

    if (dryRun) {
      await this._eval(
        `var ed=document.querySelector('[data-hs-reply="1"]');
         if(ed){ed.focus();document.execCommand('selectAll');document.execCommand('delete');ed.removeAttribute('data-hs-reply');}
         return true;`
      ).catch(() => {});
      return { ok: false, reason: "dry_run", dryRun: true };
    }

    // Submit: the active editor's nearest form has a "Reply"/"Comment" post button
    // (text, no aria-label — distinguishes from the action-bar toggle).
    const clicked = await this._eval(
      `var ed=document.querySelector('[data-hs-reply="1"]');
       var box=ed?ed.closest('form, .comments-comment-box, .comments-comment-texteditor')||ed.parentElement.parentElement:null;
       var scope=box||document;
       var b=[].slice.call(scope.querySelectorAll('button')).find(function(x){
         var t=(x.innerText||'').trim();
         return (t==='Reply'||t==='Comment'||t==='Post') && !(x.getAttribute('aria-label')||'').trim()
           && x.getAttribute('aria-disabled')!=='true' && !x.disabled && x.offsetParent!==null;
       });
       if(!b) return false; b.click(); return true;`
    ).catch(() => false);
    if (!clicked) return { ok: false, reason: "submit_button_not_found" };
    await sleep(1800);
    return { ok: true };
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
   * Instant-repost (reshare, no commentary) the feed post stamped `idx`.
   *
   * UI-DRIVEN by necessity: unlike post()/comment(), instant repost is NOT a
   * voyager JSON endpoint. LinkedIn's current feed drives it through a
   * Server-Driven-UI / React-Server-Component action —
   *   POST /flagship-web/rsc-action/actions/server-request
   *        ?sduiid=com.linkedin.sdui.feed.requests.createInstantRepost
   * whose payload is RSC-serialized and carries a render-scoped `parentSpanId`
   * nonce, so it can't be replayed with a same-origin fetch the way post() is.
   * We therefore click the Repost control → the "Repost" (instant) menu item and
   * confirm via the "Repost successful" toast. (Verified live 2026-07-16.)
   *
   * @param {number} idx  data-hs-idx stamped by scrapeFeed()
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async reshare(idx, { dryRun = false } = {}) {
    // Open the Repost dropdown on the target post.
    const opened = await this._eval(
      `var li=document.querySelector('div[data-hs-idx=\"${idx}\"]');
       if(!li) return 'no_post';
       li.scrollIntoView({block:'center'});
       var b=[].slice.call(li.querySelectorAll('button')).find(function(x){ return (x.getAttribute('aria-label')||'')==='Repost'; });
       if(!b) return 'no_repost_btn'; b.click(); return 'ok';`
    ).catch((e) => `err:${e.message}`);
    if (opened !== "ok") return { ok: false, reason: `open:${opened}` };
    await sleep(2500);

    // Locate the instant "Repost" item (subtext "Instantly bring …").
    const found = await this._eval(
      `var t=[].slice.call(document.querySelectorAll('div,span,button,li,a'))
        .find(function(n){ return /Instantly bring/i.test(n.innerText||'') && (n.innerText||'').length<120; });
       return t ? 'ok' : 'no_instant_item';`
    ).catch(() => "no_instant_item");
    if (found !== "ok") return { ok: false, reason: found };

    if (dryRun) {
      // Close the menu without publishing.
      await this._eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true;`).catch(() => {});
      this.log("DRY RUN — instant-repost item located, not publishing");
      return { ok: false, reason: "dry_run", dryRun: true };
    }

    const clicked = await this._eval(
      `var t=[].slice.call(document.querySelectorAll('div,span,button,li,a'))
        .find(function(n){ return /Instantly bring/i.test(n.innerText||'') && (n.innerText||'').length<120; });
       if(!t) return 'gone';
       (t.closest('[role=\"button\"],button,li,a,.artdeco-dropdown__item')||t).click(); return 'ok';`
    ).catch((e) => `err:${e.message}`);
    if (clicked !== "ok") return { ok: false, reason: `click:${clicked}` };

    // Confirm via the success toast ("Repost successful. View repost."), which is
    // transient — poll for it rather than checking once, so a slow toast isn't a
    // false negative (which would make a caller retry and double-post).
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      const toast = await this._eval(
        `var els=[].slice.call(document.querySelectorAll('[role="alert"], .artdeco-toast-item, div, span'));
         for(var i=0;i<els.length;i++){ var t=(els[i].innerText||'').trim();
           if(/Repost successful/i.test(t) && t.length<80) return 'ok'; }
         return 'no_toast';`
      ).catch(() => "no_toast");
      if (toast === "ok") { this.log(`reshared feed post idx ${idx}`); return { ok: true }; }
    }
    return { ok: false, reason: "repost_unconfirmed" };
  }

  /**
   * Delete one of our reshares from our profile's recent activity, identified by
   * a text fragment of the reshared content. Undo for reshare() (retract a
   * mis-amplification). The reshare's control menu → "Delete repost" is driven by
   * REAL pointer clicks (this.c.clickAt) at the elements' rect centers: LinkedIn's
   * control-menu button ignores a synthetic .click(), and the confirm modal
   * ("Delete repost? … Delete") must be clicked live too. (Verified 2026-07-16.)
   *
   * @param {string} profileUrl  our profile URL (…/in/<vanity>/)
   * @param {string} match       case-insensitive substring of the reshared post
   * @returns {Promise<{ok:boolean, reason?:string, dryRun?:boolean}>}
   */
  async deleteReshare(profileUrl, match, { dryRun = false } = {}) {
    const act = (profileUrl.startsWith("http") ? profileUrl : "https://www.linkedin.com" + profileUrl).replace(/\/$/, "") + "/recent-activity/all/";
    const reEsc = String(match).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const presentJs = `(function(){
      var items=[].slice.call(document.querySelectorAll('div[role="listitem"], .feed-shared-update-v2')).slice(0,8);
      var idx=items.findIndex(function(it){ var t=it.innerText||''; return /reposted/i.test(t) && new RegExp(${JSON.stringify(reEsc)},'i').test(t); });
      return JSON.stringify({rendered:items.length, present:idx>=0});
    })()`;
    // A just-created reshare sits at the top of recent activity, where its
    // control-menu button is occluded by the sticky nav (~y64) after a
    // scrollIntoView-center — clickAt then misses it. An absolute scrollTo(0,120)
    // lands the caret at a clickable ~y117 (verified 2026-07-16); read the rect
    // WITHOUT re-centering.
    const caretJs = `(function(){
      var items=[].slice.call(document.querySelectorAll('div[role="listitem"], .feed-shared-update-v2'));
      var target=items.find(function(it){ var t=it.innerText||''; return /reposted/i.test(t) && new RegExp(${JSON.stringify(reEsc)},'i').test(t); });
      if(!target) return "null";
      var c=target.querySelector('button[aria-label*="control menu" i], button[aria-label*="more actions" i]');
      if(!c) return "null"; var r=c.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
    })()`;
    const coordsOf = (reSrc) => `(function(){
      var re=${reSrc};
      var nodes=[].slice.call(document.querySelectorAll('div[role="button"],button,li,span,a,[role="menuitem"]'));
      for(var i=0;i<nodes.length;i++){ var el=nodes[i]; var s=(el.innerText||'').trim();
        if(re.test(s) && s.length<40){ var rc=el.getBoundingClientRect(); if(rc.width>0&&rc.height>0&&el.offsetParent!==null) return JSON.stringify({x:Math.round(rc.x+rc.width/2),y:Math.round(rc.y+rc.height/2)}); } }
      return "null";
    })()`;
    const parse = (s) => (s === "null" ? null : JSON.parse(s));
    const check = async () => {
      await this.c.navigate(this.tab, act);
      await this.c.waitReady(this.tab, { tag: "linkedin" }).catch(() => {});
      let st = { rendered: 0, present: false };
      for (let w = 0; w < 15; w++) { await sleep(1000); st = JSON.parse(await this.c.evaluate(this.tab, presentJs).catch(() => '{"rendered":0,"present":false}')); if (st.rendered) break; }
      return st;
    };

    for (let attempt = 1; attempt <= 4; attempt++) {
      const st = await check();
      if (st.rendered > 0 && !st.present) return { ok: true };
      if (!st.rendered) continue;
      if (dryRun) { this.log("DRY RUN — reshare located on profile, not deleting"); return { ok: false, reason: "dry_run", dryRun: true }; }
      await this.c.evaluate(this.tab, "window.scrollTo(0, 120)").catch(() => {});
      await sleep(900);
      const cc = parse(await this.c.evaluate(this.tab, caretJs).catch(() => "null"));
      if (!cc) continue;
      await this.c.clickAt(this.tab, cc.x, cc.y); await sleep(2200);
      const dc = parse(await this.c.evaluate(this.tab, coordsOf("/^Delete repost$/i")).catch(() => "null"));
      if (!dc) continue;
      await this.c.clickAt(this.tab, dc.x, dc.y); await sleep(1800);
      for (let i = 0; i < 8; i++) { const fc = parse(await this.c.evaluate(this.tab, coordsOf("/^Delete$/i")).catch(() => "null")); if (fc) { await this.c.clickAt(this.tab, fc.x, fc.y); break; } await sleep(700); }
      await sleep(3500);
    }
    const fin = await check();
    return fin.rendered > 0 && !fin.present ? { ok: true } : { ok: false, reason: "still_present" };
  }

  /**
   * Read back the permalink of our most recent reshare from recent activity — the
   * UI reshare() doesn't return a URL, so the amplify loop calls this right after
   * to tag the reshare measurable. Recent-activity items carry a data-urn
   * (urn:li:activity:N); the permalink is feed/update/<urn>/. Matches the top
   * reshare item (optionally constrained to `match` text). Returns URL or null.
   *
   * @param {string} profileUrl  our profile URL (…/in/<vanity>/)
   * @param {string} [match]     case-insensitive substring to constrain the reshare
   * @returns {Promise<string|null>}
   */
  async latestReshareUrl(profileUrl, match = "") {
    const act = (profileUrl.startsWith("http") ? profileUrl : "https://www.linkedin.com" + profileUrl).replace(/\/$/, "") + "/recent-activity/all/";
    const reEsc = String(match).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await this.c.navigate(this.tab, act);
    await this.c.waitReady(this.tab, { tag: "linkedin" }).catch(() => {});
    let urn = null;
    for (let w = 0; w < 12 && !urn; w++) {
      await sleep(1000);
      urn = await this.c.evaluate(this.tab, `(function(){
        var items=[].slice.call(document.querySelectorAll('div[role="listitem"], .feed-shared-update-v2')).slice(0,8);
        var t=items.find(function(it){ var tx=it.innerText||''; return /Sebastian Hunter reposted/i.test(tx) && (${JSON.stringify(!match)} || new RegExp(${JSON.stringify(reEsc)},'i').test(tx)); });
        if(!t) return "";
        var el=t.hasAttribute('data-urn')?t:t.querySelector('[data-urn]');
        return el ? (el.getAttribute('data-urn')||"") : "";
      })()`).catch(() => "");
      if (!urn) urn = null;
    }
    return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
  }

  // ── People search + networking (connect / follow) ───────────────────────────
  /**
   * Search People and return lightweight result descriptors. Name + headline are
   * parsed from the profile link's own text ("Name • 3rd+ Headline…"), which is
   * far more stable than LinkedIn's hashed result-card markup. connect() then
   * navigates to each profileUrl to act, so no card stamping is needed.
   * @returns {Promise<Array<{name:string,headline:string,profileUrl:string}>>}
   */
  async searchPeople(query, { limit = 12 } = {}) {
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
    await this.c.navigate(this.tab, url);
    await this.c.waitReady(this.tab, { tag: "linkedin" }).catch(() => {});
    await sleep(3000);
    for (let i = 0; i < 2; i++) {
      await this.c.evaluate(this.tab, "window.scrollBy(0, window.innerHeight)").catch(() => {});
      await sleep(1500);
    }
    await this.c.evaluate(this.tab, "window.scrollTo(0,0)").catch(() => {});
    await sleep(700);

    const raw = await this._eval(
      `var out=[]; var seen={};
       var links=[].slice.call(document.querySelectorAll('a[href*=\"/in/\"]'));
       for(var i=0;i<links.length && out.length<${limit};i++){
         var a=links[i];
         var href=(a.href||'').split('?')[0];
         if(!/\\/in\\//.test(href) || seen[href]) continue;
         var full=(a.innerText||'').replace(/Status is (online|offline|reachable)/ig,'').replace(/\\s+/g,' ').trim();
         if(!full) continue;
         seen[href]=1;
         var parts=full.split('•').map(function(s){return s.trim();});
         var name=(parts[0]||'').replace(/View .*profile.*/i,'').trim();
         if(!name || /^LinkedIn Member$/i.test(name)) continue;
         var headline=parts[1]?parts[1].replace(/^(1st|2nd|3rd\\+?)\\s*/i,'').trim():'';
         out.push({ name: name.slice(0,80), headline: headline.slice(0,160), profileUrl: href });
       }
       return JSON.stringify(out);`
    ).catch(() => "[]");
    let parsed = [];
    try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
    if (this.ownHandleHint) {
      parsed = parsed.filter((p) => !(p.name || "").toLowerCase().includes(this.ownHandleHint));
    }
    return parsed;
  }

  /** Dismiss the current LinkedIn modal (X button, else Escape). */
  async _dismissDialog() {
    await this._eval(
      `var d=document.querySelector('div[role=dialog]'); if(!d) return false;
       var b=d.querySelector('button[aria-label=\"Dismiss\"]')||d.querySelector('button[aria-label=Dismiss]');
       if(b){ b.click(); return true; } return false;`
    ).catch(() => {});
    try { await this.c.pressKey(this.tab, { key: "Escape", code: "Escape", keyCode: 27 }); } catch {}
    await sleep(800);
  }

  /** Click the profile top-card Follow button. → {ok} | {ok:false,reason} */
  async _followTopCard() {
    const r = await this._eval(
      `var m=document.querySelector('main')||document;
       var b=[].slice.call(m.querySelectorAll('button')).find(function(x){ return x.offsetParent!==null && (/^Follow\\b/.test(x.getAttribute('aria-label')||'') || (x.innerText||'').trim()==='Follow'); });
       if(!b) return 'no_follow'; b.click(); return 'ok';`
    ).catch(() => "no_follow");
    if (r === "ok") { await sleep(1500); return { ok: true }; }
    return { ok: false, reason: "no_follow" };
  }

  /**
   * Complete the invitation modal after a Connect click: optionally add a note,
   * then Send. Falls back to sending WITHOUT a note if the note editor is
   * unavailable (LinkedIn's weekly free-note limit / upsell).
   * @returns {Promise<{ok:boolean, noteSent?:boolean, reason?:string, dryRun?:boolean}>}
   */
  async _completeInvite({ note = "", dryRun = false } = {}) {
    const modal = await this._eval(
      `var d=document.querySelector('div[role=dialog]'); if(!d) return 'none';
       if(/weekly invitation limit|reached the weekly|invite limit/i.test(d.innerText||'')) return 'weekly_limit';
       return 'dialog';`
    ).catch(() => "none");

    if (modal === "weekly_limit") { await this._dismissDialog(); return { ok: false, reason: "weekly_limit" }; }
    if (modal === "none") {
      // The dialog can render a beat late — give it one more chance before deciding.
      await sleep(1400);
      const late = await this._eval(
        `var d=document.querySelector('div[role=dialog]'); if(d) return 'dialog';
         var m=document.querySelector('main')||document; return [].slice.call(m.querySelectorAll('button')).some(function(x){ return /^Pending/i.test((x.innerText||'').trim()); }) ? 'pending' : 'none';`
      ).catch(() => "none");
      if (late === "pending") return { ok: true, noteSent: false }; // sent directly, no modal
      if (late !== "dialog") return { ok: false, reason: "no_invite_modal" };
      // else: dialog showed up late — fall through to the note/send handling below.
    }

    if (dryRun) { await this._dismissDialog(); return { ok: false, reason: "dry_run", dryRun: true }; }

    let noteSent = false;
    if (note) {
      const addNote = await this._eval(
        `var d=document.querySelector('div[role=dialog]'); if(!d) return false;
         var b=[].slice.call(d.querySelectorAll('button')).find(function(x){ var al=(x.getAttribute('aria-label')||''); var t=(x.innerText||'').trim(); return /add a note/i.test(al) || t==='Add a note'; });
         if(!b) return false; b.click(); return true;`
      ).catch(() => false);
      if (addNote) {
        await sleep(1200);
        const focused = await this._eval(
          `var d=document.querySelector('div[role=dialog]'); if(!d) return false;
           var ta=d.querySelector('#custom-message')||d.querySelector('textarea[name=message]')||d.querySelector('textarea');
           if(!ta) return false; ta.focus(); ta.setAttribute('data-hs-note','1'); return true;`
        ).catch(() => false);
        if (focused) {
          try { await this.c.insertText(this.tab, note); } catch {}
          await sleep(1000);
          const got = await this._eval(`var ta=document.querySelector('[data-hs-note="1"]'); return ta ? (ta.value||ta.innerText||'').trim() : '';`).catch(() => "");
          noteSent = norm(got).length > 0 && norm(got).includes(norm(note.slice(0, 40)));
        }
        // If the note editor never appeared (limit/upsell), fall through and send blank.
      }
    }

    const sent = await this._eval(
      `var d=document.querySelector('div[role=dialog]'); if(!d) return false;
       var b=[].slice.call(d.querySelectorAll('button')).find(function(x){ var al=(x.getAttribute('aria-label')||''); var t=(x.innerText||'').trim(); return /^Send(\\b| invitation| now| without)/i.test(al) || t==='Send' || t==='Send invitation' || t==='Send without a note'; });
       if(!b||b.getAttribute('aria-disabled')==='true'||b.disabled) return false; b.click(); return true;`
    ).catch(() => false);
    if (!sent) { await this._dismissDialog(); return { ok: false, reason: "send_btn_not_found" }; }
    await sleep(1800);
    return { ok: true, noteSent };
  }

  /**
   * Reach out to a person by navigating to their profile. LinkedIn now steers
   * cold (out-of-network) profiles to Follow and only exposes Connect for warmer
   * ones, so this PREFERS Connect (with a personalized note where the editor is
   * available) and gracefully FOLLOWS when Connect isn't offered (unless
   * allowFollow=false). dryRun locates the available action without acting.
   * @returns {Promise<{ok:boolean, action?:'connect'|'follow', noteSent?:boolean, reason?:string, dryRun?:boolean}>}
   */
  async connect(profileUrl, { note = "", allowFollow = true, dryRun = false } = {}) {
    await this.c.navigate(this.tab, profileUrl);
    await this.c.waitReady(this.tab, { tag: "linkedin" }).catch(() => {});
    await sleep(3500);
    await this.c.evaluate(this.tab, "window.scrollTo(0,0)").catch(() => {});
    await sleep(500);

    // 1. Connect on the top card?
    let action = await this._eval(
      `var m=document.querySelector('main')||document;
       var btns=[].slice.call(m.querySelectorAll('button')).filter(function(b){ return b.offsetParent!==null; });
       var c=btns.find(function(b){ var al=(b.getAttribute('aria-label')||''); var t=(b.innerText||'').trim(); return (/^Invite\\b/.test(al) && /to connect/i.test(al)) || t==='Connect'; });
       if(c){ c.click(); return 'connect'; }
       if(btns.some(function(b){ return /^Pending/i.test((b.innerText||'').trim()) || /Pending/i.test(b.getAttribute('aria-label')||''); })) return 'already_pending';
       return 'no_top_connect';`
    ).catch((e) => `err:${e.message}`);

    // 2. Connect hidden under the top-card "More" menu?
    if (action === "no_top_connect") {
      const openedMore = await this._eval(
        `var m=document.querySelector('main')||document;
         var b=[].slice.call(m.querySelectorAll('button')).find(function(x){ return (x.getAttribute('aria-label')||'').trim()==='More' && x.offsetParent!==null; });
         if(!b) return false; b.click(); return true;`
      ).catch(() => false);
      if (openedMore) {
        await sleep(1200);
        const clicked = await this._eval(
          `var it=[].slice.call(document.querySelectorAll('[role=menuitem],[role=button],button,a')).find(function(x){ var al=(x.getAttribute('aria-label')||''); var t=(x.innerText||'').trim(); return x.offsetParent!==null && ((/^Invite\\b/.test(al) && /to connect/i.test(al)) || t==='Connect'); });
           if(!it) return false; it.click(); return true;`
        ).catch(() => false);
        if (clicked) action = "connect";
        else { try { await this.c.pressKey(this.tab, { key: "Escape", code: "Escape", keyCode: 27 }); } catch {} await sleep(400); action = "no_connect"; }
      } else action = "no_connect";
    }

    if (typeof action === "string" && action.startsWith("err:")) return { ok: false, reason: action };
    if (action === "already_pending") return { ok: false, reason: "already_pending" };

    // 3a. Connect flow → handle the invite modal.
    if (action === "connect") {
      await sleep(1800);
      const res = await this._completeInvite({ note, dryRun });
      if (res.ok || res.dryRun) return { ...res, action: "connect" };
      // Invite couldn't complete (weekly limit / modal issue) → Follow instead.
      if (allowFollow && !dryRun) {
        const f = await this._followTopCard();
        if (f.ok) return { ok: true, action: "follow", noteSent: false, downgradedFrom: res.reason };
      }
      return { ...res, action: "connect" };
    }

    // 3b. No Connect available → Follow fallback.
    if (allowFollow) {
      if (dryRun) {
        const canFollow = await this._eval(
          `var m=document.querySelector('main')||document; return [].slice.call(m.querySelectorAll('button')).some(function(x){ return x.offsetParent!==null && (/^Follow\\b/.test(x.getAttribute('aria-label')||'') || (x.innerText||'').trim()==='Follow'); });`
        ).catch(() => false);
        return canFollow ? { ok: false, reason: "dry_run", dryRun: true, action: "follow" } : { ok: false, reason: "no_action", dryRun: true };
      }
      const f = await this._followTopCard();
      return f.ok ? { ok: true, action: "follow", noteSent: false } : { ok: false, reason: "no_action" };
    }

    return { ok: false, reason: "no_connect_available" };
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
