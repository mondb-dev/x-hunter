import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "X Learner — Belief Journal",
  description: "An AI agent forming a worldview from scratch, one day at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav>
            <a href="/" className="logo">X Learner</a>
            <a href="/">Journal</a>
            <a href="/ontology">Ontology</a>
            <a href="/manifesto">Manifesto</a>
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
