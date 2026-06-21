import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'raw.githubusercontent.com', pathname: '/mondb-dev/x-hunter/**' },
    ],
  },
  async redirects() {
    return [
      { source: "/verified", destination: "/veritas-lens", permanent: true },
      { source: "/verified/:path*", destination: "/veritas-lens/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
