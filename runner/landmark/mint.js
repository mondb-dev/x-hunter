/**
 * runner/landmark/mint.js — Solana Metaplex Edition minter
 *
 * Handles the full NFT lifecycle:
 *   1. Upload card image + metadata JSON to Arweave via Irys
 *   2. Create a Metaplex Master Edition NFT
 *   3. (Later) Print editions on-demand
 *
 * Uses @metaplex-foundation/umi + mpl-token-metadata.
 * These deps must be added to runner/package.json before enabling.
 *
 * IMPORTANT: This module is NOT enabled yet.
 * The pipeline must be tested end-to-end before activation.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { EDITION_SUPPLY, COLLECT_PRICE_SOL, CARD_TIERS, PATHS } = require("./config");

// Load .env
const ROOT = path.resolve(__dirname, "../..");
const ENV_PATH = path.join(ROOT, ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ── Irys upload (reuses archive.js pattern) ───────────────────────────────────

let _irys = null;

async function getIrys() {
  if (_irys) return _irys;
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) throw new Error("[mint] SOLANA_PRIVATE_KEY not set");

  const Irys = require("@irys/sdk");
  const irys = new Irys({
    url:    "https://node1.irys.xyz",
    token:  "solana",
    key,
    config: { providerUrl: "https://api.mainnet-beta.solana.com" },
  });
  await irys.ready();
  _irys = irys;
  return irys;
}

/**
 * Upload a buffer to Arweave via Irys.
 * @param {Buffer} data
 * @param {string} contentType
 * @param {object} tags - key/value pairs for Arweave tags
 * @returns {Promise<string>} Arweave transaction ID
 */
async function uploadToArweave(data, contentType, tags = {}) {
  const irys = await getIrys();

  const price   = await irys.getPrice(data.length);
  const balance = await irys.getLoadedBalance();
  if (balance.lt(price)) {
    throw new Error(`[mint] Irys balance too low: need ${irys.utils.fromAtomic(price)} SOL`);
  }

  const arweaveTags = [
    { name: "Content-Type", value: contentType },
    { name: "App-Name",     value: "sebastian-hunter-landmark" },
  ];
  for (const [k, v] of Object.entries(tags)) {
    arweaveTags.push({ name: k, value: String(v) });
  }

  const receipt = await irys.upload(data, { tags: arweaveTags });
  return receipt.id;
}

// ── Metadata builder ──────────────────────────────────────────────────────────

/**
 * Build Metaplex-compatible JSON metadata.
 *
 * @param {object} params
 * @param {string} params.name           - NFT name
 * @param {string} params.description    - NFT description
 * @param {string} params.imageUri       - Arweave URI for card image
 * @param {string} params.editorialUri   - Arweave URI for full editorial
 * @param {number} params.signalCount    - detection signal count
 * @param {string} params.tierName       - Silver/Gold/Prismatic/Obsidian
 * @param {number} params.landmarkNumber - sequential ID
 * @param {string} params.date           - event date
 * @param {string[]} params.topKeywords  - event keywords
 * @returns {object} JSON metadata
 */
function buildMetadata(params) {
  return {
    name:         params.name,
    symbol:       "HUNT",
    description:  params.description,
    image:        params.imageUri,
    external_url: `https://sebastianhunter.fun/landmarks/${params.landmarkNumber}`,
    attributes: [
      { trait_type: "Tier",            value: params.tierName },
      { trait_type: "Signal Strength", value: params.signalCount },
      { trait_type: "Landmark",        value: `#${params.landmarkNumber}` },
      { trait_type: "Date",            value: params.date },
      ...(params.topKeywords || []).slice(0, 5).map(kw => ({
        trait_type: "Topic", value: kw,
      })),
    ],
    properties: {
      category: "image",
      files: [
        { uri: params.imageUri,     type: "image/png" },
        { uri: params.editorialUri, type: "text/html" },
      ],
      creators: [
        {
          address: process.env.SOLANA_AGENT_PUBLIC_KEY || process.env.SOLANA_PUBLIC_KEY,
          share:   100,
        },
      ],
    },
  };
}

// ── Metaplex Master Edition creation ──────────────────────────────────────────

/**
 * Create a Metaplex Master Edition NFT on Solana.
 *
 * Requires: @metaplex-foundation/umi,
 *           @metaplex-foundation/umi-bundle-defaults,
 *           @metaplex-foundation/mpl-token-metadata
 *
 * @param {string} metadataUri - Arweave URI to the JSON metadata
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} opts.maxSupply - max print editions (0 = unlimited)
 * @param {number} opts.sellerFeeBasisPoints - royalty in basis points (e.g., 500 = 5%)
 * @returns {Promise<{mintAddress: string, signature: string}>}
 */
