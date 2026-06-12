/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const conductor = process.env.CONDUCTOR_URL ?? "http://localhost:4000";
    const refuel = process.env.REFUEL_URL ?? "http://localhost:4200";
    return [
      { source: "/api/conductor/:path*", destination: `${conductor}/:path*` },
      { source: "/api/refuel/:path*", destination: `${refuel}/:path*` },
    ];
  },
};

export default nextConfig;
