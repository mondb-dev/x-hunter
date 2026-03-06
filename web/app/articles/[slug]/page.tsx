import { notFound } from "next/navigation";
import { getAllArticles, getArticleBySlug } from "@/lib/readArticles";

export async function generateStaticParams() {
  const articles = getAllArticles();
  return articles.map((a) => ({ slug: a.slug }));
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) notFound();

  return (
    <>
      <div className="report-header">
        <div className="report-day">{article.date}</div>
        <h1 className="report-title">{article.title}</h1>
        {article.axis && (
          <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "0.4rem" }}>
            Focus: {article.axis}
          </div>
        )}
      </div>

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: article.contentHtml }}
      />
    </>
  );
}
