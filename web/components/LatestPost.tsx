import { getLatestPost } from "@/lib/readPosts";

export default function LatestPost() {
  try {
    const post = getLatestPost();

    if (!post) {
      return (
        <div className="latest-post-wrap">
          <div className="latest-post-label">latest post</div>
          <div className="latest-post-empty">
            Nothing posted yet.{" "}
            <a href="https://x.com/sebastianhunts" target="_blank" rel="noopener noreferrer">
              Follow on X →
            </a>
          </div>
        </div>
      );
    }

    const ts = new Date(post.posted_at || Date.now());
    const validDate = !isNaN(ts.getTime());
    const dateStr = validDate
      ? ts.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";
    const timeStr = validDate
      ? ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "";

    // posts_log entries use either "content" or "text" depending on how they were written
    const postAny = post as unknown as Record<string, unknown>;
    const content = (postAny.content as string) ?? (postAny.text as string) ?? "";

    return (
      <div className="latest-post-wrap">
        <div className="latest-post-label">
          latest post
          <span className="latest-post-type">{post.type}</span>
        </div>
        <div className="latest-post-card">
          <p className="latest-post-content">{content}</p>
          <div className="latest-post-footer">
            <span className="latest-post-time">{dateStr}{timeStr ? ` · ${timeStr}` : ""}</span>
            <div className="latest-post-links">
              {post.journal_url && (
                <a href={post.journal_url} className="latest-post-link">
                  journal →
                </a>
              )}
              {post.source_url && post.type === "quote" && (
                <a
                  href={post.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="latest-post-link"
                >
                  source tweet →
                </a>
              )}
              <a
                href="https://x.com/sebastianhunts"
                target="_blank"
                rel="noopener noreferrer"
                className="latest-post-link"
              >
                @sebastianhunts →
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    console.error("[LatestPost] render failed:", err);
    return null;
  }
}
