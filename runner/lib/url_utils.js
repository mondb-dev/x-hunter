"use strict";

const EXCLUDED_DOMAINS = new Set([
  "x.com",
  "twitter.com",
  "www.x.com",
  "www.twitter.com",
  "sebastianhunter.fun",
  "localhost",
  "127.0.0.1",
]);

const PRESERVE_HOSTS = [
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "news.ycombinator.com",
  "scholar.google.com",
  "courtlistener.com",
];

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "org.au", "gov.au",
]);

function normalizeDomain(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function isXDomain(hostname) {
  const host = normalizeDomain(hostname);
  return host === "x.com" || host === "twitter.com";
}

function canonicalDomain(hostname) {
  const host = normalizeDomain(hostname);
  if (!host) return "";

  for (const entry of PRESERVE_HOSTS) {
    if (host === entry || host.endsWith(`.${entry}`)) return entry;
  }

  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const tail2 = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(tail2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}

function normalizeUrl(rawUrl, opts = {}) {
  const { allowX = false } = opts;
  if (!rawUrl) return null;

  try {
    const u = new URL(rawUrl);
    u.hash = "";
    const canonical = canonicalDomain(u.hostname);
    if (!canonical) return null;
    if (!allowX && EXCLUDED_DOMAINS.has(canonical)) return null;

    return {
      url: u.toString(),
      domain: canonical,
      hostname: normalizeDomain(u.hostname),
      pathname: u.pathname || "/",
      search: u.search || "",
    };
  } catch {
    return null;
  }
}

function extractUrls(text) {
  return (String(text || "").match(/https?:\/\/[^\s"'<>`]+/g) || [])
    .map(url => url.replace(/[),.;!?]+$/, ""));
}

function uniqueUrls(urls, opts = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    const normalized = normalizeUrl(raw, opts);
    if (!normalized) continue;
    if (seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push(normalized);
  }
  return out;
}

function normalizedExternalUrls(urls) {
  return uniqueUrls(urls, { allowX: false });
}

function domainsFromUrls(urls) {
  return [...new Set((urls || []).map(item => item.domain).filter(Boolean))];
}

module.exports = {
  EXCLUDED_DOMAINS,
  canonicalDomain,
  normalizeDomain,
  normalizeUrl,
  isXDomain,
  extractUrls,
  uniqueUrls,
  normalizedExternalUrls,
  domainsFromUrls,
};