async function createMasterEdition(metadataUri, opts = {}) {
  // Lazy import — these deps may not be installed yet
  let createUmi, mplTokenMetadata, bs58;
  try {
    const umiBundle = require("@metaplex-foundation/umi-bundle-defaults");
    createUmi = umiBundle.createUmi;
    mplTokenMetadata = require("@metaplex-foundation/mpl-token-metadata");
    bs58 = require("bs58");
  } catch (err) {
    throw new Error(
      `[mint] Missing Metaplex deps: ${err.message}\n` +
      "Run: cd runner && npm install @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults @metaplex-foundation/mpl-token-metadata bs58"
    );
  }

  const { generateSigner, keypairIdentity, percentAmount } = require("@metaplex-foundation/umi");

  // Initialize UMI
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const umi = createUmi(rpcUrl).use(mplTokenMetadata.mplTokenMetadata());

  // Load wallet keypair
  const secretKey = process.env.SOLANA_AGENT_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  if (!secretKey) throw new Error("[mint] No Solana private key found in env");

  const decoded = bs58.decode(secretKey);
  const keypair = umi.eddsa.createKeypairFromSecretKey(decoded);
  umi.use(keypairIdentity(keypair));

  // Create the NFT
  const mint = generateSigner(umi);

  const { signature } = await mplTokenMetadata.createNft(umi, {
    mint,
    name:                    opts.name || "Sebastian Hunter Landmark",
    uri:                     metadataUri,
    sellerFeeBasisPoints:    percentAmount(opts.sellerFeeBasisPoints || 500), // 5% royalty
    maxSupply:               opts.maxSupply ?? 0,
    isCollection:            false,
    creators: [
      { address: keypair.publicKey, verified: true, share: 100 },
    ],
  }).sendAndConfirm(umi);

  const mintAddress = mint.publicKey.toString();
  console.log(`[mint] Master Edition created: ${mintAddress}`);
  console.log(`[mint] Signature: ${signature}`);

  return { mintAddress, signature: signature.toString() };
}

// ── Full mint pipeline ────────────────────────────────────────────────────────

/**
 * Upload assets to Arweave and create a Metaplex Master Edition.
 *
 * @param {object} event        - landmark event
 * @param {object} content      - editorial content { headline, lead, editorial }
 * @param {string} editorialHtml - full Arweave HTML
 * @param {string} cardImagePath - path to the card PNG
 * @param {object} opts
 * @param {number} opts.landmarkNumber
 * @returns {Promise<{mintAddress, metadataUri, imageUri, editorialUri, signature}>}
 */
async function mintLandmark(event, content, editorialHtml, cardImagePath, opts = {}) {
  const lnum = opts.landmarkNumber || 1;
  const tier = CARD_TIERS[Math.min(Math.max(event.signalCount, 3), 6)];
  const maxSupply = EDITION_SUPPLY[event.signalCount] || 1000;

  console.log(`[mint] Starting mint for Landmark #${lnum} (${tier.name}, supply: ${maxSupply})`);

  // 1. Upload card image to Arweave
  console.log("[mint] Uploading card image to Arweave...");
  const imageData = fs.readFileSync(cardImagePath);
  const imageId = await uploadToArweave(imageData, "image/png", {
    Type:     "landmark-card",
    Landmark: String(lnum),
    Tier:     tier.name,
  });
  const imageUri = `https://gateway.irys.xyz/${imageId}`;
  console.log(`[mint] Card image uploaded: ${imageUri}`);

  // 2. Upload editorial HTML to Arweave
  console.log("[mint] Uploading editorial to Arweave...");
  const editorialBuf = Buffer.from(editorialHtml, "utf-8");
  const editorialId = await uploadToArweave(editorialBuf, "text/html", {
    Type:     "landmark-editorial",
    Landmark: String(lnum),
  });
  const editorialUri = `https://gateway.irys.xyz/${editorialId}`;
  console.log(`[mint] Editorial uploaded: ${editorialUri}`);

  // 3. Build and upload metadata JSON
  const dateStr = event.windowStart
    ? new Date(event.windowStart).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const metadata = buildMetadata({
    name:           `Landmark #${lnum}: ${content.headline}`,
    description:    content.lead || content.headline,
    imageUri,
    editorialUri,
    signalCount:    event.signalCount,
    tierName:       tier.name,
    landmarkNumber: lnum,
    date:           dateStr,
    topKeywords:    event.topKeywords || [],
  });

  console.log("[mint] Uploading metadata to Arweave...");
  const metaBuf = Buffer.from(JSON.stringify(metadata, null, 2), "utf-8");
  const metaId = await uploadToArweave(metaBuf, "application/json", {
    Type:     "landmark-metadata",
    Landmark: String(lnum),
  });
  const metadataUri = `https://gateway.irys.xyz/${metaId}`;
  console.log(`[mint] Metadata uploaded: ${metadataUri}`);

  // 4. Create Master Edition on Solana
  console.log("[mint] Creating Master Edition on Solana...");
  const { mintAddress, signature } = await createMasterEdition(metadataUri, {
    name:                 `Landmark #${lnum}`,
    maxSupply,
    sellerFeeBasisPoints: 500, // 5%
  });

  // 5. Log to arweave_log.json
  const arweaveLogPath = PATHS.ARWEAVE_LOG;
  let arweaveLog;
  try { arweaveLog = JSON.parse(fs.readFileSync(arweaveLogPath, "utf-8")); }
  catch { arweaveLog = { uploads: [] }; }

  arweaveLog.uploads.push(
    { tx_id: imageId,     type: "landmark-card",       landmark: lnum, gateway: imageUri,     uploaded_at: new Date().toISOString() },
    { tx_id: editorialId, type: "landmark-editorial",  landmark: lnum, gateway: editorialUri, uploaded_at: new Date().toISOString() },
    { tx_id: metaId,      type: "landmark-metadata",   landmark: lnum, gateway: metadataUri,  uploaded_at: new Date().toISOString() },
  );
  fs.writeFileSync(arweaveLogPath, JSON.stringify(arweaveLog, null, 2));

  return { mintAddress, metadataUri, imageUri, editorialUri, signature };
}

module.exports = { mintLandmark, buildMetadata, uploadToArweave, createMasterEdition };
