"use strict";
/**
 * runner/lib/linkedin.js — LinkedIn activity engine over the HelmStack browser
 *
 * Drives the already-logged-in LinkedIn session inside HelmStack (see
 * helmstack-x-posting memory / helmstack_bootstrap flow). Two surfaces:
 *
 *   POSTING   — LinkedIn renders the share composer inside a SAME-ORIGIN iframe
 *               (src=linkedin.com/preload). Top-frame querySelector can't see it,
 *               so the editor/Post-button helpers search across every accessible
 *               iframe.contentDocument. Text goes in via HelmStack's insert-text
 *               endpoint (CDP Input.insertText → focused element, which crosses
 *               same-origin frames).
 *
 *   ENGAGEMENT — feed posts live in the TOP frame as div[role=listitem] blocks.
 *               LinkedIn ships fully hashed class names and no data-urn, so
 *               everything is selected by role / aria-label / visible text. During
 *               a scrape we stamp each post container with data-hunter-idx so
 *               later like/comment actions target it reliably even as the DOM
 *               shifts.
 *
 * All in-page snippets are sent as raw expressions (needed for cross-frame
 * contentDocument access, which serialised function args can't express cleanly).
 */

const hs = require("./helmstack");

const FEED_URL = "https://www.linkedin.com/feed/";
const OWN_HANDLE_HINT = "sebastian hunter";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cross-frame in-page helpers (raw JS, injected via hs.evaluate) ───────────
// A small library defined once per call so each expression can reuse it.
const HELPERS = `
  // Recurse through every same-origin frame — LinkedIn nests the share composer
  // two iframes deep and varies the depth between loads.
  var __frames = function(){
    var docs=[]; var seen=[];
    var walk=function(doc, depth){
      if(!doc || depth>5 || seen.indexOf(doc)>=0) return;
      seen.push(doc); docs.push(doc);
      var ifr=doc.querySelectorAll('iframe');
      for(var i=0;i<ifr.length;i++){ try{ if(ifr[i].contentDocument) walk(ifr[i].contentDocument, depth+1); }catch(e){} }
    };
    walk(document, 0);
    return docs;
  };
  var __q = function(sel){ var d=__frames(); for(var i=0;i<d.length;i++){ var el=d[i].querySelector(sel); if(el) return el; } return null; };
  var __qa = function(sel){ var out=[]; var d=__frames(); for(var i=0;i<d.length;i++){ out=out.concat([].slice.call(d[i].querySelectorAll(sel))); } return out; };
  var __btnByText = function(txt){ var re=new RegExp('^'+txt+'$','i'); return __qa('button').filter(function(b){ return re.test((b.innerText||'').trim()) && b.offsetParent!==null; }); };
`;

function evalRaw(tab, body, timeout = 20000) {
  return hs.evaluate(tab, `(function(){${HELPERS}\n${body}\n})()`, { timeout });
}

// ── Session / tab ────────────────────────────────────────────────────────────

async function ensureTab() {
  const tabs = await hs.listTabs();
  const existing = tabs.find((t) => /https:\/\/(www\.)?linkedin\.com/.test(t.url || ""));
  if (existing) return existing.id;
  const before = new Set(tabs.map((t) => t.id));
  const after = await hs.openTab(FEED_URL);
  const created = after.find((t) => !before.has(t.id));
  if (!created) throw new Error("linkedin: could not open a LinkedIn tab");
  return created.id;
}

async function sessionOk(tab) {
  try {
    const cookies = await hs.getCookies(tab);
    return cookies.some((c) => c.name === "li_at");
  } catch {
    return false;
  }
}

async function gotoFeed(tab, tag = "linkedin") {
  await hs.navigate(tab, FEED_URL);
  await hs.waitReady(tab, { tag });
  await sleep(2500);
}

// ── Posting ──────────────────────────────────────────────────────────────────

/**
 * Publish a LinkedIn post via LinkedIn's own content-creation API.
 *
 * LinkedIn isolates the share composer (editor + Post button) inside cross-origin
 * anti-automation iframes, so UI automation of it is unreliable. Instead we call
 * the voyager normShares endpoint with a same-origin `fetch` from the LinkedIn
 * page — the session cookies ride along and the CSRF token comes from JSESSIONID.
 * Returns the new post's permalink on success.
 *
 * @returns {{posted:boolean, url?:string|null, reason?:string, dryRun?:boolean}}
 */
async function post(tab, text, { dryRun = false, tag = "linkedin_post" } = {}) {
  // Same-origin fetch requires being on a linkedin.com page (for cookies + CSRF).
  const url = await hs.tabUrl(tab).catch(() => "");
  if (!/linkedin\.com/.test(url)) await gotoFeed(tab, tag);

  if (dryRun) {
    console.log(`[${tag}] DRY RUN — would publish ${text.length} chars via voyager API`);
    return { posted: false, reason: "dry_run", dryRun: true };
  }

  const textLiteral = JSON.stringify(text); // safe JS string literal for injection
  const expr = `(async function(){
    var m=document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    if(!m) return JSON.stringify({error:"no_csrf_cookie"});
    var csrf=m[1];
    var body={visibleToConnectionsOnly:false, externalAudienceProviders:[], commentaryV2:{text:${textLiteral}, attributes:[]}, origin:"FEED", allowedCommentersScope:"ALL", postState:"PUBLISHED", media:[]};
    try{
      var r=await fetch("https://www.linkedin.com/voyager/api/contentcreation/normShares",{
        method:"POST", credentials:"include",
        headers:{"csrf-token":csrf,"content-type":"application/json","accept":"application/vnd.linkedin.normalized+json+2.1"},
        body:JSON.stringify(body)
      });
      var t=await r.text();
      var mm=t.match(/urn:li:activity:(\\d+)/);
      return JSON.stringify({status:r.status, activity: mm?mm[0]:null, body:t.slice(0,180)});
    }catch(e){ return JSON.stringify({error:e.message}); }
  })()`;

  let res = {};
  try {
    res = JSON.parse(await hs.evaluate(tab, expr, { timeout: 30000 }));
  } catch (err) {
    return { posted: false, reason: `eval_failed:${err.message}` };
  }
  if (res.error) return { posted: false, reason: res.error };
  if (res.status === 201 || res.status === 200) {
    const postUrl = res.activity ? `https://www.linkedin.com/feed/update/${res.activity}/` : null;
    console.log(`[${tag}] published${postUrl ? `: ${postUrl}` : ""}`);
    return { posted: true, url: postUrl };
  }
  return { posted: false, reason: `http_${res.status}: ${(res.body || "").slice(0, 120)}` };
}

