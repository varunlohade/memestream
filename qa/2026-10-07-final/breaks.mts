// Tester break checks: round-trip loss, double click, reload mid-trade. Muted headless Chrome.
import puppeteer, { type Page } from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const OUT = "qa/2026-10-07-final/breaks";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = ((await (await fetch(`${BASE}/api/dev-wallet`)).json()) as { address: string }).address;
const coins = ((await (await fetch(`${BASE}/api/coins`)).json()) as { coins: { mint: string; symbol: string }[] }).coins;
const mintOf = (s: string) => coins.find((c) => c.symbol === s)!.mint;
type D = { coin: { launchedAt: number; status: string }; holdings: { sol: string; coins: string }; trades: { wallet: string; side: string; sol: string; signature: string }[] };
const det = async (m: string) => (await (await fetch(`${BASE}/api/coins/${m}?wallet=${W}`, { cache: "no-store" })).json()) as D;
const mine = (d: D) => d.trades.filter((t) => t.wallet === W);
async function settle(m: string, ms = 20_000) { // wait until SOL balance stops changing
  let last = "", same = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = (await det(m)).holdings.sol; same = s === last ? same + 1 : 0; last = s; if (same >= 4) break; await sleep(1000); }
  return det(m);
}

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--mute-audio"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1240 });
await page.setRequestInterception(true);
page.on("request", (r) => (["127.0.0.1", "localhost", "fonts.googleapis.com", "fonts.gstatic.com"].includes(new URL(r.url()).hostname) || r.url().startsWith("data:") ? r.continue() : r.abort()));
const txPosts: string[] = [];
page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/")) txPosts.push(`${new Date().toISOString()} ${r.url().replace(BASE, "")}`); });
const T = (t: string) => `::-p-text(${t})`;
const waitText = (p: Page, t: string, timeout = 30_000) => p.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, t);
async function setAmount(p: Page, v: string) { const i = await p.waitForSelector('input[aria-label^="Amount in"]'); await i!.click({ clickCount: 3 }); await p.keyboard.press("Backspace"); await i!.type(v); }
async function open(m: string) { await page.goto(`${BASE}/coin/${m}`, { waitUntil: "domcontentloaded" }); await waitText(page, "Graduation"); }

// connect
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(T("Connect")).click();
await page.locator(T("Test wallet (localhost)")).click();
await sleep(2000);
const log = (...a: unknown[]) => console.log(...a);

// A. round trip on SHIP (launched minutes ago)
{
  const m = mintOf("SHIP");
  if (Number((await det(m)).holdings.coins) > 0) { await open(m); await page.locator(`button[aria-pressed]${T("Sell")}`).click(); await page.locator(`button${T("Max")}`).click(); await sleep(1500); await page.locator(`button${T("Sell SHIP")}:not([disabled])`).click(); await settle(m); }
  const d0 = await det(m);
  log("A SHIP age s:", Math.round(Date.now() / 1000 - d0.coin.launchedAt), "sol before", d0.holdings.sol);
  await open(m);
  await setAmount(page, "0.2");
  await waitText(page, "You get about");
  await page.locator(`button${T("Buy SHIP")}:not([disabled])`).click();
  const d1 = await settle(m);
  log("A after buy sol", d1.holdings.sol, "coins", d1.holdings.coins);
  await page.screenshot({ path: `${OUT}/A-after-buy.png` });
  log("A buttons after buy:", await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.innerText.trim() + (b.getAttribute("aria-pressed") !== null ? "[tab]" : "")).join(" / ")));
  await open(m);
  await page.locator(`button[aria-pressed]${T("Sell")}`).setTimeout(10_000).click();
  await page.locator(`button${T("Max")}`).click();
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/A-sell-quote.png` });
  await page.locator(`button${T("Sell SHIP")}:not([disabled])`).click();
  const d2 = await settle(m);
  const loss = Number(d0.holdings.sol) - Number(d2.holdings.sol);
  log("A after sell sol", d2.holdings.sol, "coins", d2.holdings.coins, "loss SOL", loss.toFixed(6), "loss %", ((loss / 0.2) * 100).toFixed(2));
  await page.screenshot({ path: `${OUT}/A-after.png` });
}

// B. double click / triple click Buy on OKO
{
  const m = mintOf("OKO");
  const d0 = await det(m);
  await open(m);
  await setAmount(page, "0.1");
  await waitText(page, "You get about");
  const btn = await page.waitForSelector(`button${T("Buy OKO")}:not([disabled])`);
  const n0 = txPosts.length;
  await btn!.click({ count: 3, delay: 30 }).catch((e) => log("B click err", e.message));
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("OKO") && x.innerText.includes("Buy")); b?.click(); b?.click(); });
  await page.screenshot({ path: `${OUT}/B-during.png` });
  const d1 = await settle(m);
  log("B spent SOL", (Number(d0.holdings.sol) - Number(d1.holdings.sol)).toFixed(6), "my new trades", mine(d1).length - mine(d0).length, "api POSTs", txPosts.slice(n0));
  await page.screenshot({ path: `${OUT}/B-after.png` });
}

// C. reload mid-trade on OKO, then look at the page
{
  const m = mintOf("OKO");
  const d0 = await det(m);
  await open(m);
  await setAmount(page, "0.1");
  await waitText(page, "You get about");
  const n0 = txPosts.length;
  await page.locator(`button${T("Buy OKO")}:not([disabled])`).click();
  await sleep(150);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitText(page, "Graduation");
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/C-after-reload.png` });
  const body = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  const d1 = await settle(m);
  log("C spent SOL", (Number(d0.holdings.sol) - Number(d1.holdings.sol)).toFixed(6), "my new trades", mine(d1).length - mine(d0).length, "api POSTs", txPosts.slice(n0));
  log("C page text after reload:", body.replace(/\n+/g, " | ").slice(0, 700));
}
await browser.close();
