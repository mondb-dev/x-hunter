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
}

const ARTICLES_DIR = path.join(DATA_ROOT, "articles");

export function getAllArticles(): Article[] {
  if (!fs.existsSync(ARTICLES_DIR)) return [];

  return fs
    .readdirSync(ARTICLES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse() // newest first
    .map((filename) => {
      const slug = filename.replace(/\.md$/, "");
      const raw = fs.readFileSync(path.join(ARTICLES_DIR, filename), "utf-8");
      const { data, content } = matter(raw);
      return {
        slug,
        date: data.date instanceof Date ? data.date.toISOString().slice(0, 10) : String(data.date ?? slug).slice(0, 10),
        title: data.title ?? slug,
        axis: data.axis ?? "",
        content,
        contentHtml: "",
      };
    });
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const filePath = path.join(ARTICLES_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);
  const processed = await remark().use(remarkHtml).process(content);

  return {
    slug,
    date: data.date ?? slug,
    title: data.title ?? slug,
    axis: data.axis ?? "",
    content,
    contentHtml: processed.toString(),
  };
}
