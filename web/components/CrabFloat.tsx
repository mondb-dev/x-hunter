"use client";
import { useEffect, useRef } from "react";

const SPEED    = 1.2;
const STEP_GAP = 48;   // px between each footprint
const PERP_OFF = 10;   // lateral offset between left/right feet

export default function CrabFloat() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;

    let dir: 1 | -1 = 1;
    let x  = -80;
    let y  = H() * (0.2 + Math.random() * 0.6);
    let lastPrintX = x;
    let stepSide   = 0;

    function line(x1: number, y1: number, x2: number, y2: number) {
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
      l.setAttribute("stroke", "#5a3a1a");
      l.setAttribute("stroke-width", "1.6");
      l.setAttribute("stroke-linecap", "round");
      return l;
    }

    function dropPrint(cx: number, cy: number, side: 0 | 1) {
      // Perpendicular (vertical) offset — feet walk side-by-side
      const py = cy + (side === 0 ? -PERP_OFF : PERP_OFF);

      // Chicken foot toes relative to heel at (0,0), pointing in travel direction
      // dir=1 → right:  fwd=+x, side toes fan ±y
      // dir=-1 → left:  fwd=-x, side toes fan ±y
      const fwd = dir === 1 ?  13 : -13;  // middle toe
      const sx  = dir === 1 ?   9 :  -9;  // side toe x
      const bk  = dir === 1 ?  -7 :   7;  // back spur

      const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.setAttribute("viewBox", "-14 -10 28 20");
      el.setAttribute("width", "28");
      el.setAttribute("height", "20");
      Object.assign(el.style, {
        position:  "absolute",
        left:      `${cx - 14}px`,
        top:       `${py - 10}px`,
        pointerEvents: "none",
        opacity:   "0.5",
        transition: "opacity 3.5s ease-out",
      });

      el.appendChild(line(0, 0, fwd, 0));    // middle toe (forward)
      el.appendChild(line(0, 0,  sx, -7));   // upper side toe
      el.appendChild(line(0, 0,  sx,  7));   // lower side toe
      el.appendChild(line(0, 0,  bk,  0));   // back spur

      wrap!.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "0"; });
      setTimeout(() => el.remove(), 4200);
    }

    let raf: number;
    function tick() {
      x += dir * SPEED;

      if (Math.abs(x - lastPrintX) >= STEP_GAP) {
        lastPrintX = x;
        stepSide ^= 1;
        dropPrint(x, y, stepSide as 0 | 1);
      }

      if (dir === 1 && x > W() + 80) {
        dir = -1; x = W() + 80;
        y = H() * (0.15 + Math.random() * 0.65); lastPrintX = x;
      } else if (dir === -1 && x < -80) {
        dir = 1; x = -80;
        y = H() * (0.15 + Math.random() * 0.65); lastPrintX = x;
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={wrapRef} className="crab-float-wrap" aria-hidden="true" />;
}
