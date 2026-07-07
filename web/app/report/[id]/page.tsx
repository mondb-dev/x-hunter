import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ReportBlocks } from '../../../components/report/registry';

const DIR = path.join(process.cwd(), 'public', 'data', 'reports');

function loadReport(id: string): any | null {
  try {
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  } catch { return null; }
}

export const dynamicParams = true;

export async function generateStaticParams() {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
    return (index || []).map((r: any) => ({ id: r.id }));
  } catch {
    try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => ({ id: f.replace(/\.json$/, '') })); } catch { return []; }
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const r = loadReport(id);
  if (!r) return { title: 'Report not found' };
  return { title: `${r.title} — Sebastian Hunter`, description: r.summary || undefined };
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = loadReport(id);
  if (!report) notFound();
  const when = (() => { try { return new Date(report.generated_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch { return ''; } })();
  return (
    <article className="report">
      <header className="report-head">
        <span className="report-kind">{report.kind || 'research'}</span>
        <h1 className="report-title">{report.title}</h1>
        {report.summary ? <p className="report-summary">{report.summary}</p> : null}
        <p className="report-meta">Sebastian D. Hunter · {when}{report.source ? ` · via ${report.source}` : ''}</p>
      </header>
      <ReportBlocks blocks={report.blocks} />
    </article>
  );
}
