/**
 * Clicks through the running local app like a user, with the localhost test wallet.
 * Needs: npm run dev:chain (fresh: $LOFI must still be trading), then npm run dev.
 * Run: npx tsx scripts/e2e.mts   (CHROME_PATH overrides the macOS Chrome path)
 * Saves a screenshot per step in design/build/e2e/.
 */
import { mkdirSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";

const BASE = "http://127.0.0.1:3000";
const OUT = process.env.E2E_OUT ?? "design/build/e2e";
mkdirSync(OUT, { recursive: true });

/** Fails fast with a clear message instead of a run of confusing FAILs. */
async function preflight() {
  const fail = (why: string) => {
    console.error(`e2e preflight: ${why}`);
    process.exit(2);
  };
  const coins = await fetch(`${BASE}/api/coins`).catch(() => null);
  if (!coins?.ok) fail(`no app at ${BASE}. Run: npm run dev:chain, then npm run dev`);
  if (!(await fetch(`${BASE}/api/dev-wallet`)).ok) fail("test wallet is off. Is .env.local from dev:chain, and is the app on 127.0.0.1:3000?");
  const { coins: list } = (await coins!.json()) as { coins: { symbol: string; mint: string }[] };
  const lofi = list.find((c) => c.symbol === "LOFI");
  // The list is cached for a few seconds, so read LOFI's live status from its own route.
  const live = lofi && ((await (await fetch(`${BASE}/api/coins/${lofi.mint}`)).json()) as { coin: { status: string } });
  if (live?.coin.status !== "trading") fail("$LOFI isn't trading. Restart npm run dev:chain for a fresh chain");
}
await preflight();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  protocolTimeout: 60_000,
  args: ["--hide-scrollbars", "--mute-audio"],
});
process.on("exit", () => void browser.process()?.kill());
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1240 });
await page.setRequestInterception(true);
page.on("request", (req) => {
  const host = new URL(req.url()).hostname;
  if (["127.0.0.1", "localhost", "fonts.googleapis.com", "fonts.gstatic.com"].includes(host) || req.url().startsWith("data:")) req.continue();
  else req.abort(); // third-party embeds stall headless capture
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push((e as Error).message));

// Dev mode compiles each page on first visit and can full-reload the open page while doing so.
// Visit every route once first, so the clicks below run against compiled pages.
for (const path of ["/", "/go-live", "/coin/11111111111111111111111111111111", "/api/coins"]) await fetch(`${BASE}${path}`);
await new Promise((r) => setTimeout(r, 3_000));

let stepNo = 0;
const results: { step: string; ok: boolean | "skipped"; note?: string }[] = [];
/** Steps depend on each other, so after the first failure the rest are skipped, not failed. */
async function step(name: string, fn: (p: Page) => Promise<string | void>) {
  stepNo++;
  if (results.some((r) => r.ok === false)) {
    results.push({ step: name, ok: "skipped" });
    return;
  }
  try {
    const note = await fn(page);
    results.push({ step: name, ok: true, note: note ?? undefined });
  } catch (e) {
    results.push({ step: name, ok: false, note: (e as Error).message.split("\n")[0] });
  }
  await page.screenshot({ path: `${OUT}/${String(stepNo).padStart(2, "0")}.png` }).catch(() => {});
}

const text = (t: string) => `::-p-text(${t})`;
const click = (p: Page, t: string) => p.locator(text(t)).setTimeout(20_000).click();
/** Toggle buttons by aria-pressed, so "Buy" doesn't match a "Buy" row in the trade list. */
const clickTab = (p: Page, t: string) => p.locator(`button[aria-pressed]${text(t)}`).setTimeout(20_000).click();
const waitText = (p: Page, t: string, timeout = 30_000) =>
  p.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, t);
