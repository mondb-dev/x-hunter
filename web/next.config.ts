import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {},
  outputFileTracingIncludes: {
    "/**": ["./data/**"],
  },
};

export default nextConfig;
