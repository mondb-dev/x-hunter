import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  outputFileTracingIncludes: {
    "/**": ["./data/**"],
  },
  async rewrites() {
    return [
      {
        source: "/arweave/:path*",
        destination: "https://gateway.irys.xyz/:path*",
      },
    ];
  },
};

export default nextConfig;
