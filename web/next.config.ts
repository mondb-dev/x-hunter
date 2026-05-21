import type { NextConfig } from "next";

const isVercel = !!process.env.VERCEL;

const nextConfig: NextConfig = {
  ...(isVercel ? {} : {
    output: "standalone",
    outputFileTracingIncludes: { "/**": ["./data/**"] },
  }),
  turbopack: {},
  async redirects() {
    return [
      { source: "/verified", destination: "/veritas-lens", permanent: true },
      { source: "/verified/:path*", destination: "/veritas-lens/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
