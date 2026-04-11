import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import { gcsListFiles, gcsReadFile, gcsFileExists } from "./gcs";

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
    const raw = await gcsReadFile("state/arweave_log.json");
    const log = JSON.parse(raw);
    for (const entry of (log.uploads ?? [])) {
      if (entry.type === "article" && entry.date && entry.gateway) {
        index.set(entry.date, proxyUrl(entry.gateway));
      }
    }
  } catch { /* no log yet */ }
  return index;
}

async function getImageUrl(slug: string): Promise<string | undefined> {
  const exists = await gcsFileExists(`articles/images/${slug}.png`);
  return exists ? `/images/articles/${slug}.png` : undefined;
}

export async function getAllArticles(): Promise<Article[]> {
  const [files, arweave] = await Promise.all([
    gcsListFiles("articles", /^\d{4}-\d{2}-\d{2}[^/]*\.md$/),
    buildArweaveIndex(),
  ]);

  return Promise.all(
    files
      .sort()
      .reverse()
      .map(async (filename) => {
        const slug = filename.replace(/\.md$/, "");
        const raw = await gcsReadFile(`articles/${filename}`);
        const { data, content } = matter(raw);
        const date = coerceDate(data.date, slug);
        const imageUrl = await getImageUrl(slug);
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
      }),
  );
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const exists = await gcsFileExists(`articles/${slug}.md`);
  if (!exists) return null;

  const [raw, arweave] = await Promise.all([
    gcsReadFile(`articles/${slug}.md`),
    buildArweaveIndex(),
  ]);

  const { data, content } = matter(raw);
  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  const date = coerceDate(data.date, slug);
  const imageUrl = await getImageUrl(slug);

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
