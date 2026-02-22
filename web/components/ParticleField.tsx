"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Axis } from "@/lib/readOntology";

// ─── Constants ────────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 1800;
const FIELD_RADIUS = 6;

// ─── Particle system ──────────────────────────────────────────────────────────

interface ParticlesProps {
  axes: Axis[];
  avgConfidence: number;
}

function Particles({ axes, avgConfidence }: ParticlesProps) {
  const meshRef = useRef<THREE.Points>(null!);
  const timeRef = useRef(0);

  // Build attractor nodes from axes
  const attractors = useMemo(() => {
    if (axes.length === 0) return [];
    return axes.map((axis, i) => {
      // Spread attractors in a circle on the XZ plane
      const angle = (i / axes.length) * Math.PI * 2;
      const r = 2.5;
      return {
        x: Math.cos(angle) * r,
        y: axis.score * 1.5,           // score maps to Y height
        z: Math.sin(angle) * r,
        confidence: axis.confidence,
        score: axis.score,
      };
    });
  }, [axes]);

  // Initial random positions
  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    const vel = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = FIELD_RADIUS * Math.cbrt(Math.random());
      pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      vel[i * 3 + 0] = (Math.random() - 0.5) * 0.01;
      vel[i * 3 + 1] = (Math.random() - 0.5) * 0.01;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.01;
    }
    return { positions: pos, velocities: vel };
  }, []);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
    return geo;
  }, [positions]);

  useFrame((_, delta) => {
    timeRef.current += delta;
    const pos = geometry.attributes.position.array as Float32Array;

    // Coherence: how ordered the field is (0 = chaos, 1 = structured)
    const coherence = avgConfidence;
    // Damping increases with coherence — more orderly at high confidence
    const damping = 0.97 + coherence * 0.02;
    // Attractor strength grows with confidence
    const attractStrength = 0.0002 + coherence * 0.0008;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;
      let px = pos[ix], py = pos[iy], pz = pos[iz];
      let vx = velocities[ix], vy = velocities[iy], vz = velocities[iz];

      if (attractors.length > 0) {
        // Pull toward nearest attractor (weighted by confidence)
        const attractor = attractors[i % attractors.length];
        const dx = attractor.x - px;
        const dy = attractor.y - py;
        const dz = attractor.z - pz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
        const strength = attractStrength * attractor.confidence;
        vx += (dx / dist) * strength;
        vy += (dy / dist) * strength;
        vz += (dz / dist) * strength;
      } else {
        // No axes yet — pure Brownian drift (fog/noise)
        vx += (Math.random() - 0.5) * 0.002;
        vy += (Math.random() - 0.5) * 0.002;
        vz += (Math.random() - 0.5) * 0.002;
      }

      // Slow drift / noise always present
      vx += (Math.random() - 0.5) * 0.0005 * (1 - coherence);
      vy += (Math.random() - 0.5) * 0.0005 * (1 - coherence);
      vz += (Math.random() - 0.5) * 0.0005 * (1 - coherence);

      // Apply damping
      vx *= damping;
      vy *= damping;
      vz *= damping;

      // Keep in field radius
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

    geometry.attributes.position.needsUpdate = true;

    // Slow field rotation
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.04;
    }
  });

  // Particle color: deep blue (no axes) → amber (forming) → white (coherent)
  const color = useMemo(() => {
    if (avgConfidence < 0.2) return new THREE.Color(0x3b82f6); // blue — early fog
    if (avgConfidence < 0.6) return new THREE.Color(0xf59e0b); // amber — forming
    return new THREE.Color(0xfafafa);                           // white — coherent
  }, [avgConfidence]);

  return (
    <points ref={meshRef} geometry={geometry}>
      <pointsMaterial
        size={0.025}
        color={color}
        transparent
        opacity={0.7}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

interface ParticleFieldProps {
  axes: Axis[];
  className?: string;
}

export default function ParticleField({ axes, className }: ParticleFieldProps) {
  const avgConfidence =
    axes.length > 0
      ? axes.reduce((sum, a) => sum + a.confidence, 0) / axes.length
      : 0;

  return (
    <div className={className} style={{ width: "100%", height: "100%" }}>
      <Canvas
        camera={{ position: [0, 0, 10], fov: 50 }}
        gl={{ antialias: false, alpha: true }}
        style={{ background: "transparent" }}
      >
        <Particles axes={axes} avgConfidence={avgConfidence} />
      </Canvas>
    </div>
  );
}
