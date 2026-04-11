import matter from "gray-matter";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkHtml from "remark-html";
import { gcsListFiles, gcsReadFile, gcsFileExists } from "./gcs";

export interface Checkpoint {
  n: number;
  date: string;
  title: string;
  content: string;
  contentHtml: string;
}

export async function getAllCheckpoints(): Promise<Checkpoint[]> {
  const files = await gcsListFiles("checkpoints", /^checkpoint_\d+\.md$/);

  return Promise.all(
    files
      .sort((a, b) => {
        const nA = parseInt(a.match(/\d+/)![0]);
        const nB = parseInt(b.match(/\d+/)![0]);
        return nA - nB;
      })
      .map(async (filename) => {
        const n = parseInt(filename.match(/\d+/)![0]);
        const raw = await gcsReadFile(`checkpoints/${filename}`);
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
    const exists = await gcsFileExists("checkpoints/latest.md");
    if (!exists) return null;

    const raw = await gcsReadFile("checkpoints/latest.md");
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
