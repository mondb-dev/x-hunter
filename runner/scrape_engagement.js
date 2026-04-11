#!/usr/bin/env node
'use strict';
/**
 * runner/scrape_engagement.js — fetch engagement metrics for recent own posts
 *
 * Uses the X API v2 to pull the last 10 tweets from @SebastianHunts and
 * compute a simple engagement summary. Writes state/engagement_summary.json.
 *
 * Reads: state/posts_log.json (to correlate tweet URLs → known post types)
 * Writes: state/engagement_summary.json
 *
 * Called from post_browse.js every 6 cycles (~2h) via stamp file.
 * Non-fatal — swallows all errors.
 */

const fs   = require('fs');
const path = require('path');
const { getUserByUsername, getUserTweets } = require('./x_api');

const ROOT    = path.resolve(__dirname, '..');
const STATE   = path.join(ROOT, 'state');
const OUT     = path.join(STATE, 'engagement_summary.json');
const LOG     = path.join(STATE, 'posts_log.json');

function log(msg) { console.log(`[engagement] ${msg}`); }

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function run() {
  const username = (process.env.X_USERNAME || '').trim();
  if (!username) throw new Error('X_USERNAME not set');

  // Resolve user ID
  const userRes = await getUserByUsername(username, { 'user.fields': 'id,public_metrics' });
  const userId  = userRes?.data?.id;
  if (!userId) throw new Error(`could not resolve user ID for @${username}`);

  const followers = userRes?.data?.public_metrics?.followers_count ?? 0;

  // Fetch last 10 tweets (excludes replies/retweets to focus on original posts)
  const tweetsRes = await getUserTweets(userId, {
    max_results:    10,
    'tweet.fields': 'created_at,public_metrics,text',
    exclude:        'replies,retweets',
  });

  const tweets = tweetsRes?.data ?? [];
  if (!tweets.length) {
    log('no tweets found');
    return;
  }

  // Compute per-tweet metrics
  const items = tweets.map(t => {
    const m = t.public_metrics ?? {};
    return {
      tweet_id:   t.id,
      created_at: t.created_at,
      text_preview: (t.text || '').slice(0, 80).replace(/\n/g, ' '),
      likes:   m.like_count    ?? 0,
      replies: m.reply_count   ?? 0,
      rts:     m.retweet_count ?? 0,
      quotes:  m.quote_count   ?? 0,
      impressions: m.impression_count ?? null,
    };
  });

  // Aggregate stats
  const likeCounts    = items.map(i => i.likes);
  const replyCounts   = items.map(i => i.replies);
  const totalLikes    = likeCounts.reduce((a, b) => a + b, 0);
  const totalReplies  = replyCounts.reduce((a, b) => a + b, 0);
  const avgLikes      = totalLikes / items.length;
  const avgReplies    = totalReplies / items.length;
  const medianLikes   = median(likeCounts);
  const medianReplies = median(replyCounts);

  // Best post
  const best = [...items].sort((a, b) => (b.likes + b.replies * 3) - (a.likes + a.replies * 3))[0];

  // Trend: compare first half to second half (oldest → newest)
  const half = Math.floor(items.length / 2);
  const newer = items.slice(0, half);   // API returns newest-first
  const older = items.slice(half);
  const newerAvgLikes = newer.reduce((a, i) => a + i.likes, 0) / (newer.length || 1);
  const olderAvgLikes = older.reduce((a, i) => a + i.likes, 0) / (older.length || 1);
  const trend = newerAvgLikes > olderAvgLikes * 1.1 ? 'up'
    : newerAvgLikes < olderAvgLikes * 0.9 ? 'down'
    : 'flat';

  const summary = {
    generated_at:  new Date().toISOString(),
    username,
    followers,
    window:        `last ${items.length} original tweets`,
    stats: {
      avg_likes:      parseFloat(avgLikes.toFixed(1)),
      avg_replies:    parseFloat(avgReplies.toFixed(1)),
      median_likes:   medianLikes,
      median_replies: medianReplies,
      total_likes:    totalLikes,
      total_replies:  totalReplies,
      trend,            // 'up' | 'down' | 'flat' (recent vs older)
    },
    best: best ? {
      tweet_id:     best.tweet_id,
      text_preview: best.text_preview,
      likes:        best.likes,
      replies:      best.replies,
      created_at:   best.created_at,
    } : null,
    recent: items,
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  log(`written: avg ${avgLikes.toFixed(1)} likes, ${avgReplies.toFixed(1)} replies across last ${items.length} posts (trend: ${trend})`);
}

run().catch(err => {
  console.error(`[engagement] failed: ${err.message}`);
  process.exit(0); // non-fatal
});
