/**
 * web/lib/memoryClient.ts
 *
 * Thin client for the hunter-memory internal API.
 * Falls back to direct Postgres (recallFromDB) if MEMORY_API_URL is not set.
 */

export interface MemoryHit {
  id?:        number;
  type:       string;
  source:     string;   // normalised from file_path/date/title
  title?:     string;
  date?:      string;
  file_path?: string;
  excerpt:    string;
  rank?:      number;
  score?:     number;
}

const MEMORY_API_URL = process.env.MEMORY_API_URL?.replace(/\/$/, "") ?? "";
const MEMORY_API_KEY = process.env.MEMORY_API_KEY ?? "";

function headers() {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (MEMORY_API_KEY) h["Authorization"] = `Bearer ${MEMORY_API_KEY}`;
  return h;
}

export async function recallViaAPI(
  query: string,
  limit = 8,
  types?: string[]
): Promise<MemoryHit[] | null> {
  if (!MEMORY_API_URL) return null;
  try {
    const res = await fetch(`${MEMORY_API_URL}/recall`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query, limit, types }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { hits: Omit<MemoryHit, "source">[] };
    return (data.hits ?? []).map((h) => ({
      ...h,
      source: h.file_path?.replace(/^(journals|checkpoints|articles)\//, "").replace(/\.(html|md)$/, "") ?? h.date ?? h.title ?? "unknown",
    }));
  } catch {
    return null;
  }
}

/**
 * Semantic recall — pass a pre-computed query embedding, get back the
 * most similar memory rows ranked by cosine similarity.
 * Returns null if MEMORY_API_URL is not set or the call fails.
 */
export async function semanticViaAPI(
  embedding: number[],
  limit = 8,
  types?: string[]
): Promise<MemoryHit[] | null> {
  if (!MEMORY_API_URL) return null;
  try {
    const res = await fetch(`${MEMORY_API_URL}/semantic`, {
      method:  "POST",
      headers: headers(),
      body:    JSON.stringify({ embedding, limit, types }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { hits: Omit<MemoryHit, "source">[] };
    return (data.hits ?? []).map((h) => ({
      ...h,
      source:
        (h.file_path ?? "")
          .replace(/^(journals|checkpoints|articles)\//, "")
          .replace(/\.(html|md)$/, "") ||
        h.date ||
        h.title ||
        "unknown",
    }));
  } catch {
    return null;
  }
}

export interface ContextSnapshot {
  vocation:     unknown;
  axes:         unknown[];
  recentMemory: MemoryHit[];
}

export async function contextViaAPI(
  axes = 8,
  journal = 3
): Promise<ContextSnapshot | null> {
  if (!MEMORY_API_URL) return null;
  try {
    const res = await fetch(`${MEMORY_API_URL}/context?axes=${axes}&journal=${journal}`, {
      headers: headers(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return await res.json() as ContextSnapshot;
  } catch {
    return null;
  }
}
