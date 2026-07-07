import MapBlock from './MapBlock';

/**
 * Report block REGISTRY — the decoupled viz layer. Maps a block `type` to a
 * component. Add a new visualization by writing a component and registering it
 * here; the publish tool (runner/publish_report.js) and renderer stay untouched.
 * v1 charts are dependency-free SVG; the map is real (Leaflet via CDN).
 */

const PALETTE = ['#6ea8fe', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];

// ── text / structured blocks (server-rendered) ───────────────────────────────
function Heading({ block }: any) { return <h2 className="report-h">{block.text}</h2>; }
function Paragraph({ block }: any) { return <p className="report-p">{block.text}</p>; }
function Markdown({ block }: any) {
  const paras = String(block.md || '').split(/\n{2,}/);
  return <div className="report-md">{paras.map((p: string, i: number) => <p key={i}>{p.split('\n').map((l, j) => <span key={j}>{l}<br /></span>)}</p>)}</div>;
}
function Callout({ block }: any) {
  const tone = ['ok', 'warn', 'danger', 'info'].includes(block.tone) ? block.tone : 'info';
  return <div className={`report-callout report-callout--${tone}`}>{block.title ? <strong>{block.title} </strong> : null}{block.text}</div>;
}
function KeyValue({ block }: any) {
  const items = Array.isArray(block.items) ? block.items : [];
  return <dl className="report-kv">{items.map((it: any, i: number) => <div key={i} className="report-kv-row"><dt>{it.k}</dt><dd>{String(it.v)}</dd></div>)}</dl>;
}
function Table({ block }: any) {
  const cols = block.columns || [];
  const rows = block.rows || [];
  return (
    <div className="report-table-wrap"><table className="report-table">
      <thead><tr>{cols.map((c: string, i: number) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((r: any[], i: number) => <tr key={i}>{r.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
function Sources({ block }: any) {
  const items = Array.isArray(block.items) ? block.items : [];
  return <ul className="report-sources">{items.map((s: any, i: number) => <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>)}</ul>;
}
function Embed({ block }: any) {
  return <div className="report-embed"><iframe src={block.url} title={block.title || 'embed'} loading="lazy" style={{ width: '100%', height: block.height || 420, border: 0, borderRadius: 10 }} /></div>;
}

// ── SVG charts (dependency-free) ──────────────────────────────────────────────
function BarChart({ block }: any) {
  const data = (block.data || []).slice(0, 24);
  const max = Math.max(1, ...data.map((d: any) => Math.abs(+d.value || 0)));
  return (
    <figure className="report-block report-viz">
      {block.title ? <figcaption className="report-viz-title">{block.title}</figcaption> : null}
      <div className="report-bars">
        {data.map((d: any, i: number) => (
          <div key={i} className="report-bar-row">
            <span className="report-bar-label">{d.label}</span>
            <span className="report-bar-track"><span className="report-bar-fill" style={{ width: `${(Math.abs(+d.value || 0) / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></span>
            <span className="report-bar-val">{d.value}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}
function LineChart({ block }: any) {
  const data = (block.data || []).map((d: any, i: number) => ({ x: d.x ?? i, y: +d.y || 0 }));
  const W = 640, H = 220, P = 28;
  if (data.length < 2) return <BarChart block={{ title: block.title, data: data.map((d: any) => ({ label: String(d.x), value: d.y })) }} />;
  const xs = data.map((d: any) => d.x), ys = data.map((d: any) => d.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys), rangeY = maxY - minY || 1;
  const sx = (x: number) => P + ((x - Math.min(...xs)) / ((Math.max(...xs) - Math.min(...xs)) || 1)) * (W - 2 * P);
  const sy = (y: number) => H - P - ((y - minY) / rangeY) * (H - 2 * P);
  const pts = data.map((d: any) => `${sx(d.x).toFixed(1)},${sy(d.y).toFixed(1)}`).join(' ');
  return (
    <figure className="report-block report-viz">
      {block.title ? <figcaption className="report-viz-title">{block.title}</figcaption> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="report-svg" role="img">
        <polyline points={pts} fill="none" stroke={PALETTE[0]} strokeWidth={2} />
        {data.map((d: any, i: number) => <circle key={i} cx={sx(d.x)} cy={sy(d.y)} r={2.5} fill={PALETTE[0]} />)}
      </svg>
    </figure>
  );
}
function PieChart({ block }: any) {
  const data = (block.data || []).slice(0, 12).map((d: any) => ({ name: d.name, value: Math.max(0, +d.value || 0) }));
  const total = data.reduce((s: number, d: any) => s + d.value, 0) || 1;
  let a0 = -Math.PI / 2;
  const R = 90, C = 100;
  const arcs = data.map((d: any, i: number) => {
    const a1 = a0 + (d.value / total) * 2 * Math.PI;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = `M${C},${C} L${C + R * Math.cos(a0)},${C + R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${C + R * Math.cos(a1)},${C + R * Math.sin(a1)} Z`;
    a0 = a1;
    return <path key={i} d={p} fill={PALETTE[i % PALETTE.length]} />;
  });
  return (
    <figure className="report-block report-viz report-pie">
      {block.title ? <figcaption className="report-viz-title">{block.title}</figcaption> : null}
      <div className="report-pie-wrap">
        <svg viewBox="0 0 200 200" className="report-svg-pie" role="img">{arcs}</svg>
        <ul className="report-legend">{data.map((d: any, i: number) => <li key={i}><span style={{ background: PALETTE[i % PALETTE.length] }} />{d.name} · {((d.value / total) * 100).toFixed(1)}%</li>)}</ul>
      </div>
    </figure>
  );
}

export const REGISTRY: Record<string, (p: { block: any }) => any> = {
  heading: Heading, paragraph: Paragraph, markdown: Markdown, callout: Callout,
  keyvalue: KeyValue, table: Table, sources: Sources, embed: Embed,
  bar_chart: BarChart, line_chart: LineChart, pie_chart: PieChart,
  map: ({ block }: any) => <MapBlock {...block} />,
};

export function ReportBlocks({ blocks }: { blocks: any[] }) {
  return (
    <div className="report-blocks">
      {(blocks || []).map((b, i) => {
        const C = REGISTRY[b?.type];
        return C ? <C key={i} block={b} /> : null;
      })}
    </div>
  );
}
