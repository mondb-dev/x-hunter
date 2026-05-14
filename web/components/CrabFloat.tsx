"use client";
import { useEffect, useRef } from "react";

const WALKER_W = 96;
const SPEED    = 1.4;
const STEP_GAP = 38;

const TOE_L: [number, number][] = [[-9, 0], [-4, 3], [ 1,-2], [ 5, 2]];
const TOE_R: [number, number][] = [[-5, 2], [ 0,-2], [ 4, 3], [ 9, 0]];

export default function CrabFloat() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef  = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const svg  = svgRef.current;
    if (!wrap || !svg) return;

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;

    let dir:     1 | -1 = Math.random() > 0.5 ? 1 : -1;
    let x  = dir === 1 ? -WALKER_W : W() + WALKER_W;
    let y  = H() * (0.2 + Math.random() * 0.58);
    let lastPrintX = x;
    let stepSide   = 0;

    function dropPrint(cx: number, cy: number, side: 0 | 1) {
      const dots = side === 0
        ? (dir === 1 ? TOE_L : TOE_R)
        : (dir === 1 ? TOE_R : TOE_L);
      dots.forEach(([dx, dy]) => {
        const el = document.createElement("div");
        el.className = "crab-print-dot";
        el.style.left = `${cx + dx}px`;
        el.style.top  = `${cy + dy}px`;
        wrap!.appendChild(el);
        setTimeout(() => el.remove(), 4200);
      });
    }

    let raf: number;
    function tick() {
      x += dir * SPEED;

      svg!.style.transform = dir === 1
        ? `translate(${x}px, ${y}px)`
        : `translate(${x + WALKER_W}px, ${y}px) scaleX(-1)`;

      if (Math.abs(x - lastPrintX) >= STEP_GAP) {
        lastPrintX = x;
        stepSide ^= 1;
        const behindX   = x - dir * STEP_GAP * 0.5;
        const footY     = y + WALKER_W * 0.9;
        const leftFoot  = behindX + WALKER_W * 0.3;
        const rightFoot = behindX + WALKER_W * 0.6;
        dropPrint(stepSide === 0 ? leftFoot : rightFoot, footY, stepSide as 0 | 1);
      }

      if (dir === 1 && x > W() + WALKER_W) {
        dir = -1; x = W() + WALKER_W;
        y = H() * (0.15 + Math.random() * 0.65); lastPrintX = x;
      } else if (dir === -1 && x < -WALKER_W * 2) {
        dir = 1; x = -WALKER_W;
        y = H() * (0.15 + Math.random() * 0.65); lastPrintX = x;
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Palette ──────────────────────────────────────────────────────
  const RB = "#7090b0"; // robot body
  const RD = "#485868"; // robot dark
  const VI = "#d4a830"; // visor amber
  const VD = "#a07820"; // visor dark
  const CT = "#8b7355"; // coat tan
  const CD = "#5a4830"; // coat dark
  const HM = "#8b6b1a"; // hat mid
  const HB = "#2d1a08"; // hat band
  const HR = "#6a5010"; // hat brim
  const FT = "#c8a030"; // feather

  return (
    <div ref={wrapRef} className="crab-float-wrap" aria-hidden="true">
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        className="crab-float"
        viewBox="0 0 256 256"
        shapeRendering="crispEdges"
      >
        {/* ── HAT ── */}
        <rect x="144" y="0"  width="16" height="48" fill={FT} />  {/* feather */}
        <rect x="80"  y="16" width="96" height="48" fill={HM} />  {/* crown */}
        <rect x="80"  y="64" width="96" height="16" fill={HB} />  {/* band */}
        <rect x="32"  y="80" width="160" height="16" fill={HR} /> {/* brim */}

        {/* ── HEAD (dome, side-facing right) ── */}
        <rect x="96"  y="96"  width="96" height="16" fill={RB} />
        <rect x="80"  y="112" width="128" height="16" fill={RB} />
        <rect x="80"  y="128" width="128" height="16" fill={RB} />
        <rect x="96"  y="144" width="80"  height="16" fill={RB} />
        {/* visor — right side of head */}
        <rect x="176" y="112" width="48" height="32" fill={VI} />
        <rect x="184" y="120" width="24" height="16" fill={VD} />

        {/* ── NECK / COLLAR ── */}
        <rect x="112" y="160" width="48" height="16" fill={RD} />

        {/* ── TRENCH COAT ── */}
        <rect x="80"  y="176" width="112" height="16" fill={CT} /> {/* shoulders */}
        <rect x="80"  y="192" width="112" height="16" fill={CT} />
        <rect x="64"  y="208" width="112" height="16" fill={CT} /> {/* widens */}
        <rect x="64"  y="224" width="96"  height="16" fill={CD} /> {/* hem */}

        {/* ── ANIMATED LEGS ── */}
        <g className="walker-leg-f">
          <rect x="112" y="240" width="32" height="16" fill={RD} />
        </g>
        <g className="walker-leg-b">
          <rect x="80"  y="240" width="32" height="16" fill={RD} />
        </g>
      </svg>
    </div>
  );
}
