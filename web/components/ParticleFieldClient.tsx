"use client";

import dynamic from "next/dynamic";
import type { Axis } from "@/lib/readOntology";

// Prevent Three.js canvas from being server-rendered
const ParticleField = dynamic(() => import("./ParticleField"), { ssr: false });

interface ParticleFieldClientProps {
  axes: Axis[];
  className?: string;
}

export default function ParticleFieldClient(props: ParticleFieldClientProps) {
  return <ParticleField {...props} />;
}
