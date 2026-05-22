import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: "export" is commented out for local dev so that Next.js
  // server mode runs and can inject COOP/COEP headers via headers().
  // Uncomment before deploying to Vercel — Vercel sets headers via vercel.json.
  // output: "export",

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },

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