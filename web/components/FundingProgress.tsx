"use client";

import { useEffect, useState } from "react";

// Public endpoints (no key). Both are CORS-friendly; the bar degrades gracefully
// if either is rate-limited or down.
const RPC = "https://api.mainnet-beta.solana.com";
const PRICE = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

const fmtSol = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtUsd = (n: number) => "$" + Math.round(n).toLocaleString();

export default function FundingProgress({
  targetUsd,
  walletAddress,
}: {
  targetUsd: number;
  walletAddress: string | null;
}) {
  const [sol, setSol] = useState<number | null>(null); // wallet balance (SOL)
  const [price, setPrice] = useState<number | null>(null); // SOL → USD
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [priceRes, balRes] = await Promise.all([
        fetch(PRICE).then((r) => r.json()).catch(() => null),
        walletAddress
          ? fetch(RPC, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
            })
              .then((r) => r.json())
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!alive) return;
      const p = priceRes?.solana?.usd ?? null;
      const lamports = balRes?.result?.value ?? null;
      setPrice(typeof p === "number" ? p : null);
      setSol(typeof lamports === "number" ? lamports / 1e9 : null);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [walletAddress]);

  const raisedUsd = sol != null && price != null ? sol * price : null;
  const targetSol = price != null && price > 0 ? targetUsd / price : null;
  const pct = raisedUsd != null && targetUsd > 0 ? Math.min(100, (raisedUsd / targetUsd) * 100) : 0;

  const copy = () => {
    if (!walletAddress) return;
    navigator.clipboard?.writeText(walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fund-progress">
      <div className="fund-progress-head">
        <span className="fund-progress-label">One year of running</span>
        <span className="fund-progress-nums">
          {raisedUsd != null ? fmtUsd(raisedUsd) : "$0"} <span className="fund-muted">/ {fmtUsd(targetUsd)}</span>
        </span>
      </div>

      <div className="fund-track" aria-hidden>
        <div className="fund-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="fund-progress-foot">
        <span>
          {sol != null ? `${fmtSol(sol)} SOL raised` : loaded ? "0 SOL raised" : "loading balance…"}
          {targetSol != null ? ` · ~${fmtSol(targetSol)} SOL needed for a year` : ""}
        </span>
        <span className="fund-muted">{Math.round(pct)}%</span>
      </div>

      {walletAddress && (
        <button className="fund-wallet" onClick={copy} title="Copy tip address">
          <span className="fund-muted">tip / gift ◎</span>
          <code>{walletAddress}</code>
          <span className="fund-copy">{copied ? "copied ✓" : "copy"}</span>
        </button>
      )}
    </div>
  );
}
