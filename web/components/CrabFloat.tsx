"use client";
import { useEffect, useRef } from "react";

const CRAB_W   = 96;          // rendered px
const SPEED    = 1.4;         // px per frame (~60 fps → ~24 s to cross 1920px)
const STEP_GAP = 38;          // px of travel between footprint drops

// Four-dot toe cluster offsets around a center point
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

    // ── State (all via ref, never triggers re-render) ────────────────
    let dir:     1 | -1 = Math.random() > 0.5 ? 1 : -1;
    let x  = dir === 1 ? -CRAB_W : W() + CRAB_W;
    let y  = H() * (0.2 + Math.random() * 0.58);
    let lastPrintX = x;
    let stepSide   = 0;  // 0 = left feet, 1 = right feet (alternates)

    // ── Footprint helper ─────────────────────────────────────────────
    function dropPrint(cx: number, cy: number, side: 0 | 1) {
      // Mirror dot pattern when facing left
      const dots = side === 0
        ? (dir === 1 ? TOE_L : TOE_R)
        : (dir === 1 ? TOE_R : TOE_L);

      dots.forEach(([dx, dy]) => {
        const el = document.createElement("div");
        el.className = "crab-print-dot";
        el.style.left = `${cx + dx}px`;
        el.style.top  = `${cy + dy}px`;
        wrap!.appendChild(el);
        // remove node after animation finishes
        setTimeout(() => el.remove(), 4200);
      });
    }

    // ── Animation loop ───────────────────────────────────────────────
    let raf: number;

    function tick() {
      x += dir * SPEED;

      // Apply position + horizontal flip
      svg!.style.transform = dir === 1
        ? `translate(${x}px, ${y}px)`
        : `translate(${x + CRAB_W}px, ${y}px) scaleX(-1)`;

      // Drop footprints every STEP_GAP px
      if (Math.abs(x - lastPrintX) >= STEP_GAP) {
        lastPrintX = x;
        stepSide ^= 1;

        // Foot cluster is slightly behind the crab (where it just stepped)
        const behindX = x - dir * STEP_GAP * 0.5;
        const footY   = y + CRAB_W * 0.88;

        // Left-pair foot ≈ 25 % of width, right-pair ≈ 75 %
        const leftFoot  = behindX + CRAB_W * 0.25;
        const rightFoot = behindX + CRAB_W * 0.75;

        dropPrint(stepSide === 0 ? leftFoot : rightFoot, footY, stepSide as 0 | 1);
      }

      // Off-screen → new pass at fresh random Y
      if (dir === 1 && x > W() + CRAB_W) {
        dir = -1;
        x   = W() + CRAB_W;
        y   = H() * (0.15 + Math.random() * 0.65);
        lastPrintX = x;
      } else if (dir === -1 && x < -CRAB_W * 2) {
        dir = 1;
        x   = -CRAB_W;
        y   = H() * (0.15 + Math.random() * 0.65);
        lastPrintX = x;
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── SVG colours ──────────────────────────────────────────────────
  const CB = "#e05c2b", CL = "#f07038", EW = "#f0ece8", PU = "#1a0a00";
  const HM = "#8b6b1a", HB = "#2d5216", HR = "#6a4e10";
  const FT = "#d4b84a", FP = "#b89830";

  return (
    <div ref={wrapRef} className="crab-float-wrap" aria-hidden="true">
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        className="crab-float"
        viewBox="0 0 256 256"
        shapeRendering="crispEdges"
      >
        {/* ── HUNTER HAT ── */}
        <rect x="208" y="0"  width="16"  height="16" fill={FP} />
        <rect x="48"  y="16" width="160" height="32" fill={HM} />
        <rect x="208" y="16" width="16"  height="32" fill={FT} />
        <rect x="48"  y="48" width="160" height="16" fill={HB} />
        <rect x="16"  y="64" width="224" height="16" fill={HR} />

        {/* ── CARAPACE ── */}
        <rect x="80"  y="80"  width="96"  height="16" fill={CB} />
        <rect x="64"  y="96"  width="128" height="16" fill={CB} />
        <rect x="48"  y="112" width="160" height="16" fill={CB} />

        {/* Row 8 — eyes + upper pincers */}
        <rect x="0"   y="128" width="32"  height="16" fill={CL} />
        <rect x="32"  y="128" width="48"  height="16" fill={CB} />
        <rect x="80"  y="128" width="16"  height="16" fill={EW} />
        <rect x="96"  y="128" width="48"  height="16" fill={CB} />
        <rect x="144" y="128" width="16"  height="16" fill={EW} />
        <rect x="160" y="128" width="64"  height="16" fill={CB} />
        <rect x="224" y="128" width="32"  height="16" fill={CL} />
        <rect x="86"  y="134" width="4"   height="4"  fill={PU} />
        <rect x="150" y="134" width="4"   height="4"  fill={PU} />

        {/* Row 9 — pincer gap */}
        <rect x="0"   y="144" width="16"  height="16" fill={CL} />
        <rect x="32"  y="144" width="192" height="16" fill={CB} />
        <rect x="240" y="144" width="16"  height="16" fill={CL} />

        {/* Rows 10-12 — lower body */}
        <rect x="32"  y="160" width="192" height="16" fill={CB} />
        <rect x="32"  y="176" width="192" height="16" fill={CB} />
        <rect x="48"  y="192" width="160" height="16" fill={CB} />

        {/* ── ANIMATED PINCERS ── */}
        <g className="crab-pincer-l">
          <rect x="0"   y="160" width="32" height="16" fill={CL} />
        </g>
        <g className="crab-pincer-r">
          <rect x="224" y="160" width="32" height="16" fill={CL} />
        </g>

        {/* ── ANIMATED LEGS — left pair ── */}
        <g className="crab-legs-l">
          <rect x="48" y="208" width="16" height="16" fill={CB} />
          <rect x="80" y="208" width="16" height="16" fill={CB} />
          <rect x="48" y="224" width="16" height="16" fill={CB} />
          <rect x="80" y="224" width="16" height="16" fill={CB} />
          <rect x="64" y="240" width="16" height="16" fill={CB} />
          <rect x="96" y="240" width="16" height="16" fill={CB} />
        </g>

        {/* ── ANIMATED LEGS — right pair ── */}
        <g className="crab-legs-r">
          <rect x="160" y="208" width="16" height="16" fill={CB} />
          <rect x="192" y="208" width="16" height="16" fill={CB} />
          <rect x="160" y="224" width="16" height="16" fill={CB} />
          <rect x="192" y="224" width="16" height="16" fill={CB} />
          <rect x="144" y="240" width="16" height="16" fill={CB} />
          <rect x="176" y="240" width="16" height="16" fill={CB} />
        </g>
      </svg>
    </div>
  );
}
