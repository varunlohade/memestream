/**
 * DEVNET ONLY. Records the raw clips for the demo video, through two local dev servers that point at
 * devnet and hold the throwaway test wallets (.keys/devnet-creator.json on :3101, .keys/devnet-viewer.json on :3102).
 * Each clip is a folder of screencast frames plus frames.json (receive times) and markers.
 * Run: npx tsx demo/record.mts   (output: demo/raw/)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer, { type CDPSession, type ElementHandle, type Page } from "puppeteer-core";
import { CHROME_PATH } from "../scripts/browser";

const CREATOR = "http://127.0.0.1:3101";
const VIEWER = "http://127.0.0.1:3102";
const LIVE = "https://memestream-iota.vercel.app";
const OUT = "demo/raw";
const STREAM = "https://www.youtube.com/watch?v=4xDzrJKXOOY";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: Record<string, unknown> = { signatures: [] as [string, string][] };
const saveLog = () => writeFileSync(`${OUT}/run.json`, JSON.stringify(log, null, 2));

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  protocolTimeout: 180_000,
  args: ["--hide-scrollbars", "--mute-audio", "--window-size=1920,1167"],
});
process.on("exit", () => void browser.process()?.kill());

/** A fake mouse pointer (headless frames have none) and no Next.js dev badge. */
const PAGE_SETUP = `(function(){
  function add(){
    var style=document.createElement("style");
    style.textContent="nextjs-portal{display:none!important}#demo-cursor{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transition:transform 40ms linear}";
    document.head.appendChild(style);
    var c=document.createElement("div");
    c.id="demo-cursor";
    c.innerHTML='<svg width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L8.5 17 L12.5 26 L16 24.5 L12 15.8 L19.5 15.8 Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
    var saved=null; try{saved=sessionStorage.getItem("demo-cursor");}catch(e){}
    if(saved) c.style.transform=saved;
    document.body.appendChild(c);
    document.addEventListener("mousemove",function(e){
      var t="translate("+(e.clientX-3)+"px, "+(e.clientY-2)+"px)";
      c.style.transform=t; try{sessionStorage.setItem("demo-cursor",t);}catch(err){}
    },true);
  }
  setInterval(function(){document.querySelectorAll("nextjs-portal").forEach(function(n){n.remove();});},150);
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",add); else add();
})();`;

let currentStep = "";
async function newPage(name: string) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(PAGE_SETUP);
  page.on("pageerror", (e) => console.error(`[${name}] pageerror`, (e as Error).message));
  page.on("response", async (res) => {
    if (res.url().endsWith("/api/dev-wallet") && res.request().method() === "POST") {
      const body = (await res.json().catch(() => ({}))) as { signature?: string; error?: string };
      if (body.signature) (log.signatures as [string, string][]).push([currentStep, body.signature]);
      console.log(`[${name}] wallet signed (${currentStep})`, body.signature ?? body.error);
      saveLog();
    }
  });
  return page;
}