async function typeInto(p: Page, placeholder: string, value: string) {
  const input = await p.waitForSelector(`input[placeholder="${placeholder}"]`, { timeout: 15_000 });
  await input!.click({ clickCount: 3 });
  await input!.type(value);
}
async function setAmount(p: Page, value: string) {
  const input = await p.waitForSelector('input[aria-label^="Amount in"]');
  await input!.click({ clickCount: 3 });
  await p.keyboard.press("Backspace");
  await input!.type(value);
}
/* Chain-state checks: read our own API, so a step passes when the trade lands, not when text shows. */
type Detail = { coin: { mint: string; status: string; streamerUnclaimedSol: string }; holdings: { coins: string; sol: string } | null };
const devWallet = (await (await fetch(`${BASE}/api/dev-wallet`)).json()) as { address: string };
async function mintOf(ticker: string): Promise<string> {
  const { coins } = (await (await fetch(`${BASE}/api/coins`)).json()) as { coins: { mint: string; symbol: string }[] };
  const coin = coins.find((c) => c.symbol === ticker);
  if (!coin) throw new Error(`$${ticker} not listed`);
  return coin.mint;
}
const detail = async (mint: string) => (await (await fetch(`${BASE}/api/coins/${mint}?wallet=${devWallet.address}`)).json()) as Detail;
/** Polls the chain (via our API) until `done` holds, up to `timeoutMs`. */
async function waitForChain(mint: string, what: string, done: (d: Detail) => boolean, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(await detail(mint))) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`chain never showed: ${what}`);
}
const held = (d: Detail) => Number(d.holdings?.coins ?? 0);

async function openCoin(p: Page, ticker: string) {
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await click(p, `$${ticker}`);
  await waitText(p, "Graduation");
}

await step("home lists the seeded coins", async (p) => {
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  for (const t of ["$LOFI", "$SYNTH", "$NASA", "$DEV"]) await waitText(p, t);
});

await step("connect the localhost test wallet", async (p) => {
  await click(p, "Connect");  // opens the wallet menu
  await click(p, "Test wallet (localhost)");
  await p.waitForFunction(() => !document.querySelector(".wallet")?.textContent?.includes("Connect"), { timeout: 15_000 });
});

await step("streamer launches a coin from Go live", async (p) => {
  await click(p, "Go live");
  await typeInto(p, "Ranked till Diamond", "E2E launch stream");
  await typeInto(p, "$MIRA", "E2E");
  await typeInto(p, "YouTube or Twitch live link", "https://www.youtube.com/watch?v=M3HKLzjvKPc");
  await click(p, "Launch coin");
  await p.waitForFunction(() => location.pathname.startsWith("/coin/"), { timeout: 120_000 });
  await waitText(p, "$E2E");
  return p.url();
});

await step("streamer can't buy their own coin", async (p) => {
  await waitText(p, "Streamers can't buy their own coin here");
});

await step("viewer buys 0.5 SOL of $LOFI", async (p) => {
  const mint = await mintOf("LOFI");
  const before = held(await detail(mint));
  await openCoin(p, "LOFI");
  await setAmount(p, "0.5");
  await waitText(p, "You get about");
  await p.locator(`button${text("Buy LOFI")}:not([disabled])`).setTimeout(20_000).click();
  await waitForChain(mint, "LOFI balance went up", (d) => held(d) > before);
});

await step("viewer sells half their $LOFI with the 50% chip", async (p) => {
  const mint = await mintOf("LOFI");
  const before = held(await detail(mint));
  await clickTab(p, "Sell");
  await click(p, "50%");
  await p.locator(`button${text("Sell LOFI")}:not([disabled])`).setTimeout(20_000).click();
  await waitForChain(mint, "LOFI balance went down", (d) => held(d) < before);
});

await step("an oversized buy is shown as a partial fill, then fills the curve", async (p) => {
  const mint = await mintOf("LOFI");
  await clickTab(p, "Buy");
  await setAmount(p, "3");
  await waitText(p, "This fills the curve");
  await p.locator(`button${text("Buy LOFI")}:not([disabled])`).setTimeout(20_000).click();
  await waitForChain(mint, "LOFI curve full", (d) => d.coin.status === "graduating");
});

await step("anyone graduates the coin to Meteora", async (p) => {
  const mint = await mintOf("LOFI");
  await click(p, "Graduate to Meteora");
  await waitForChain(mint, "LOFI graduated", (d) => d.coin.status === "graduated");
});

await step("streamer claims earnings on their own coin", async (p) => {
  const mint = await mintOf("DEV");
  await openCoin(p, "DEV");
  await waitText(p, "Your earnings");
  await click(p, "Claim earnings");
  await waitForChain(mint, "DEV earnings claimed", (d) => Number(d.coin.streamerUnclaimedSol) === 0);
});

await browser.close().catch(() => {});
for (const r of results) {
  const label = r.ok === "skipped" ? "SKIP" : r.ok ? "PASS" : "FAIL";
  console.log(`${label}  ${r.step}${r.note ? `  (${r.note})` : ""}`);
}
if (errors.length) console.log(`page errors:\n  ${[...new Set(errors)].join("\n  ")}`);
process.exit(results.every((r) => r.ok === true) ? 0 : 1);
