import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",

  webpack: (config) => {
    config.resolve.fallback = { fs: false };
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });
    return config;
  },
};

export default nextConfig;