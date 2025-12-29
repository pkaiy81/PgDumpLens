/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  typescript: {
    // Type checking is done separately in CI via `yarn lint`
    ignoreBuildErrors: false,
  },
  serverExternalPackages: [],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: process.env.API_URL || "http://localhost:8080/api/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
