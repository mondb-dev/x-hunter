#!/usr/bin/env node
// scripts/gen-wallet.js — Generate a Solana Ed25519 keypair
// No external dependencies — uses built-in Node.js crypto (requires Node >= 15)
//
// Usage:
//   node scripts/gen-wallet.js
//
// Output: two lines ready to paste into your .env file

const crypto = require("crypto");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  let num = BigInt("0x" + buf.toString("hex"));
  let result = "";
  while (num > 0n) {
    result = BASE58[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const byte of buf) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

// Generate Ed25519 keypair using built-in Node crypto
const { privateKey: pkcs8, publicKey: spki } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki",  format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});

// SPKI Ed25519:  12-byte header  + 32-byte public key
// PKCS8 Ed25519: 16-byte header  + 32-byte private seed
const pubBytes  = spki.slice(12);
const seedBytes = pkcs8.slice(16);

// Solana full keypair = seed (32) + pubkey (32)
const fullKeypair = Buffer.concat([seedBytes, pubBytes]);

const pubKey  = base58Encode(pubBytes);
const privKey = base58Encode(fullKeypair);

console.log("");
console.log("━━━  Sebastian D. Hunter — Solana Wallet  ━━━");
console.log("");
console.log("Add to your .env:");
console.log("");
console.log(`SOLANA_PUBLIC_KEY=${pubKey}`);
console.log(`SOLANA_PRIVATE_KEY=${privKey}`);
console.log("");
console.log("Public key (share freely):");
console.log(`  ${pubKey}`);
console.log("");
console.log("⚠  Keep SOLANA_PRIVATE_KEY secret. Never commit .env.");
console.log("");
