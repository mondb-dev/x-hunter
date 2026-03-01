import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  serverExternalPackages: ["jsdom"],
  outputFileTracingIncludes: {
    "/**": ["./data/**"],
  },
};

export default nextConfig;
