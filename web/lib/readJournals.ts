import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

export interface JournalEntry {
  date: string;      // YYYY-MM-DD
  hour: number;      // 0–23
  day: number;       // agent day number
  slug: string;      // YYYY-MM-DD_HH
  title: string;     // first sentence of first paragraph (index preview)
  contentHtml: string; // body content
  arweaveUrl?: string; // permanent Arweave link, if uploaded
}

export interface JournalDay {
  date: string;
  entries: JournalEntry[];
}

const JOURNALS_DIR = path.join(DATA_ROOT, "journals");
const ARWEAVE_LOG  = path.join(DATA_ROOT, "state/arweave_log.json");

// Build a map of journal file path → Arweave gateway URL
function loadArweaveIndex(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const raw = fs.readFileSync(ARWEAVE_LOG, "utf-8");
    const log = JSON.parse(raw) as { uploads: Array<{ file: string; gateway: string; type: string }> };
    for (const entry of log.uploads ?? []) {
      if (entry.type === "journal" && entry.file && entry.gateway) {
        index.set(path.basename(entry.file), entry.gateway);
      }
    }
  } catch { /* arweave_log not present yet — that's fine */ }
  return index;
}

function parseSlug(filename: string): { date: string; hour: number } | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})\.html$/);
  if (!m) return null;
  return { date: m[1], hour: parseInt(m[2], 10) };
}

function extractBody(html: string): { body: string; title: string } {
  // Extract article or body content; journals are agent-generated so no sanitization needed
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = (articleMatch?.[1] ?? bodyMatch?.[1] ?? html).trim();

  // Pull first sentence of first paragraph as the index preview title
  const firstPMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const rawText = (firstPMatch?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const sentence = rawText.split(/(?<=[.!?])\s+/)[0] ?? rawText;
  const title = sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;

  return { body, title };
}

// Compute day number from date relative to the earliest journal date (Day 1 = first date)
function computeDay(date: string, earliestDate: string): number {
  const ms = new Date(date).getTime() - new Date(earliestDate).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

export function getAllJournalDays(): JournalDay[] {
  try {
    if (!fs.existsSync(JOURNALS_DIR)) return [];

    const arweave = loadArweaveIndex();

    const files = fs
      .readdirSync(JOURNALS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
      .sort();

    // Earliest date = first filename after sort (YYYY-MM-DD sorts lexicographically)
    const earliestDate = files.length > 0 ? parseSlug(files[0])?.date ?? "" : "";

    const byDate = new Map<string, JournalEntry[]>();

    for (const filename of files) {
      const parsed = parseSlug(filename);
      if (!parsed) continue;

      const raw = fs.readFileSync(path.join(JOURNALS_DIR, filename), "utf-8");
      const { body, title } = extractBody(raw);

      const entry: JournalEntry = {
        date: parsed.date,
        hour: parsed.hour,
        day: computeDay(parsed.date, earliestDate),
        slug: `${parsed.date}_${String(parsed.hour).padStart(2, "0")}`,
        title,
        contentHtml: body,
        arweaveUrl: arweave.get(filename),
      };

      if (!byDate.has(parsed.date)) byDate.set(parsed.date, []);
      byDate.get(parsed.date)!.push(entry);
    }

    return Array.from(byDate.entries())
      .sort(([a], [b]) => b.localeCompare(a)) // newest date first
      .map(([date, entries]) => ({
        date,
        entries: entries.sort((a, b) => b.hour - a.hour), // newest hour first
      }));
  } catch (err) {
    console.error("[getAllJournalDays] failed:", err);
    return [];
  }
}

export function getJournalEntry(date: string, hour: number): JournalEntry | null {
  const filename = `${date}_${String(hour).padStart(2, "0")}.html`;
  const filePath = path.join(JOURNALS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { body, title } = extractBody(raw);
  const arweaveUrl = loadArweaveIndex().get(filename);

  // Compute day from earliest journal date on disk
  const allFiles = fs.existsSync(JOURNALS_DIR)
    ? fs.readdirSync(JOURNALS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f)).sort()
    : [];
  const earliestDate = allFiles.length > 0 ? parseSlug(allFiles[0])?.date ?? date : date;

  return {
    date,
    hour,
    day: computeDay(date, earliestDate),
    slug: `${date}_${String(hour).padStart(2, "0")}`,
    title,
    contentHtml: body,
    arweaveUrl,
  };
}
