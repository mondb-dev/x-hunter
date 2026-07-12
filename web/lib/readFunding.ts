import { cachedReadFileSync } from "./fileCache";

export type FundingItem = { label: string; annualUsd: number };
export type Funding = {
  annualTotalUsd: number;
  items: FundingItem[];
  walletAddress: string | null;
  generatedAt: string | null;
};

const round = (n: number) => Math.round(n);

/**
 * Reads the operating-cost self-model (state/operating_cost.json, written by
 * runner/lib/operating_cost.js) + the tip wallet address and produces an
 * annualized cost breakdown for the website's funding section. Monthly figures
 * are ×12; LLM spend is metered, hosting/domain are fixed config.
 */
export function readFunding(): Funding {
  let oc: {
    monthly_usd?: { llm?: number; fixed?: number; total?: number };
    fixed_breakdown?: { host?: number; domain?: number; vercel?: number; other?: number };
    generated_at?: string;
  } | null = null;
  let tw: { address?: string } | null = null;

  try { oc = JSON.parse(cachedReadFileSync("state/operating_cost.json")); } catch { /* not built yet */ }
  try { tw = JSON.parse(cachedReadFileSync("state/tip_wallet.json")); } catch { /* no wallet */ }

  const m = oc?.monthly_usd ?? {};
  const fb = oc?.fixed_breakdown ?? {};

  const items: FundingItem[] = [];
  const push = (label: string, monthly: number) => {
    if (monthly && monthly > 0) items.push({ label, annualUsd: round(monthly * 12) });
  };
  push("Hosting — cloud compute", fb.host ?? 0);
  push("LLM / inference", m.llm ?? 0);
  push("Website hosting", fb.vercel ?? 0);
  push("Domain", fb.domain ?? 0);
  push("Other", fb.other ?? 0);

  const annualTotalUsd = round((m.total ?? 0) * 12);

  return {
    annualTotalUsd,
    items,
    walletAddress: tw?.address ?? null,
    generatedAt: oc?.generated_at ?? null,
  };
}
