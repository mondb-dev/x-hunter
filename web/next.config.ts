import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Allow reading files from the parent repo (state/ and daily/)
  serverExternalPackages: [],
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@state": path.resolve(__dirname, "../state"),
      "@daily": path.resolve(__dirname, "../daily"),
    };
    return config;
  },
};

export default nextConfig;
