import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  async redirects() {
    return [
      { source: "/verified", destination: "/veritas-lens", permanent: true },
      { source: "/verified/:path*", destination: "/veritas-lens/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
