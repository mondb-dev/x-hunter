import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { remark } from "remark";
import remarkHtml from "remark-html";

export interface Checkpoint {
  n: number;
  date: string;
  title: string;
  content: string;
  contentHtml: string;
}

const CHECKPOINTS_DIR = path.resolve(process.cwd(), "../checkpoints");

export function getAllCheckpoints(): Checkpoint[] {
  if (!fs.existsSync(CHECKPOINTS_DIR)) return [];

  return fs
    .readdirSync(CHECKPOINTS_DIR)
    .filter((f) => /^checkpoint_\d+\.md$/.test(f))
    .sort((a, b) => {
      const nA = parseInt(a.match(/\d+/)![0]);
      const nB = parseInt(b.match(/\d+/)![0]);
      return nA - nB;
    })
    .map((filename) => {
      const n = parseInt(filename.match(/\d+/)![0]);
      const raw = fs.readFileSync(path.join(CHECKPOINTS_DIR, filename), "utf-8");
      const { data, content } = matter(raw);
      return {
        n,
        date: data.date ?? "",
        title: data.title ?? `Checkpoint ${n} — Week ${n}`,
        content,
        contentHtml: "",
      };
    });
}

export async function getCheckpointByN(n: number): Promise<Checkpoint | null> {
  const all = getAllCheckpoints();
  const cp = all.find((c) => c.n === n);
  if (!cp) return null;
  const processed = await remark().use(remarkHtml).process(cp.content);
  return { ...cp, contentHtml: processed.toString() };
}

export async function getLatestCheckpoint(): Promise<Checkpoint | null> {
  const latestPath = path.join(CHECKPOINTS_DIR, "latest.md");
  if (!fs.existsSync(latestPath)) return null;

  const all = getAllCheckpoints();
  if (all.length === 0) return null;

  const latest = all[all.length - 1];
  const processed = await remark().use(remarkHtml).process(latest.content);
  return { ...latest, contentHtml: processed.toString() };
}