// ── Feed scraping + engagement (top frame) ───────────────────────────────────

/**
 * Scrape the feed. Stamps each post container with data-hunter-idx and returns
 * lightweight descriptors. Scrolls a few times to load more than the first page.
 * @returns {Array<{idx:number, author:string, text:string, liked:boolean, permalink:string|null}>}
 */
async function scrapeFeed(tab, { limit = 12, tag = "linkedin_engage" } = {}) {
  await gotoFeed(tab, tag);
  // Lazy-load a few screens
  for (let i = 0; i < 3; i++) {
    await hs.evaluate(tab, "window.scrollBy(0, window.innerHeight*1.5)").catch(() => {});
    await sleep(1500);
  }
  await hs.evaluate(tab, "window.scrollTo(0,0)").catch(() => {});
  await sleep(800);

  const raw = await evalRaw(
    tab,
    `var items=[].slice.call(document.querySelectorAll('div[role=listitem]')).filter(function(li){ return li.querySelector('button[aria-label=Comment]'); });
     var out=[];
     for(var i=0;i<items.length && out.length<${limit}; i++){
       var li=items[i];
       li.setAttribute('data-hunter-idx', String(out.length));
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
  // Drop own posts
  return parsed.filter((p) => !(p.author || "").toLowerCase().includes(OWN_HANDLE_HINT));
}

/** Like the post stamped with the given index. Returns true if it registered. */
async function likeByIdx(tab, idx, { dryRun = false } = {}) {
  if (dryRun) return true;
  const ok = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
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
 * Clicks Comment, focuses the inline editor, inserts text, submits.
 * @returns {{ok:boolean, reason?:string}}
 */
async function commentByIdx(tab, idx, text, { dryRun = false, tag = "linkedin_engage" } = {}) {
  // Open the comment box
  const opened = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
     if(!li) return 'no_post';
     var c=li.querySelector('button[aria-label=Comment]');
     if(!c) return 'no_comment_btn';
     c.click(); return 'ok';`
  ).catch((e) => `err:${e.message}`);
  if (opened !== "ok") return { ok: false, reason: `open:${opened}` };
  await sleep(1800);

  // Focus the comment editor inside this post
  const focused = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
     if(!li) return false;
     var ed=li.querySelector('.ql-editor') || li.querySelector('div[role=textbox]');
     if(!ed) return false;
     ed.focus(); return true;`
  ).catch(() => false);
  if (!focused) return { ok: false, reason: "editor_not_found" };
  await sleep(500);

  try {
    await hs.insertText(tab, text);
  } catch (err) {
    return { ok: false, reason: `insert:${err.message}` };
  }
  await sleep(1200);

  const got = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
     var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
     return ed ? (ed.innerText||'').trim() : '';`
  );
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  if (norm(got) !== norm(text)) return { ok: false, reason: "text_verify_failed" };

  if (dryRun) {
    console.log(`[${tag}] DRY RUN — comment staged on post #${idx}, not submitting`);
    // clear the box so nothing is left behind
    await evalRaw(
      tab,
      `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
       var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
       if(ed){ed.focus();document.execCommand('selectAll');document.execCommand('delete');}
       return true;`
    ).catch(() => {});
    return { ok: false, reason: "dry_run", dryRun: true };
  }

  // Submit. The comment box's submit button has visible text "Comment" and NO
  // aria-label — this distinguishes it from the action-bar toggle (aria-label
  // "Comment") and from reply-box submits (text "Reply"). A DOM click on it
  // publishes the comment (the box is top-frame, so no cross-origin issue).
  const clicked = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
     if(!li) return false;
     var b=[].slice.call(li.querySelectorAll('button')).find(function(x){
       return (x.innerText||'').trim()==='Comment' && !(x.getAttribute('aria-label')||'').trim()
         && x.getAttribute('aria-disabled')!=='true' && !x.disabled && x.offsetParent!==null;
     });
     if(!b) return false; b.click(); return true;`
  ).catch(() => false);
  if (!clicked) return { ok: false, reason: "submit_button_not_found" };
  await sleep(2500);

  // Confirm: the editor cleared (comment consumed)
  const cleared = await evalRaw(
    tab,
    `var li=document.querySelector('div[data-hunter-idx=\"${idx}\"]');
     var ed=li && (li.querySelector('.ql-editor')||li.querySelector('div[role=textbox]'));
     return ed ? (ed.innerText||'').trim().length===0 : true;`
  ).catch(() => true);
  return cleared ? { ok: true } : { ok: false, reason: "submit_unconfirmed" };
}

module.exports = {
  FEED_URL,
  ensureTab,
  sessionOk,
  gotoFeed,
  post,
  scrapeFeed,
  likeByIdx,
  commentByIdx,
};
