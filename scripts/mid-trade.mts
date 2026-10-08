/**
 * Money-safety checks that need a trade held open. Start the app with a slow test wallet:
 *   npm run dev:chain            (fresh chain)
 *   MEMESTREAM_DEV_SEND_DELAY_MS=20000 npm run dev
 *   npx tsx scripts/mid-trade.mts
 * Checks: a reload mid-trade ends in exactly one trade; a second tab is locked mid-trade and
 * unlocks after; a triple click makes one trade. Based on the tester's qa/2026-10-07-final/breaks.mts.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { sleep } from "../src/lib/poll";

const BASE = "http://127.0.0.1:3000";
const SEND_DELAY_MS = 20_000;

const wallet = ((await (await fetch(`${BASE}/api/dev-wallet`)).json()) as { address: string }).address;
const coins = ((await (await fetch(`${BASE}/api/coins`)).json()) as { coins: { mint: string; symbol: string }[] }).coins;
const mint = coins.find((c) => c.symbol === "SYNTH")?.mint;
if (!mint) throw new Error("$SYNTH not found: start a fresh npm run dev:chain");
type Detail = { trades: { wallet: string; signature: string }[] };
const myTrades = async () => ((await (await fetch(`${BASE}/api/coins/${mint}?wallet=${wallet}`)).json()) as Detail).trades.filter((t) => t.wallet === wallet).length;

const browser: Browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--mute-audio"],
});
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => results.push([name, ok, note]);

async function newPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1240 });
  await page.setRequestInterception(true);
  page.on("request", (r) => (["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(new URL(r.url()).hostname) || r.url().startsWith("data:") ? r.continue() : r.abort()));
  return page;
}
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, t: string, timeout = 60_000) => p.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, t);
async function openCoin(p: Page) {
  await p.goto(`${BASE}/coin/${mint}`, { waitUntil: "domcontentloaded" });
  await waitText(p, "Graduation");
}
/** A small buy (devnet graduates at 0.1 SOL, so the 0.5 default would fill the curve). */
async function buyButton(p: Page) {
  const input = await p.waitForSelector('input[aria-label^="Amount in"]');
  await input!.click({ clickCount: 3 });
  await p.keyboard.press("Backspace");
  await input!.type("0.005");
  await waitText(p, "You get about");
  return p.locator("button::-p-text(Buy SYNTH):not([disabled])").setTimeout(30_000);
}

try {
  const a = await newPage();
  await a.goto(BASE, { waitUntil: "domcontentloaded" });
  await a.locator("::-p-text(Connect)").click();
  await a.locator("::-p-text(Test wallet (localhost))").click();
  await sleep(1500);

  // 1. Reload mid-trade: exactly one trade, and the page says it went through.
  await openCoin(a);
  const before = await myTrades();
  await (await buyButton(a)).click();
  await waitText(a, "Confirming");
  await a.reload({ waitUntil: "domcontentloaded" });
  await waitText(a, "Trading is paused");
  check("after reload, trading is still paused", true);
  await waitText(a, "Your last transaction went through", SEND_DELAY_MS + 30_000);
  await sleep(3000);
  check("reload mid-trade makes exactly one trade", (await myTrades()) === before + 1, `${(await myTrades()) - before} trades`);

  // 2. Second tab mid-trade: locked while pending, free after.
  await openCoin(a);
  const tradesBefore2 = await myTrades();
  await (await buyButton(a)).click();
  await waitText(a, "Confirming");
  const b = await newPage();
  await openCoin(b);
  await waitText(b, "A trade is in progress in another tab");
  const bBuyDisabled = await b.$eval("button.mbtn.buy:last-of-type", (el) => (el as HTMLButtonElement).disabled).catch(() => true);
  check("second tab shows the lock and can't buy", bBuyDisabled);
  await a.bringToFront(); // background tabs throttle timers, as in a real browser
  await waitText(a, "Bought SYNTH", SEND_DELAY_MS + 30_000);
  await b.reload({ waitUntil: "domcontentloaded" });
  await sleep(3000);
  check("second tab unlocks after the trade", !(await text(b)).includes("A trade is in progress"));
  check("second tab trade count", (await myTrades()) === tradesBefore2 + 1);

  // 3. Triple click: one trade.
  await b.close();
  await openCoin(a);
  const tradesBefore3 = await myTrades();
  const button = await buyButton(a);
  await Promise.all([button.click(), button.click().catch(() => {}), button.click().catch(() => {})]);
  await waitText(a, "Bought SYNTH", SEND_DELAY_MS + 30_000);
  await sleep(3000);
  check("triple click makes one trade", (await myTrades()) === tradesBefore3 + 1, `${(await myTrades()) - tradesBefore3} trades`);
} catch (error) {
  check("run finished", false, (error as Error).message.split("\n")[0]);
  const shots = process.env.MID_TRADE_OUT;
  if (shots) {
    for (const [i, p] of (await browser.pages()).entries()) {
      await p.screenshot({ path: `${shots}/fail-tab${i}.png` as `${string}.png` }).catch(() => {});
      console.log(`tab ${i}:`, (await text(p).catch(() => "")).slice(0, 400).replace(/\n+/g, " | "));
    }
  }
} finally {
  await browser.close().catch(() => {});
}
for (const [name, ok, note] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
