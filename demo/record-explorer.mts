/** Re-records the explorer clips with a plain page (the explorer app crashes with the injected demo cursor). */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";
import { CHROME_PATH } from "../scripts/browser";
const run = JSON.parse(readFileSync("demo/raw/run.json", "utf8")) as { signatures: [string, string][] };
const grad = run.signatures.find(([s]) => s.startsWith("graduate"))![1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--hide-scrollbars", "--mute-audio", "--window-size=1920,1167"] });
const p = await b.newPage();
await p.setViewport({ width: 1920, height: 1080 });
async function clip(name: string, url: string, act: (p: Page) => Promise<void>) {
  const OUT = `demo/raw/${name}`;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await p.goto(url, { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {});
  await sleep(6000);
  const s = await p.createCDPSession();
  const t0 = Date.now(); const frames: number[] = [];
  s.on("Page.screencastFrame", (e: any) => { writeFileSync(`${OUT}/${String(frames.length).padStart(5, "0")}.jpg`, Buffer.from(e.data, "base64")); frames.push(Date.now() - t0); void s.send("Page.screencastFrameAck", { sessionId: e.sessionId }); });
  await s.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
  await act(p);
  await s.send("Page.stopScreencast");
  writeFileSync(`${OUT}/frames.json`, JSON.stringify({ name, frames, markers: {}, t0, end: Date.now() - t0 }));
  await s.detach();
  console.log(name, frames.length);
}
await clip("09a-explorer-tx", `https://explorer.solana.com/tx/${grad}?cluster=devnet`, async (p) => {
  await sleep(3000);
  await p.evaluate(() => window.scrollTo({ top: 1500, behavior: "smooth" }));
  await sleep(4000);
});
await clip("09b-explorer-config", "https://explorer.solana.com/address/Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg?cluster=devnet", async (p) => {
  await sleep(3000);
  await p.evaluate(() => window.scrollTo({ top: 420, behavior: "smooth" }));
  await sleep(3500);
});
await b.close();
