"use client";
import { useEffect, useRef } from "react";

const WALKER_W = 96;
const SPEED    = 1.4;
const STEP_GAP = 38;

const TOE_L: [number, number][] = [[-9, 0], [-4, 3], [ 1,-2], [ 5, 2]];
const TOE_R: [number, number][] = [[-5, 2], [ 0,-2], [ 4, 3], [ 9, 0]];

export default function CrabFloat() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef  = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const img  = imgRef.current;
    if (!wrap || !img) return;

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

      img!.style.transform = dir === 1
        ? `translate(${x}px, ${y}px)`
        : `translate(${x + WALKER_W}px, ${y}px) scaleX(-1)`;

      if (Math.abs(x - lastPrintX) >= STEP_GAP) {
        lastPrintX = x;
        stepSide ^= 1;

        const behindX   = x - dir * STEP_GAP * 0.5;
        const footY     = y + WALKER_W * 0.88;
        const leftFoot  = behindX + WALKER_W * 0.25;
        const rightFoot = behindX + WALKER_W * 0.75;

        dropPrint(stepSide === 0 ? leftFoot : rightFoot, footY, stepSide as 0 | 1);
      }

      if (dir === 1 && x > W() + WALKER_W) {
        dir = -1;
        x   = W() + WALKER_W;
        y   = H() * (0.15 + Math.random() * 0.65);
        lastPrintX = x;
      } else if (dir === -1 && x < -WALKER_W * 2) {
        dir = 1;
        x   = -WALKER_W;
        y   = H() * (0.15 + Math.random() * 0.65);
        lastPrintX = x;
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={wrapRef} className="crab-float-wrap" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src="/walker.png"
        alt=""
        className="crab-float"
        width={96}
        height={96}
      />
    </div>
  );
}
