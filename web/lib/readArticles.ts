import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
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

const ARTICLES_DIR  = path.join(DATA_ROOT, "articles");
const ARWEAVE_LOG   = path.join(DATA_ROOT, "state", "arweave_log.json");

function getImageUrl(slug: string): string | undefined {
  // Check GCS FUSE-mounted data directory (runtime path)
  const p = path.join(DATA_ROOT, "articles", "images", `${slug}.png`);
  return fs.existsSync(p) ? `/images/articles/${slug}.png` : undefined;
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

function buildArweaveIndex(): Map<string, string> {
  const index = new Map<string, string>();
  try {
    const log = JSON.parse(fs.readFileSync(ARWEAVE_LOG, "utf-8"));
    for (const entry of (log.uploads ?? [])) {
      if (entry.type === "article" && entry.date && entry.gateway) {
        index.set(entry.date, proxyUrl(entry.gateway));
      }
    }
  } catch { /* no log yet */ }
  return index;
}

function listArticleFiles(): string[] {
  // Prefer manifest.json (written by syncToGCS on the VM) to avoid GCS FUSE
  // directory-listing cache returning stale results after new files land.
  const manifestPath = path.join(ARTICLES_DIR, "manifest.json");
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(manifest.files)) {
        return manifest.files.filter((f: string) => /^\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(f));
      }
    }
  } catch { /* fall through */ }
  // Fallback: direct directory scan
  return fs.readdirSync(ARTICLES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(f))
    .sort()
    .reverse();
}

export function getAllArticles(): Article[] {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  const arweave = buildArweaveIndex();

  return listArticleFiles()
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
        excerpt: extractExcerpt(content),
        content,
        contentHtml: "",
        imageUrl: getImageUrl(slug),
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
  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  const date = coerceDate(data.date, slug);

  return {
    slug,
    date,
    title: data.title ?? slug,
    axis: data.axis ?? "",
    excerpt: extractExcerpt(content),
    content,
    contentHtml: processed.toString(),
    imageUrl: getImageUrl(slug),
    arweaveUrl: arweave.get(date),
    moltbookUrl: data.moltbook ?? undefined,
  };
}