/* ---------- screencast recorder ---------- */
type Clip = { name: string; frames: number[]; markers: Record<string, number>; t0: number; end?: number };
let rec: { session: CDPSession; clip: Clip } | null = null;
async function startClip(page: Page, name: string) {
  await page.bringToFront();
  const session = await page.createCDPSession();
  const clip: Clip = { name, frames: [], markers: {}, t0: Date.now() };
  mkdirSync(`${OUT}/${name}`, { recursive: true });
  session.on("Page.screencastFrame", (e: { data: string; sessionId: number }) => {
    const i = clip.frames.length;
    clip.frames.push(Date.now() - clip.t0);
    writeFileSync(`${OUT}/${name}/${String(i).padStart(5, "0")}.jpg`, Buffer.from(e.data, "base64"));
    void session.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  rec = { session, clip };
  console.log(`clip ${name} started`);
}
const mark = (label: string) => {
  if (rec) rec.clip.markers[label] = Date.now() - rec.clip.t0;
  console.log(`  mark ${label}`);
};
async function stopClip() {
  if (!rec) return;
  const { session, clip } = rec;
  await sleep(300);
  await session.send("Page.stopScreencast").catch(() => {});
  clip.end = Date.now() - clip.t0;
  writeFileSync(`${OUT}/${clip.name}/frames.json`, JSON.stringify(clip));
  await session.detach().catch(() => {});
  console.log(`clip ${clip.name} stopped: ${clip.frames.length} frames, ${(clip.end / 1000).toFixed(1)} s`);
  rec = null;
}

/* ---------- user-like helpers ---------- */
const byText = (t: string) => `::-p-text(${t})`;
async function find(page: Page, selector: string, timeout = 30_000): Promise<ElementHandle<Element>> {
  const el = await page.locator(selector).setTimeout(timeout).waitHandle();
  return el as ElementHandle<Element>;
}
async function moveTo(page: Page, el: ElementHandle<Element>) {
  await el.evaluate((e) => e.scrollIntoView({ block: "nearest", behavior: "instant" as ScrollBehavior }));
  const box = await el.boundingBox();
  if (!box) throw new Error("element not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await sleep(250);
}
async function click(page: Page, selector: string, timeout?: number) {
  const el = await find(page, selector, timeout);
  await moveTo(page, el);
  await el.click();
  await sleep(300);
}
async function typeIn(page: Page, selector: string, value: string) {
  const el = await find(page, selector);
  await moveTo(page, el);
  await el.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await el.type(value, { delay: 70 });
  await sleep(300);
}
const waitText = (page: Page, t: string, timeout = 90_000) =>
  page.waitForFunction((s) => document.body.innerText.includes(s), { timeout, polling: 250 }, t);
async function smoothScrollTo(page: Page, selector: string, block: ScrollLogicalPosition = "center") {
  const el = await find(page, selector);
  await el.evaluate((e, b) => e.scrollIntoView({ block: b, behavior: "smooth" }), block);
  await sleep(1200);
}
async function connect(page: Page) {
  await click(page, `button[aria-label="Connect wallet"]`);
  await click(page, byText("Test wallet (localhost)"));
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Connect wallet"]'), { timeout: 20_000 });
  await sleep(500);
}

/* ---------- chain state via the app's own API ---------- */
type Detail = {
  coin: { status: string; progress: number; streamerUnclaimedSol: string; meteoraPool: string | null };
  holdings: { coins: string; lpFees: { sol: string; coins: string } | null } | null;
};
const devWallet = async (base: string) => ((await (await fetch(`${base}/api/dev-wallet`)).json()) as { address: string }).address;
const creatorAddr = await devWallet(CREATOR);
const viewerAddr = await devWallet(VIEWER);
async function detail(base: string, mint: string, wallet: string): Promise<Detail> {
  return (await (await fetch(`${base}/api/coins/${mint}?wallet=${wallet}`)).json()) as Detail;
}
async function waitChain(base: string, mint: string, wallet: string, what: string, ok: (d: Detail) => boolean, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (ok(await detail(base, mint, wallet))) return;
    } catch {}
    await sleep(1500);
  }
  throw new Error(`chain never showed: ${what}`);
}
const held = (d: Detail) => Number(d.holdings?.coins ?? 0);

/* ---------- warm up (dev mode compiles each route on first visit) ---------- */
for (const base of [CREATOR, VIEWER]) for (const p of ["/", "/go-live", "/coin/11111111111111111111111111111111", "/api/coins", "/api/tape"]) await fetch(base + p).catch(() => {});
await sleep(2000);

const creator = await newPage("creator");
const viewer = await newPage("viewer");
await viewer.goto(VIEWER, { waitUntil: "domcontentloaded" });
await sleep(3000);
await connect(viewer);

const TICKER = `DEMO${Date.now().toString(36).slice(-5).toUpperCase()}`;
log.ticker = TICKER;
saveLog();

/* 1. Go live */
await creator.goto(CREATOR, { waitUntil: "domcontentloaded" });
await sleep(4000);
await creator.mouse.move(960, 600);
await startClip(creator, "01-golive");
await sleep(1500);
await connect(creator);
mark("connected");
await click(creator, byText("Go live"));
await find(creator, `input[placeholder="Ranked till Diamond"]`);
await sleep(1200);
mark("form");
await typeIn(creator, `input[placeholder="Ranked till Diamond"]`, "Late-night lofi coding");
await typeIn(creator, `input[placeholder="$MIRA"]`, TICKER);
await typeIn(creator, `input[placeholder="YouTube or Twitch live link"]`, STREAM);
await sleep(800);
currentStep = "launch";
mark("click-launch");
await click(creator, `button${byText("Launch coin")}:not([disabled])`);
const launchedAt = Date.now();
await creator.waitForFunction(() => location.pathname.startsWith("/coin/"), { timeout: 150_000 });
mark("coin-page");
const mint = creator.url().split("/coin/")[1].split(/[?#]/)[0];
log.mint = mint;
saveLog();
await waitText(creator, `$${TICKER}`);
await sleep(5000);
mark("end");
await stopClip();

/* 2. First-minute launch fee, seen by a viewer */
await viewer.goto(`${VIEWER}/coin/${mint}`, { waitUntil: "domcontentloaded" });
await waitText(viewer, "Launch fee now", 60_000).catch(() => console.log("no launch fee line seen"));
await startClip(viewer, "02-fee");
await sleep(1500);
await typeIn(viewer, 'input[aria-label^="Amount in"]', "0.01");
await waitText(viewer, "You get about").catch(() => {});
await viewer.evaluate(() => {
  const els = [...document.querySelectorAll("p,div,span")].filter((e) => e.textContent?.includes("Launch fee now"));
  const el = els[els.length - 1];
  if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 640, behavior: "smooth" });
});
await sleep(1500);
await viewer.mouse.move(1500, 700, { steps: 15 });
await sleep(7000);
mark("end");
await stopClip();
log.feeSeenSecondsAfterLaunch = (Date.now() - launchedAt) / 1000;

/* 3. Buy, then sell (after the launch fee settles) */
const waitMs = launchedAt + 66_000 - Date.now();
if (waitMs > 0) {
  console.log(`waiting ${Math.round(waitMs / 1000)} s for the launch fee to settle`);
  await sleep(waitMs);
}
await viewer.reload({ waitUntil: "domcontentloaded" });
await waitText(viewer, "You get about").catch(() => {});
await sleep(3000);
await startClip(viewer, "03-trade");
await sleep(1000);
let before = held(await detail(VIEWER, mint, viewerAddr));
await typeIn(viewer, 'input[aria-label^="Amount in"]', "0.02");
await waitText(viewer, "You get about");
await sleep(800);
currentStep = "buy 0.02 SOL";
mark("click-buy");
await click(viewer, `button${byText(`Buy ${TICKER}`)}:not([disabled])`);
await waitChain(VIEWER, mint, viewerAddr, "buy landed", (d) => held(d) > before);
await waitText(viewer, `Bought ${TICKER}`, 30_000).catch(() => {});
mark("bought");
await sleep(2500);
before = held(await detail(VIEWER, mint, viewerAddr));
await click(viewer, `button[aria-pressed]${byText("Sell")}`);
await sleep(600);
await click(viewer, byText("50%"));
await sleep(800);
currentStep = "sell 50%";
mark("click-sell");
await click(viewer, `button${byText(`Sell ${TICKER}`)}:not([disabled])`);
await waitChain(VIEWER, mint, viewerAddr, "sell landed", (d) => held(d) < before);
await waitText(viewer, `Sold ${TICKER}`, 30_000).catch(() => {});
mark("sold");
await sleep(3000);
mark("end");
await stopClip();

/* 4. Recent trades, then the ticker tape on the home page */
await sleep(4000);
await viewer.reload({ waitUntil: "domcontentloaded" });
await waitText(viewer, "Recent trades");
await sleep(4000);
await startClip(viewer, "04-trades");
await sleep(800);
await smoothScrollTo(viewer, byText("Recent trades"), "start");
await sleep(4000);
mark("home");
await viewer.goto(VIEWER, { waitUntil: "domcontentloaded" });
await sleep(7000);
mark("end");
await stopClip();

/* 5. The streamer claims earnings */
await creator.reload({ waitUntil: "domcontentloaded" });
await waitText(creator, "Your earnings");
await sleep(4000);
await startClip(creator, "05-claim");
await sleep(800);
await smoothScrollTo(creator, byText("Your earnings"), "center");
await sleep(1500);
currentStep = "streamer claims earnings";
mark("click-claim");
await click(creator, `button${byText("Claim earnings")}:not([disabled])`);
await waitChain(CREATOR, mint, creatorAddr, "earnings claimed", (d) => Number(d.coin.streamerUnclaimedSol) === 0);
mark("claimed");
await sleep(4000);
mark("end");
await stopClip();

/* 6. Fill the curve and graduate */
await viewer.goto(`${VIEWER}/coin/${mint}`, { waitUntil: "domcontentloaded" });
await waitText(viewer, "You get about").catch(() => {});
await sleep(3000);
await startClip(viewer, "06-graduate");
await sleep(800);
await click(viewer, `button[aria-pressed]${byText("Buy")}`);
await typeIn(viewer, 'input[aria-label^="Amount in"]', "0.15");
await waitText(viewer, "This fills the curve");
await sleep(2500);
mark("fills-shown");
currentStep = "buy 0.15 SOL (fills the curve)";
await click(viewer, `button${byText(`Buy ${TICKER}`)}:not([disabled])`);
await waitChain(VIEWER, mint, viewerAddr, "curve full", (d) => d.coin.status === "graduating");
mark("curve-full");
await sleep(1500);
const gradBtn = await find(viewer, `button${byText("Graduate to Meteora")}:not([disabled])`, 60_000);
await moveTo(viewer, gradBtn);
await sleep(600);
currentStep = "graduate to Meteora (DBC -> DAMM v2)";
mark("click-graduate");
await gradBtn.click();
await waitChain(VIEWER, mint, viewerAddr, "graduated", (d) => d.coin.status === "graduated", 180_000);
mark("graduated");
await sleep(3000);
await viewer.reload({ waitUntil: "domcontentloaded" });
await waitText(viewer, "Graduated: trades in its Meteora pool", 60_000).catch(() => {});
await sleep(4000);
mark("end");
await stopClip();

/* 7. Trade on the graduated coin, then the streamer claims LP pool fees */
await startClip(viewer, "07a-pooltrade");
await sleep(800);
before = held(await detail(VIEWER, mint, viewerAddr));
await click(viewer, `button[aria-pressed]${byText("Buy")}`);
await typeIn(viewer, 'input[aria-label^="Amount in"]', "0.01");
await waitText(viewer, "You get about");
await sleep(800);
currentStep = "buy 0.01 SOL in the Meteora DAMM v2 pool";
mark("click-buy");
await click(viewer, `button${byText(`Buy ${TICKER}`)}:not([disabled])`);
await waitChain(VIEWER, mint, viewerAddr, "pool buy landed", (d) => held(d) > before);
await waitText(viewer, `Bought ${TICKER}`, 30_000).catch(() => {});
mark("bought");
await sleep(3000);
mark("end");
await stopClip();

await waitChain(CREATOR, mint, creatorAddr, "LP fees visible", (d) => Number(d.holdings?.lpFees?.sol ?? 0) > 0 || Number(d.holdings?.lpFees?.coins ?? 0) > 0, 120_000);
await creator.bringToFront();
for (let i = 0; ; i++) {
  await creator.reload({ waitUntil: "domcontentloaded" });
  try {
    await waitText(creator, "Your LP NFT", 40_000);
    break;
  } catch (e) {
    if (i >= 3) throw e;
  }
}
await sleep(4000);
await startClip(creator, "07b-lpclaim");
await sleep(800);
await smoothScrollTo(creator, byText("Your LP NFT"), "center");
await sleep(1500);
currentStep = "streamer claims LP pool fees";
mark("click-claim");
await click(creator, `button${byText("Claim pool fees")}:not([disabled])`, 60_000);
await waitChain(CREATOR, mint, creatorAddr, "LP fees claimed", (d) => Number(d.holdings?.lpFees?.sol ?? 0) === 0, 120_000).catch((e) => console.log(String(e)));
mark("claimed");
await sleep(4000);
mark("end");
await stopClip();

/* 8. OBS overlay A (live site) on top of the stream */
const overlayHtml = `<!doctype html><html><head><style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#000}
iframe{position:absolute;inset:0;width:1920px;height:1080px;border:0}</style></head><body>
<iframe src="https://www.youtube.com/embed/4xDzrJKXOOY?autoplay=1&mute=1&controls=0&modestbranding=1" allow="autoplay"></iframe>
<iframe src="${LIVE}/overlay/${mint}?layout=a" style="background:transparent" allowtransparency="true"></iframe></body></html>`;
writeFileSync(`${OUT}/overlay-stage.html`, overlayHtml);
const stage = await newPage("stage");
await stage.goto(`file://${process.cwd()}/${OUT}/overlay-stage.html`, { waitUntil: "domcontentloaded" });
await sleep(9000);
await startClip(stage, "08-overlay");
await sleep(9000);
mark("end");
await stopClip();

/* 9. Explorer: the graduation transaction and the config */
const sigs = log.signatures as [string, string][];
const gradSig = sigs.find(([s]) => s.startsWith("graduate"))?.[1];
const explorer = await newPage("explorer");
if (gradSig) {
  await explorer.goto(`https://explorer.solana.com/tx/${gradSig}?cluster=devnet`, { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {});
  await sleep(6000);
  await startClip(explorer, "09a-explorer-tx");
  await sleep(4000);
  await explorer.mouse.wheel({ deltaY: 500 });
  await sleep(3500);
  mark("end");
  await stopClip();
}
await explorer.goto(`https://explorer.solana.com/address/Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg?cluster=devnet`, { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => {});
await sleep(6000);
await startClip(explorer, "09b-explorer-config");
await sleep(5000);
mark("end");
await stopClip();

console.log(JSON.stringify(log, null, 2));
await browser.close().catch(() => {});
process.exit(0);
