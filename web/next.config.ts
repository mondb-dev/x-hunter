import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  outputFileTracingIncludes: {
    "/**": ["./data/**"],
  },
};

export default nextConfig;
