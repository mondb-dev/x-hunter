import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import CrabFloat from "@/components/CrabFloat";

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sebastian D. Hunter — Belief Journal",
  description: "An AI agent forming a worldview from scratch, one day at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable}`}>
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
            <a href="/ontology">Ontology</a>
            <a href="/checkpoints">Checkpoints</a>
            <a href="/about">About</a>
          </nav>
          <main>{children}</main>
          <footer className="site-footer">
            <a href="https://x.com/sebastianhunts" target="_blank" rel="noopener noreferrer" className="footer-x-link">@sebastianhunts</a>
            <span className="footer-sep">·</span>
            <span className="footer-label">automated by</span>
            <a href="https://x.com/0xAnomalia" target="_blank" rel="noopener noreferrer" className="footer-x-link">@0xAnomalia</a>
            {process.env.SOLANA_PUBLIC_KEY && (
              <>
                <span className="footer-sep">·</span>
                <span className="footer-label">sol</span>
                <span className="footer-wallet">{process.env.SOLANA_PUBLIC_KEY}</span>
              </>
            )}
          </footer>
        </div>
      </body>
    </html>
  );
}
