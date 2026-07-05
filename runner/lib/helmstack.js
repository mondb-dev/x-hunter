"use strict";
/**
 * runner/lib/helmstack.js — hunter's functional shim over the standalone
 * `helmstack-social` package client (tools/helmstack-social).
 *
 * The package is the single source of the HelmStack client; this shim preserves
 * the flat function API that the X backend (post_x_helmstack.js) and the cookie
 * bootstrap were written against, plus the X-specific `ensureXTab` helper.
 * New code should prefer `new HelmStackClient()` from the package directly.
 */

const { HelmStackClient } = require("../../tools/helmstack-social/src/client");

const client = new HelmStackClient(); // reads HELMSTACK_URL / HELMSTACK_AUTH_TOKEN

module.exports = {
  client,
  HELMSTACK_URL: client.url,
  request:   (...a) => client.request(...a),
  health:    () => client.health(),
  listTabs:  () => client.listTabs(),
  openTab:   (u) => client.openTab(u),
  navigate:  (id, u) => client.navigate(id, u),
  getCookies:(id) => client.getCookies(id),
  setCookie: (id, c) => client.setCookie(id, c),
  screenshot:(id) => client.screenshot(id),
  insertText:(id, t) => client.insertText(id, t),
  pressKey:  (id, o) => client.pressKey(id, o),
  metaEnter: (id) => client.metaEnter(id),
  clickAt:   (id, x, y) => client.clickAt(id, x, y),
  evaluate:  (id, e, o) => client.evaluate(id, e, o),
  evalFn:    (id, fn, ...a) => client.evalFn(id, fn, ...a),
  tabUrl:    (id) => client.tabUrl(id),
  pollFn:    (id, l, fn, o) => client.pollFn(id, l, fn, o),
  waitReady: (id, o) => client.waitReady(id, o),
  approvals: () => client.approvals(),
  approve:   (id) => client.approve(id),
  // X-specific convenience preserved for the X backend + bootstrap.
  ensureXTab: () => client.ensureTab(/https:\/\/(www\.)?(x|twitter)\.com/, "https://x.com/home"),
};
