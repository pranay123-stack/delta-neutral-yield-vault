import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source ("main": "src/index.ts").
  transpilePackages: ["@dnv/shared", "@dnv/simulator"],
  experimental: {
    // 11 static pages: one worker per CPU (13 here) buys nothing and costs ~1.5 GB of RAM on a dev box
    // that is also running Anvil, Postgres and the backend.
    cpus: 2,
  },
};

export default nextConfig;
