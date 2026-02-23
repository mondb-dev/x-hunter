import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";

export interface JournalEntry {
  date: string;   // YYYY-MM-DD
  hour: number;   // 0–23
  day: number;    // agent day number
  slug: string;   // YYYY-MM-DD_HH
  contentHtml: string; // sanitized body content
}

export interface JournalDay {
  date: string;
  entries: JournalEntry[];
}

const JOURNALS_DIR = path.resolve(process.cwd(), "data/journals");

function parseSlug(filename: string): { date: string; hour: number } | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})\.html$/);
  if (!m) return null;
  return { date: m[1], hour: parseInt(m[2], 10) };
}

function extractBody(html: string): { body: string; day: number } {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const day = parseInt(doc.querySelector("meta[name='x-hunter-day']")?.getAttribute("content") ?? "0", 10);
  const body = doc.querySelector("article")?.innerHTML ?? doc.body?.innerHTML ?? "";
  return { body, day };
}

export function getAllJournalDays(): JournalDay[] {
  if (!fs.existsSync(JOURNALS_DIR)) return [];

  const files = fs
    .readdirSync(JOURNALS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.html$/.test(f))
    .sort();

  const byDate = new Map<string, JournalEntry[]>();

  for (const filename of files) {
    const parsed = parseSlug(filename);
    if (!parsed) continue;

    const raw = fs.readFileSync(path.join(JOURNALS_DIR, filename), "utf-8");
    const { body, day } = extractBody(raw);

    const entry: JournalEntry = {
      date: parsed.date,
      hour: parsed.hour,
      day,
      slug: `${parsed.date}_${String(parsed.hour).padStart(2, "0")}`,
      contentHtml: body,
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
}

export function getJournalEntry(date: string, hour: number): JournalEntry | null {
  const filename = `${date}_${String(hour).padStart(2, "0")}.html`;
  const filePath = path.join(JOURNALS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { body, day } = extractBody(raw);

  return {
    date,
    hour,
    day,
    slug: `${date}_${String(hour).padStart(2, "0")}`,
    contentHtml: body,
  };
}
