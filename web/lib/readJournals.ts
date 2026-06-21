import path from "path";
import { cachedReadFileSync, cachedReaddirSync } from "./fileCache";

export interface JournalEntry {
  date: string;
  hour: number;
  day: number;
  slug: string;
  title: string;
  contentHtml: string;
  arweaveUrl?: string;
}

export interface JournalDay {
  date: string;
  entries: JournalEntry[];
}

function proxyUrl(gateway: string): string {
  return gateway.replace("https://gateway.irys.xyz/", "/arweave/");
}

async function loadArweaveIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  try {
    const raw = cachedReadFileSync("state/arweave_log.json");
    const log = JSON.parse(raw) as { uploads: Array<{ file: string; gateway: string; type: string }> };
    for (const entry of log.uploads ?? []) {
      if (entry.type === "journal" && entry.file && entry.gateway) {
        index.set(path.basename(entry.file), proxyUrl(entry.gateway));
      }
    }
  } catch { /* arweave_log not present yet */ }
  return index;
}

function parseSlug(filename: string): { date: string; hour: number } | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})\.html$/);
  if (!m) return null;
  return { date: m[1], hour: parseInt(m[2], 10) };
}

function extractBody(html: string): { body: string; title: string } {
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = (articleMatch?.[1] ?? bodyMatch?.[1] ?? html).trim();

  const firstPMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const rawText = (firstPMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const sentence = rawText.split(/(?<=[.!?])\s+/)[0] ?? rawText;
  const title = sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;

  return { body, title };
}

const AGENT_START_DATE = "2026-02-23";

function computeDay(date: string): number {
  const ms = new Date(date).getTime() - new Date(AGENT_START_DATE).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

export async function getAllJournalDays(): Promise<JournalDay[]> {
  try {
    const files = cachedReaddirSync("journals").filter(f => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f)).sort();
    const arweave = await loadArweaveIndex();

    const byDate = new Map<string, JournalEntry[]>();

    for (const filename of files) {
        const parsed = parseSlug(filename);
        if (!parsed) continue;

        const raw = cachedReadFileSync(`journals/${filename}`);
        const { body, title } = extractBody(raw);

        const entry: JournalEntry = {
          date: parsed.date,
          hour: parsed.hour,
          day: computeDay(parsed.date),
          slug: `${parsed.date}_${String(parsed.hour).padStart(2, "0")}`,
          title,
          contentHtml: body,
          arweaveUrl: arweave.get(filename),
        };

        if (!byDate.has(parsed.date)) byDate.set(parsed.date, []);
        byDate.get(parsed.date)!.push(entry);
      }

    return Array.from(byDate.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, entries]) => ({
        date,
        entries: entries.sort((a, b) => b.hour - a.hour),
      }));
  } catch (err) {
    console.error("[getAllJournalDays] failed:", err);
    return [];
  }
}

export async function getJournalEntry(date: string, hour: number): Promise<JournalEntry | null> {
  const filename = `${date}_${String(hour).padStart(2, "0")}.html`;
  let raw: string;
  try { raw = cachedReadFileSync(`journals/${filename}`); } catch { return null; }

  const arweave = await loadArweaveIndex();

  const { body, title } = extractBody(raw);

  return {
    date,
    hour,
    day: computeDay(date),
    slug: `${date}_${String(hour).padStart(2, "0")}`,
    title,
    contentHtml: body,
    arweaveUrl: arweave.get(filename),
  };
}
