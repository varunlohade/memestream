import type { Metadata } from "next";
import { Silkscreen, VT323 } from "next/font/google";
import "./globals.css";

const heading = Silkscreen({ weight: "400", subsets: ["latin"], variable: "--font-heading" });
const body = VT323({ weight: "400", subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: { default: "memestream", template: "%s · memestream" },
  description: "A prediction market for every live stream. Bet SOL on what happens next, or buy the stream's coin.",
};

/** Bare shell shared by the site and the OBS overlay; the site adds its top bar and wallet in (site)/layout. */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${heading.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
