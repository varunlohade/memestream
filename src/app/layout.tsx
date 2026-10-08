import type { Metadata } from "next";
import { Silkscreen, VT323 } from "next/font/google";
import "./globals.css";

const heading = Silkscreen({ weight: "400", subsets: ["latin"], variable: "--font-heading" });
const body = VT323({ weight: "400", subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: { default: "memestream", template: "%s · memestream" },
  description: "A coin for every live stream. Buy the stream you think will pop.",
};

/** Bare shell shared by the site and the OBS overlay; the site adds its top bar and wallet in (site)/layout. */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${heading.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
