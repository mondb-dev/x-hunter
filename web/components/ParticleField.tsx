"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Axis } from "@/lib/readOntology";

const PARTICLE_COUNT = 1800;
const FIELD_RADIUS = 6;

interface ParticleFieldProps {
  axes: Axis[];
  className?: string;
}

export default function ParticleField({ axes, className }: ParticleFieldProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    // ── Scene + Camera ────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 100);
    camera.position.set(0, 0, 10);

    // ── Geometry ──────────────────────────────────────────────────────────────
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = FIELD_RADIUS * Math.cbrt(Math.random());
      positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      velocities[i * 3 + 0] = (Math.random() - 0.5) * 0.01;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.01;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.01;
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);

    // ── Attractor nodes (one per axis) ────────────────────────────────────────
    const attractors = axes.map((axis, i) => {
      const angle = (i / Math.max(axes.length, 1)) * Math.PI * 2;
      return {
        x: Math.cos(angle) * 2.5,
        y: axis.score * 1.5,
        z: Math.sin(angle) * 2.5,
        confidence: axis.confidence,
      };
    });

    // ── Material — color shifts with avg confidence ────────────────────────────
    const avgConf = axes.length > 0
      ? axes.reduce((s, a) => s + a.confidence, 0) / axes.length
      : 0;

    const color = new THREE.Color(
      avgConf < 0.2 ? 0x3b82f6 :   // blue — early fog
      avgConf < 0.6 ? 0xf59e0b :   // amber — forming
                      0xfafafa      // white — coherent
    );

    const material = new THREE.PointsMaterial({
      size: 0.025,
      color,
      transparent: true,
      opacity: 0.7,
      sizeAttenuation: true,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // ── Animation loop ────────────────────────────────────────────────────────
    let raf: number;
    let last = performance.now();

    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;

      const pos = posAttr.array as Float32Array;
      const coherence = avgConf;
      const damping = 0.97 + coherence * 0.02;
      const attractStrength = 0.0002 + coherence * 0.0008;

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
        const px = pos[ix], py = pos[iy], pz = pos[iz];
        let vx = velocities[ix], vy = velocities[iy], vz = velocities[iz];

        if (attractors.length > 0) {
          const att = attractors[i % attractors.length];
          const dx = att.x - px, dy = att.y - py, dz = att.z - pz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
          const str = attractStrength * att.confidence;
          vx += (dx / dist) * str;
          vy += (dy / dist) * str;
          vz += (dz / dist) * str;
        } else {
          // pure Brownian fog — no axes yet
          vx += (Math.random() - 0.5) * 0.002;
          vy += (Math.random() - 0.5) * 0.002;
          vz += (Math.random() - 0.5) * 0.002;
        }

        // noise proportional to incoherence
        const noise = 0.0005 * (1 - coherence);
        vx += (Math.random() - 0.5) * noise;
        vy += (Math.random() - 0.5) * noise;
        vz += (Math.random() - 0.5) * noise;

        vx *= damping; vy *= damping; vz *= damping;

        // keep in field radius
        const r = Math.sqrt(px * px + py * py + pz * pz);
        if (r > FIELD_RADIUS) {
          vx -= (px / r) * 0.005;
          vy -= (py / r) * 0.005;
          vz -= (pz / r) * 0.005;
        }

        velocities[ix] = vx; velocities[iy] = vy; velocities[iz] = vz;
        pos[ix] = px + vx;
        pos[iy] = py + vy;
        pos[iz] = pz + vz;
      }

      posAttr.needsUpdate = true;
      points.rotation.y += delta * 0.04;
      renderer.render(scene, camera);
    }

    animate();

    // ── Resize handler ────────────────────────────────────────────────────────
    const onResize = () => {
      if (!el) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [axes]);

  return (
    <div
      ref={mountRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
