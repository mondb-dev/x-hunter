import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import { cachedReadFileSync, cachedReaddirSync } from "./fileCache";

export interface Checkpoint {
  n: number;
  date: string;
  title: string;
  content: string;
  contentHtml: string;
}

export async function getAllCheckpoints(): Promise<Checkpoint[]> {
  const files = cachedReaddirSync("checkpoints").filter(f => /^checkpoint_\d+\.md$/.test(f));

  return Promise.all(
    files
      .sort((a, b) => {
        const nA = parseInt(a.match(/\d+/)![0]);
        const nB = parseInt(b.match(/\d+/)![0]);
        return nA - nB;
      })
      .map((filename) => {
        const n = parseInt(filename.match(/\d+/)![0]);
        const raw = cachedReadFileSync(`checkpoints/${filename}`);
        const { data, content } = matter(raw);
        return {
          n,
          date: (data.date ?? "") as string,
          title: (data.title ?? `Checkpoint ${n}`) as string,
          content,
          contentHtml: "",
        };
      }),
  );
}

export async function getCheckpointByN(n: number): Promise<Checkpoint | null> {
  const all = await getAllCheckpoints();
  const cp = all.find((c) => c.n === n);
  if (!cp) return null;
  const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(cp.content);
  return { ...cp, contentHtml: processed.toString() };
}

export async function getLatestCheckpoint(): Promise<Checkpoint | null> {
  try {
    let raw: string;
    try { raw = cachedReadFileSync("checkpoints/latest.md"); } catch { return null; }
    if (!raw.trim()) return null;
    const { data, content } = matter(raw);

    const all = await getAllCheckpoints();
    const n = all.length > 0 ? all[all.length - 1].n : 1;

    const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
    return {
      n,
      date: (data.date ?? "") as string,
      title: (data.title ?? `Checkpoint ${n}`) as string,
      content,
      contentHtml: processed.toString(),
    };
  } catch (err) {
    console.error("[getLatestCheckpoint] failed:", err);
    return null;
  }
}
