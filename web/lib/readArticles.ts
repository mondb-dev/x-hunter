import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import { cachedReadFileSync, cachedReaddirSync } from "./fileCache";
import { DATA_ROOT } from "./dataRoot";

export interface Article {
  slug: string;
  date: string;
  title: string;
  axis: string;
  excerpt: string;
  content: string;
  contentHtml: string;
  imageUrl?: string;
  arweaveUrl?: string;
  moltbookUrl?: string;
}

function extractExcerpt(content: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("*") || t.startsWith("-") || t.startsWith("|")) continue;
    return t.length > 220 ? t.slice(0, 220) + "…" : t;
  }
  return "";
}

function coerceDate(d: unknown, fallback: string): string {
  if (!d) return fallback;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function proxyUrl(gateway: string): string {
  return gateway.replace("https://gateway.irys.xyz/", "/arweave/");
}

async function buildArweaveIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  try {
    const raw = cachedReadFileSync("state/arweave_log.json");
    const log = JSON.parse(raw);
    for (const entry of (log.uploads ?? [])) {
      if (entry.type === "article" && entry.date && entry.gateway) {
        index.set(entry.date, proxyUrl(entry.gateway));
      }
    }
  } catch { /* no log yet */ }
  return index;
}

function getImageUrl(slug: string): string | undefined {
  return fs.existsSync(path.join(DATA_ROOT, `articles/images/${slug}.png`))
    ? `/images/articles/${slug}.png` : undefined;
}

export async function getAllArticles(): Promise<Article[]> {
  const files = cachedReaddirSync("articles").filter(f => /^\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(f));
  const arweave = await buildArweaveIndex();

  return files
    .sort()
    .reverse()
    .map((filename) => {
      const slug = filename.replace(/\.md$/, "");
      const raw = cachedReadFileSync(`articles/${filename}`);
      const { data, content } = matter(raw);
      const date = coerceDate(data.date, slug);
      const imageUrl = getImageUrl(slug);
      return {
        slug,
        date,
        title: (data.title ?? slug) as string,
        axis: (data.axis ?? "") as string,
        excerpt: extractExcerpt(content),
        content,
        contentHtml: "",
        imageUrl,
        arweaveUrl: arweave.get(date),
        moltbookUrl: (data.moltbook ?? undefined) as string | undefined,
      };
    });
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  let raw: string;
  try { raw = cachedReadFileSync(`articles/${slug}.md`); } catch { return null; }
  const arweave = await buildArweaveIndex();

  const { data, content } = matter(raw);
  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  const date = coerceDate(data.date, slug);
  const imageUrl = getImageUrl(slug);

  return {
    slug,
    date,
    title: (data.title ?? slug) as string,
    axis: (data.axis ?? "") as string,
    excerpt: extractExcerpt(content),
    content,
    contentHtml: processed.toString(),
    imageUrl,
    arweaveUrl: arweave.get(date),
    moltbookUrl: (data.moltbook ?? undefined) as string | undefined,
  };
}
