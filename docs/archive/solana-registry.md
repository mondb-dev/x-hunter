# Solana Agent Registry — Registration Steps

Registration mints Sebastian as a Metaplex Core NFT on Solana mainnet with
an on-chain identity, reputation score, and verifiable service endpoints.
Cost: ~0.009 SOL (~$0.81).

---

## Prerequisites

### 1. Solana wallet with ~0.01 SOL

Need a keypair. Two options:

**Option A — Generate a new dedicated wallet:**
```bash
node -e "
const { Keypair } = require('@solana/web3.js');
const kp = Keypair.generate();
console.log('Public key:', kp.publicKey.toBase58());
console.log('Private key (base58):', Buffer.from(kp.secretKey).toString('base64'));
"
```
Fund it with ~0.01 SOL from any exchange or existing Solana wallet.

**Option B — Use an existing wallet:**
Export the private key as a base64-encoded byte array and add to `.env`:
```
SOLANA_PRIVATE_KEY=<base64-encoded 64-byte secret key>
```

### 2. Pinata JWT (IPFS pinning)

Agent metadata and avatar are stored on IPFS. Pinata free tier is sufficient.

1. Sign up at https://pinata.cloud (free)
2. Go to API Keys → New Key → check `pinFileToIPFS` + `pinJSONToIPFS`
3. Copy the JWT and add to `.env`:
```
PINATA_JWT=<your pinata jwt>
```

### 3. Avatar image for Sebastian

Sebastian has no profile picture (`pfp_set: false`). The registry requires an image URI.

Options:
- Generate a simple avatar and save to `state/avatar.png`
- Use any existing image (PNG or JPG, square, min 200x200px)
- Use a placeholder URL (can be updated later via `sdk.updateAgent()`)

---

## Registration script

Once prerequisites are met, run:
```bash
node runner/solana_register.js
```

Script location: `runner/solana_register.js` (to be created)

What it does:
1. Loads keypair from `SOLANA_PRIVATE_KEY` in `.env`
2. Uploads avatar image to IPFS via Pinata → gets CID
3. Builds agent metadata JSON (name, description, skills, domains, services)
4. Uploads metadata JSON to IPFS → gets CID
5. Calls `sdk.registerAgent(metadataUri)` → on-chain TX, ~0.009 SOL
6. Saves the Solana asset address to `.env` as `SOLANA_AGENT_ASSET`

---

## Agent metadata fields

```json
{
  "name": "SebastianHunter",
  "description": "Every belief I hold is tracked with evidence, confidence score, and an Arweave-backed timestamp — tamper-proof from the first day. Browsing X/Twitter since Feb 2026. X: @SebastianHunts | Journal: https://sebastianhunter.fun",
  "image": "ipfs://<avatar CID>",
  "services": [
    { "type": "OASF", "value": "https://sebastianhunter.fun" }
  ],
  "skills": [
    "natural_language_processing/text_generation/text_generation",
    "natural_language_processing/sentiment_analysis/sentiment_analysis"
  ],
  "domains": [
    "technology/software_engineering/software_engineering",
    "social_media/content_creation/content_creation"
  ]
}
```

---

## npm package

```bash
cd /Users/mondb/Documents/Projects/hunter
npm install 8004-solana @solana/web3.js
```

---

## Post-registration

After registration, save to `.env`:
```
SOLANA_AGENT_ASSET=<Metaplex Core asset public key>
```

The asset address is Sebastian's permanent on-chain identity.
Can later be used to:
- Receive feedback/reputation scores from users
- Sign agent-to-agent (A2A) messages
- Prove liveness via `sdk.isItAlive()`
- Cross-reference with Arweave journal history as a second trust anchor

---

## References

- Solana Agent Registry: https://solana.com/agent-registry
- SDK docs: https://quantulabs.github.io/8004-solana/
- GitHub: https://github.com/QuantuLabs/8004-solana-ts
- Registry explorer: https://8004.qnt.sh
- Pinata: https://pinata.cloud
