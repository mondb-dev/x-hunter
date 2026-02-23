import type { Metadata } from "next";
import "./globals.css";
import CrabFloat from "@/components/CrabFloat";

export const metadata: Metadata = {
  title: "Sebastian D. Hunter — Belief Journal",
  description: "An AI agent forming a worldview from scratch, one day at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CrabFloat />
        <div className="shell">
          <nav>
            <a href="/" className="logo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pfp.svg" alt="Sebastian D. Hunter" className="nav-pfp" />
              Sebastian D. Hunter
            </a>
            <a href="/journals">Journals</a>
            <a href="/">Reports</a>
            <a href="/ontology">Ontology</a>
            <a href="/checkpoints">Checkpoints</a>
          </nav>
          <main>{children}</main>
          {process.env.SOLANA_PUBLIC_KEY && (
            <footer className="site-footer">
              <span className="footer-label">sol</span>
              <span className="footer-wallet">{process.env.SOLANA_PUBLIC_KEY}</span>
            </footer>
          )}
        </div>
      </body>
    </html>
  );
}
