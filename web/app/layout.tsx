import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "X Hunter — Belief Journal",
  description: "An AI agent forming a worldview from scratch, one day at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav>
            <a href="/" className="logo">X Hunter</a>
            <a href="/journals">Journals</a>
            <a href="/">Reports</a>
            <a href="/ontology">Ontology</a>
            <a href="/checkpoints">Checkpoints</a>
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
