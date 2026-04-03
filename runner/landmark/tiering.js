"use strict";

const { LANDMARK_TIERS } = require("./config");

const ARTICLE_COHERENCE_MIN = 0.55;
const MINT_COHERENCE_MIN = 0.72;
const MIN_RELEVANCE_SCORE = 0.35;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizeKeyword(keyword) {
  return String(keyword || "")
    .toLowerCase()
    .replace(/\(\d+\s+users?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildTopicCenters(event) {
  const centers = [];

  for (const topic of (event.stats?.crossClusterTopics || event.crossClusterTopics || [])) {
    const keyword = normalizeKeyword(typeof topic === "string" ? topic : topic.keyword);
    if (!keyword) continue;
    centers.push({
      keyword,
      clusters: Number(topic?.clusters || 0),
      users: Number(topic?.users || 0),
      source: "cross_cluster",
    });
  }

  for (const topic of (event.topKeywordsDetail || [])) {
    const keyword = normalizeKeyword(topic.keyword);
    if (!keyword) continue;
    centers.push({
      keyword,
      clusters: 0,
      users: Number(topic.users || 0),
      source: "top_keyword",
    });
  }

  for (const keyword of (event.topKeywords || [])) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) continue;
    centers.push({
      keyword: normalized,
      clusters: 0,
      users: 0,
      source: "headline_keyword",
    });
  }

  const merged = new Map();
  for (const center of centers) {
    const existing = merged.get(center.keyword);
    if (!existing) {
      merged.set(center.keyword, { ...center });
      continue;
    }
    existing.clusters = Math.max(existing.clusters, center.clusters);
    existing.users = Math.max(existing.users, center.users);
  }

  return Array.from(merged.values());
}

function keywordOverlapScore(text, keyword) {
  const normalizedText = String(text || "").toLowerCase();
  if (!keyword) return 0;
  if (normalizedText.includes(keyword)) return 1;

  const textTokens = new Set(tokenize(text));
  const keywordTokens = tokenize(keyword);
  if (keywordTokens.length === 0) return 0;

  let overlap = 0;
  for (const token of keywordTokens) {
    if (textTokens.has(token)) overlap++;
  }
  return overlap / keywordTokens.length;
}

function scorePostAgainstCenters(post, centers) {
  const text = post?.text || "";
  let best = 0;

  for (const center of centers) {
    let score = keywordOverlapScore(text, center.keyword);
    if (score > 0) {
      if (center.clusters >= 2) score += 0.1;
      if (center.users >= 3) score += 0.1;
    }
    best = Math.max(best, clamp(score));
  }

  return clamp(best);
}

function summarizeEvidence(event) {
  const samplePosts = Array.isArray(event.samplePosts) ? event.samplePosts : [];
  const topicCenters = buildTopicCenters(event);
  const postScores = samplePosts.map(post => ({
    username: post?.username || null,
    score: scorePostAgainstCenters(post, topicCenters),
  }));

  const relevant = postScores.filter(post => post.score >= MIN_RELEVANCE_SCORE);
  const clusterCount = Math.max(
    ...topicCenters.map(center => Number(center.clusters || 0)),
    event.signals?.crossCluster ? 2 : 0,
  );
  const repeatedCenters = topicCenters.filter(center => center.users >= 3 || center.clusters >= 2);

  return {
    topicCenters,
    postScores,
    relevantPosts: relevant.length,
    distinctAccounts: new Set(relevant.map(post => String(post.username || "").toLowerCase()).filter(Boolean)).size,
    clusterCount,
    repeatedTopicCenter: repeatedCenters.length > 0,
    repeatedTopicNames: uniqueStrings(repeatedCenters.map(center => center.keyword)).slice(0, 5),
  };
}

function computeCoherenceScore(event, evidenceSummary) {
  const postScores = evidenceSummary.postScores || [];
  const avgRelevance = postScores.length
    ? postScores.reduce((sum, post) => sum + post.score, 0) / postScores.length
    : 0;
  const clusterSupport = clamp((evidenceSummary.clusterCount - 1) / 2);
  const repeatedCenterScore = evidenceSummary.repeatedTopicCenter ? 1 : 0;
  const signalStrength = clamp(((event.signalCount || 0) - 3) / 3);

  return clamp(
    avgRelevance * 0.55 +
    clusterSupport * 0.2 +
    repeatedCenterScore * 0.15 +
    signalStrength * 0.1
  );
}

function normalizeSpecialKind(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function resolveSpecialStage(event, opts = {}) {
  const specialKind = normalizeSpecialKind(
    opts.specialKind ||
    event.specialKind ||
    event.specialType ||
    event.special_type
  );

  if (specialKind === "vocation" || specialKind === "vocation_change") {
    return "special_vocation";
  }

  if (specialKind === "prediction" || specialKind === "special_prediction") {
    const validated = Boolean(
      opts.predictionValidated ??
      event.predictionValidated ??
      event.prediction_validated ??
      event.validated
    );
    return validated ? "special_prediction" : null;
  }

  return null;
}

function resolveTierFromStage(stage) {
  if (stage === "article") return LANDMARK_TIERS.tier_2;
  if (stage === "mint") return LANDMARK_TIERS.tier_1;
  if (stage === "special_vocation") return LANDMARK_TIERS.special_vocation;
  if (stage === "special_prediction") return LANDMARK_TIERS.special_prediction;
  return null;
}

function evaluateLandmark(event, opts = {}) {
  const specialStage = resolveSpecialStage(event, opts);
  const evidenceSummary = summarizeEvidence(event);
  const coherenceScore = typeof opts.coherenceScore === "number"
    ? clamp(opts.coherenceScore)
    : (typeof event.coherenceScore === "number"
      ? clamp(event.coherenceScore)
      : computeCoherenceScore(event, evidenceSummary));

  const signalCount = Number(event.signalCount || 0);
  const crossCluster = Boolean(event.signals?.crossCluster);
  const multiAxis = Boolean(event.signals?.multiAxis);
  const editorialValidationPass = Boolean(
    opts.editorialValidationPass ??
    event.editorialValidationPass ??
    event.editorial_validation_pass
  );
  const canonicalLandmarkPageExists = Boolean(
    opts.canonicalLandmarkPageExists ??
    event.canonicalLandmarkPageExists ??
    event.canonical_landmark_page_exists ??
    opts.canonicalLandmarkUrl ??
    event.canonicalLandmarkUrl ??
    event.canonical_landmark_url
  );

  const evidenceDensityPass = (
    evidenceSummary.relevantPosts >= 4 &&
    evidenceSummary.distinctAccounts >= 3 &&
    evidenceSummary.clusterCount >= 2 &&
    evidenceSummary.repeatedTopicCenter
  );

  const articleGatePass = (
    signalCount >= 4 &&
    crossCluster &&
    evidenceDensityPass &&
    coherenceScore >= ARTICLE_COHERENCE_MIN
  );

  const mintGatePass = (
    signalCount >= 5 &&
    crossCluster &&
    multiAxis &&
    evidenceDensityPass &&
    coherenceScore >= MINT_COHERENCE_MIN &&
    editorialValidationPass &&
    canonicalLandmarkPageExists
  );

  let stage = signalCount >= 3 ? "candidate" : "none";
  if (specialStage) {
    stage = specialStage;
  } else if (mintGatePass) {
    stage = "mint";
  } else if (articleGatePass) {
    stage = "article";
  }

  const tier = resolveTierFromStage(stage);

  return {
    stage,
    tier,
    articleEligible: Boolean(tier),
    nftEligible: Boolean(tier),
    specialStage,
    coherenceScore,
    evidenceSummary,
    gates: {
      candidate: signalCount >= 3,
      evidenceDensity: evidenceDensityPass,
      article: articleGatePass,
      mint: mintGatePass,
      crossCluster,
      multiAxis,
      editorialValidation: editorialValidationPass,
      canonicalLandmarkPage: canonicalLandmarkPageExists,
    },
  };
}

function extractMentions(text) {
  return uniqueStrings(
    Array.from(String(text || "").matchAll(/@([A-Za-z0-9_]{1,15})/g)).map(match => match[1].toLowerCase())
  );
}

function validateEditorialForMint(event, content) {
  const sampleUsers = new Set(
    (event.samplePosts || [])
      .map(post => String(post?.username || "").toLowerCase())
      .filter(Boolean)
  );
  const mentions = extractMentions(content?.editorial || "");
  const unknownMentions = mentions.filter(username => !sampleUsers.has(username));
  const centers = buildTopicCenters(event).map(center => center.keyword);
  const combinedText = [
    content?.headline || "",
    content?.lead || "",
    content?.editorial || "",
  ].join(" ").toLowerCase();
  const matchedCenters = uniqueStrings(centers.filter(center => center && combinedText.includes(center)));

  const reasons = [];
  if (!content?.headline?.trim()) reasons.push("missing headline");
  if (!content?.lead?.trim()) reasons.push("missing lead");
  if (!content?.editorial || content.editorial.trim().length < 200) reasons.push("editorial too short");
  if (unknownMentions.length > 0) reasons.push(`unknown mentions: ${unknownMentions.map(name => `@${name}`).join(", ")}`);
  if (matchedCenters.length === 0) reasons.push("editorial does not reference event topic centers");

  return {
    passed: reasons.length === 0,
    reasons,
    mentions,
    unknownMentions,
    matchedCenters,
  };
}

function getTier(key) {
  return LANDMARK_TIERS[key] || null;
}

module.exports = {
  ARTICLE_COHERENCE_MIN,
  MINT_COHERENCE_MIN,
  evaluateLandmark,
  getTier,
  resolveTierFromStage,
  summarizeEvidence,
  computeCoherenceScore,
  validateEditorialForMint,
};
