"use strict";
/**
 * helmstack-social — public API.
 *
 *   const { HelmStackClient, LinkedIn } = require("helmstack-social");
 *   const client = new HelmStackClient();            // reads HELMSTACK_URL / _AUTH_TOKEN
 *   const li = new LinkedIn(client, { ownHandleHint: "sebastian hunter" });
 *   await li.ensureTab();
 *   await li.post("Hello LinkedIn");
 *   await li.engage({ score, generateComment, onLike, onComment });
 */

const { HelmStackClient } = require("./client");
const { LinkedIn, FEED_URL } = require("./linkedin");
const session = require("./session");

module.exports = { HelmStackClient, LinkedIn, session, LINKEDIN_FEED_URL: FEED_URL };
