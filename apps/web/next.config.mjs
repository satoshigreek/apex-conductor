/**
 * Two build modes:
 *  - default: dev/server mode with API proxies to the local services
 *  - STATIC_EXPORT=1: static export for GitHub Pages (basePath /apex-conductor) —
 *    the browser talks to Koios / Base RPC directly (lib/static-mode.ts)
 */
const staticExport = process.env.STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(staticExport
    ? {
        output: "export",
        basePath: "/apex-conductor",
        images: { unoptimized: true },
        env: { NEXT_PUBLIC_STATIC: "1", NEXT_PUBLIC_BASE_PATH: "/apex-conductor" },
      }
    : {
        async rewrites() {
          const conductor = process.env.CONDUCTOR_URL ?? "http://localhost:4000";
          const refuel = process.env.REFUEL_URL ?? "http://localhost:4200";
          return [
            { source: "/api/conductor/:path*", destination: `${conductor}/:path*` },
            { source: "/api/refuel/:path*", destination: `${refuel}/:path*` },
          ];
        },
      }),
};

export default nextConfig;
