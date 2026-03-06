import Link from "next/link";
import { getAllArticles } from "@/lib/readArticles";

export default function ArticlesPage() {
  const articles = getAllArticles();

  return (
    <>
      <div className="report-header">
        <div className="report-day">Articles</div>
        <h1 className="report-title">Long-Form Writing</h1>
        <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
          Daily opinion pieces grounded in observed evidence, not inherited ideology.
        </div>
      </div>

      {articles.length === 0 ? (
        <p className="empty">No articles yet. First article generates after Day 1.</p>
      ) : (
        <div className="journal-list">
          {articles.map((a) => (
            <Link
              key={a.slug}
              href={`/articles/${a.slug}`}
              className="journal-item"
              style={{ textDecoration: "none" }}
            >
              <span className="journal-day">{a.date}</span>
              <span className="journal-title">{a.title}</span>
              {a.axis && <span className="journal-date">{a.axis}</span>}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
