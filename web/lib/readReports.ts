import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";

export interface Report {
  slug: string;       // e.g. "2025-01-15"
  day: number;        // e.g. 1
  date: string;       // ISO date string
  title: string;
  content: string;    // raw markdown
  contentHtml: string;
}

const DAILY_DIR = path.resolve(process.cwd(), "../daily");

function parseDayFromFilename(filename: string): number {
  // Expect filenames like belief_report_YYYY-MM-DD.md
  // Day number is derived from sort order (1-indexed)
  return 0; // resolved at call site
}

export function getAllReports(): Report[] {
  if (!fs.existsSync(DAILY_DIR)) return [];

  const files = fs
    .readdirSync(DAILY_DIR)
    .filter((f) => f.startsWith("belief_report_") && f.endsWith(".md"))
    .sort(); // ascending by date

  return files.map((filename, index) => {
    const filePath = path.join(DAILY_DIR, filename);
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const slug = filename.replace("belief_report_", "").replace(".md", "");

    return {
      slug,
      day: index + 1,
      date: slug,
      title: data.title ?? `Day ${index + 1} — ${slug}`,
      content,
      contentHtml: "", // populated lazily
    };
  });
}

export async function getReportByDay(day: number): Promise<Report | null> {
  const all = getAllReports();
  const report = all.find((r) => r.day === day);
  if (!report) return null;

  const processed = await remark().use(remarkHtml).process(report.content);
  return { ...report, contentHtml: processed.toString() };
}

export async function getManifesto(): Promise<{ contentHtml: string } | null> {
  const manifestoPath = path.resolve(process.cwd(), "../manifesto.md");
  if (!fs.existsSync(manifestoPath)) return null;

  const raw = fs.readFileSync(manifestoPath, "utf-8");
  const { content } = matter(raw);
  const processed = await remark().use(remarkHtml).process(content);
  return { contentHtml: processed.toString() };
}
