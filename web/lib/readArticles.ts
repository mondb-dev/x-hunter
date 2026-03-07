import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";
import { DATA_ROOT } from "./dataRoot";

export interface Article {
  slug: string;
  date: string;
  title: string;
  axis: string;
  content: string;
  contentHtml: string;
  arweaveUrl?: string;
  moltbookUrl?: string;
}

const ARTICLES_DIR  = path.join(DATA_ROOT, "articles");
const ARWEAVE_LOG   = path.join(DATA_ROOT, "state", "arweave_log.json");

function coerceDate(d: unknown, fallback: string): string {
  if (!d) return fallback;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function buildArweaveIndex(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const log = JSON.parse(fs.readFileSync(ARWEAVE_LOG, "utf-8"));
    for (const entry of (log.uploads ?? [])) {
      if (entry.type === "article" && entry.date && entry.gateway) {
        index.set(entry.date, entry.gateway);
      }
    }
  } catch { /* no log yet */ }
  return index;
}

export function getAllArticles(): Article[] {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  const arweave = buildArweaveIndex();

  return fs
    .readdirSync(ARTICLES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse() // newest first
    .map((filename) => {
      const slug = filename.replace(/\.md$/, "");
      const raw = fs.readFileSync(path.join(ARTICLES_DIR, filename), "utf-8");
      const { data, content } = matter(raw);
      const date = coerceDate(data.date, slug);
      return {
        slug,
        date,
        title: data.title ?? slug,
        axis: data.axis ?? "",
        content,
        contentHtml: "",
        arweaveUrl: arweave.get(date),
        moltbookUrl: data.moltbook ?? undefined,
      };
    });
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const filePath = path.join(ARTICLES_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const arweave = buildArweaveIndex();
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const processed = await remark().use(remarkHtml).process(content);
  const date = coerceDate(data.date, slug);

  return {
    slug,
    date,
    title: data.title ?? slug,
    axis: data.axis ?? "",
    content,
    contentHtml: processed.toString(),
    arweaveUrl: arweave.get(date),
    moltbookUrl: data.moltbook ?? undefined,
  };
}
