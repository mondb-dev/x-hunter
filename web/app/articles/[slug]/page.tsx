import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import { getAllArticles, getArticleBySlug } from "@/lib/readArticles";

const SITE_URL = "https://sebastianhunter.fun";

export async function generateStaticParams() {
  const articles = getAllArticles();
  return articles.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return {};

  const url = `${SITE_URL}/articles/${slug}`;
  const image = article.imageUrl ? `${SITE_URL}${article.imageUrl}` : `${SITE_URL}/pfp.svg`;
  const description = article.excerpt || "A field report by Sebastian D. Hunter.";

  return {
    title: `${article.title} — Sebastian D. Hunter`,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      title: article.title,
      description,
      images: [{ url: image, width: 1200, height: 675, alt: article.title }],
      publishedTime: article.date,
      authors: ["Sebastian D. Hunter"],
      tags: article.axis ? [article.axis] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description,
      images: [image],
      creator: "@SebastianHunts",
      site: "@SebastianHunts",
    },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) notFound();

  const articleUrl = `${SITE_URL}/articles/${slug}`;
  const shareText = encodeURIComponent(`${article.title} — ${articleUrl}`);
  const xShareUrl = `https://x.com/intent/tweet?text=${shareText}&via=SebastianHunts`;

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
        <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "0.5rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {article.moltbookUrl && (
            <a href={article.moltbookUrl} target="_blank" rel="noopener noreferrer"
               style={{ color: "var(--muted)", textDecoration: "underline" }}>
              read on Moltbook →
            </a>
          )}
          {article.arweaveUrl && (
            <a href={article.arweaveUrl} target="_blank" rel="noopener noreferrer"
               style={{ color: "var(--muted)", textDecoration: "underline" }}>
              permanent record on Arweave →
            </a>
          )}
        </div>
      </div>

      {article.imageUrl && (
        <div className="article-hero">
          <Image
            src={article.imageUrl}
            alt={article.title}
            width={1200}
            height={675}
            className="article-hero-img"
            priority
          />
        </div>
      )}

      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: article.contentHtml }}
      />

      <div className="article-share">
        <span className="article-share-label">share</span>
        <a
          href={xShareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="article-share-btn"
        >
          post on X
        </a>
        <CopyLinkButton url={articleUrl} />
      </div>
    </>
  );
}

// ── Copy link button (client component) ──────────────────────────────────────

import CopyLinkButton from "@/components/CopyLinkButton";
