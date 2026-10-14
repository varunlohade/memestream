/**
 * Renders the caption overlays (transparent 1920x1080 PNGs) and the end card with headless Chrome,
 * since this machine's ffmpeg has no drawtext/subtitles filter. ffmpeg then burns them in with overlay.
 * Run: npx tsx demo/cards.mts   (reads demo/captions.json, writes demo/cards/)
 */
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { CHROME_PATH } from "../scripts/browser";

type Cap = { id: string; text: string; sub?: string; pos?: "top" | "bl" | "ml" | "left" };
const caps = JSON.parse(readFileSync("demo/captions.json", "utf8")) as Cap[];
mkdirSync("demo/cards", { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--hide-scrollbars", "--mute-audio"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

const FONT = "";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

for (const c of caps) {
  const pos = c.pos ?? "bl";
  const wrap = pos === "top" ? "top:56px;left:0;right:0;justify-content:center" : pos === "left" ? "top:380px;left:40px;width:580px;justify-content:flex-start" : pos === "ml" ? "top:330px;left:40px;width:1368px;justify-content:center" : "bottom:60px;left:40px;width:1368px;justify-content:center";
  await page.setContent(
    `<!doctype html><html><head>${FONT}<style>
    html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif}
    .wrap{position:absolute;${wrap};display:flex}
    .box{max-width:${pos === "top" ? 1500 : pos === "left" ? 500 : 1300}px;background:rgba(10,10,14,.86);border:3px solid #7CFC3A;border-radius:6px;padding:22px 40px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .t{color:#fff;font-weight:800;font-size:${pos === "left" ? 40 : 46}px;line-height:1.25}
    .s{color:#c9f7b0;font-weight:600;font-size:28px;margin-top:10px}
    </style></head><body><div class="wrap"><div class="box"><div class="t">${esc(c.text)}</div>${c.sub ? `<div class="s">${esc(c.sub)}</div>` : ""}</div></div></body></html>`,
    { waitUntil: "load", timeout: 60_000 },
  );
  await page.screenshot({ path: `demo/cards/cap-${c.id}.png`, omitBackground: true });
}

await page.setContent(
  `<!doctype html><html><head>${FONT}<style>
  html,body{margin:0;width:1920px;height:1080px;background:#1b1b22;color:#fff;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px;
    background-image:linear-gradient(45deg,#202028 25%,transparent 25%,transparent 75%,#202028 75%),linear-gradient(45deg,#202028 25%,transparent 25%,transparent 75%,#202028 75%);
    background-size:24px 24px;background-position:0 0,12px 12px}
  .logo{font-family:Menlo,monospace;font-weight:700;font-size:96px;letter-spacing:2px}
  .coin{display:inline-block;width:84px;height:84px;background:#f5c518;border:8px solid #b8860b;margin-right:28px;vertical-align:middle;image-rendering:pixelated}
  .tag{font-size:44px;font-weight:800;color:#7CFC3A}
  .url{font-family:Menlo,monospace;font-weight:700;font-size:40px;background:#000;border:4px solid #7CFC3A;padding:24px 36px}
  .small{font-size:30px;color:#bbb;font-weight:600}
  </style></head><body>
  <div class="logo"><span class="coin"></span>memestream</div>
  <div class="tag">A coin for every live stream. Built on Meteora DBC.</div>
  <div class="url">memestream-iota.vercel.app</div>
  <div class="small">Live on Solana devnet</div>
  </body></html>`,
  { waitUntil: "load", timeout: 60_000 },
);
await page.screenshot({ path: "demo/cards/endcard.png" });
await browser.close();
console.log(`rendered ${caps.length} captions + end card`);
