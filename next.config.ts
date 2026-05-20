import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",

  webpack: (config) => {
    // Prevent Next.js from trying to bundle Node.js built-ins that
    // ffmpeg.wasm references internally (e.g. "fs", "path").
    config.resolve.fallback = { fs: false };

    // Tell webpack to treat .wasm files as plain asset files rather
    // than running them through its own WebAssembly pipeline.
    // Without this, @ffmpeg/core's .wasm binary gets mangled or
    // renamed with a content hash that breaks the SRI integrity check.
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });

    return config;
  },

  // NOTE: Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
  // headers are NOT set here because `output: "export"` generates a
  // fully static site. Next.js `headers()` only runs on a Next.js
  // server — it has no effect for static exports.
  //
  // Those headers are configured in vercel.json instead, where Vercel's
  // edge network can inject them on every response regardless of whether
  // the file is static HTML, JS, or WASM.
  // See: vercel.json → headers[].source = "/(.*)"
};

export default nextConfig;