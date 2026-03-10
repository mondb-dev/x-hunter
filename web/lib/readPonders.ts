import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";
import { DATA_ROOT } from "./dataRoot";

export interface Ponder {
  n: number;
  date: string;
  title: string;
  vocation: string;
  axesTriggered: string[];
  moltbook: string;
  content: string;
  contentHtml: string;
}

const PONDERS_DIR = path.join(DATA_ROOT, "ponders");

export function getAllPonders(): Ponder[] {
  if (!fs.existsSync(PONDERS_DIR)) return [];

  return fs
    .readdirSync(PONDERS_DIR)
    .filter((f) => /^ponder_\d+\.md$/.test(f))
    .sort((a, b) => {
      const nA = parseInt(a.match(/\d+/)![0]);
      const nB = parseInt(b.match(/\d+/)![0]);
      return nA - nB;
    })
    .map((filename) => {
      const n = parseInt(filename.match(/\d+/)![0]);
      const raw = fs.readFileSync(path.join(PONDERS_DIR, filename), "utf-8");
      const { data, content } = matter(raw);
      return {
        n,
        date: data.date ?? "",
        title: data.title ?? `Ponder ${n}`,
        vocation: data.vocation ?? "",
        axesTriggered: data.axes_triggered ?? [],
        moltbook: data.moltbook ?? "",
        content,
        contentHtml: "",
      };
    });
}

export async function getPonderByN(n: number): Promise<Ponder | null> {
  const all = getAllPonders();
  const p = all.find((x) => x.n === n);
  if (!p) return null;
  const processed = await remark().use(remarkHtml).process(p.content);
  return { ...p, contentHtml: processed.toString() };
}

export async function getLatestPonder(): Promise<Ponder | null> {
  try {
    const latestPath = path.join(PONDERS_DIR, "latest.md");
    if (!fs.existsSync(latestPath)) return null;
    const raw = fs.readFileSync(latestPath, "utf-8");
    if (!raw.trim()) return null;
    const { data, content } = matter(raw);
    const all = getAllPonders();
    const n = all.length > 0 ? all[all.length - 1].n : 1;
    const processed = await remark().use(remarkHtml).process(content);
    return {
      n,
      date: data.date ?? "",
      title: data.title ?? `Ponder ${n}`,
      vocation: data.vocation ?? "",
      axesTriggered: data.axes_triggered ?? [],
      moltbook: data.moltbook ?? "",
      content,
      contentHtml: processed.toString(),
    };
  } catch {
    return null;
  }
}
