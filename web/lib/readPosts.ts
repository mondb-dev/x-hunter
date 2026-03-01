import fs from "fs";
import path from "path";

export interface PostLogEntry {
  id: string | null;
  date: string;
  cycle: number;
  type: string;
  content: string;
  tweet_url?: string;
  source_url?: string;
  journal_url?: string;
  posted_at: string;
}

interface PostsLog {
  total_posts?: number;
  posts: PostLogEntry[];
}

export function readPostsLog(): PostLogEntry[] {
  const filePath = path.resolve(process.cwd(), "../state/posts_log.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as PostsLog | PostLogEntry[];
  return Array.isArray(data) ? data : (data.posts ?? []);
}

export function getLatestPost(): PostLogEntry | null {
  const posts = readPostsLog();
  const xPosts = posts.filter(p => p.type === "quote" || p.type === "tweet");
  return xPosts.length > 0 ? xPosts[xPosts.length - 1] : null;
}
