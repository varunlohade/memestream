import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
