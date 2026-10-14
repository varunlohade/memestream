import type { NextConfig } from "next";
import { assertSafeDeployment } from "./src/lib/network";

// Fails `next build` and `next start` loudly on unsafe settings (e.g. the test wallet key on mainnet).
// The server checks again on first chain access (src/server/chain.ts), for hosts that skip this file.
assertSafeDeployment(process.env);

const nextConfig: NextConfig = {
  cacheComponents: true,
  // `npm run check` builds into .next-check so it can't clash with a running `next dev` (.next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    const safe = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      // Trade pages can't be framed by other sites (clickjacking). The OBS overlay stays
      // embeddable, since some streaming tools load browser sources inside an iframe.
      { source: "/((?!overlay/).*)", headers: [...safe, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
      { source: "/overlay/:path*", headers: safe },
    ];
  },
  // The old Vercel address sends everyone to the real domain (wallet sign-in checks the site's address).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "memestream-iota.vercel.app" }],
        destination: "https://www.memestream.lol/:path*",
        permanent: false,
      },
    ];
  },
  // YouTube and Twitch stream pictures on coin tiles and coin icons.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com", pathname: "/vi/**" },
      { protocol: "https", hostname: "static-cdn.jtvnw.net", pathname: "/previews-ttv/**" },
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
