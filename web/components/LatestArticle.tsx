import Image from "next/image";
import Link from "next/link";
import { getAllArticles } from "@/lib/readArticles";

export default async function LatestArticle() {
  try {
    const articles = await getAllArticles();
    const article = articles[0] ?? null;

    if (!article) {
      return (
        <div className="latest-article-wrap">
          <div className="latest-article-label">latest article</div>
          <div className="latest-article-empty">No articles published yet.</div>
        </div>
      );
    }

    const dateObj = new Date(article.date);
    const dateStr = !isNaN(dateObj.getTime())
      ? dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : article.date;

    return (
      <div className="latest-article-wrap">
        <div className="latest-article-label">latest article</div>
        <Link href={`/articles/${article.slug}`} className="latest-article-card" style={{ textDecoration: "none" }}>
          {article.imageUrl && (
            <div className="latest-article-image-wrap">
              <Image
                src={article.imageUrl}
                alt={article.title}
                width={860}
                height={484}
                className="latest-article-image"
                priority
              />
            </div>
          )}
          <div className="latest-article-body">
            <p className="latest-article-title">{article.title}</p>
            {article.excerpt && (
              <p className="latest-article-excerpt">{article.excerpt}</p>
            )}
            <div className="latest-article-footer">
              <span className="latest-article-date">{dateStr}</span>
              {article.axis && (
                <span className="latest-article-axis">
                  {article.axis.replace(/_/g, " ").replace(/^axis /, "")}
                </span>
              )}
            </div>
          </div>
        </Link>
      </div>
    );
  } catch (err) {
    console.error("[LatestArticle] render failed:", err);
    return null;
  }
}
