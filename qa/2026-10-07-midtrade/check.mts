// Tester driver (independent of scripts/mid-trade.mts). Counts charges ON-CHAIN:
// successful wallet transactions + SOL balance drop. Muted headless Chrome.
import puppeteer, { type Page } from "puppeteer-core";
const BASE = "http://127.0.0.1:3000";
const RPC = process.env.RPC!;
const OUT = "./qa/2026-10-07-midtrade";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method: string, params: unknown[]) =>
  ((await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: any }).result;
const wallet = ((await (await fetch(`${BASE}/api/dev-wallet`)).json()) as { address: string }).address;
const coins = ((await (await fetch(`${BASE}/api/coins`)).json()) as { coins: { mint: string; symbol: string }[] }).coins;
const sym = process.env.SYM ?? "SHIP";
const mint = coins.find((c) => c.symbol === sym)!.mint;
const okTx = async () => ((await rpc("getSignaturesForAddress", [wallet, { limit: 100 }])) as { err: unknown }[]).filter((s) => !s.err).length;
const allTx = async () => ((await rpc("getSignaturesForAddress", [wallet, { limit: 100 }])) as unknown[]).length;
const bal = async () => (await rpc("getBalance", [wallet])).value / 1e9;
const snap = async () => ({ ok: await okTx(), all: await allTx(), sol: await bal() });

const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--mute-audio"] });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function newPage() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 1100 });
  await p.setRequestInterception(true);
  p.on("request", (r) => (["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(new URL(r.url()).hostname) || r.url().startsWith("data:") ? r.continue() : r.abort()));
  return p;
}
const text = (p: Page) => p.evaluate(() => document.body.innerText);
const waitText = (p: Page, t: string, timeout = 60_000) => p.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, t);
const shot = (p: Page, n: string) => p.screenshot({ path: `${OUT}/${n}.png` as `${string}.png` });
const buyEnabled = (p: Page) => p.evaluate((s) => [...document.querySelectorAll("button")].some((b) => b.innerText.includes(`Buy ${s}`) && !b.disabled), sym);
const clickBuyRaw = (p: Page) => p.evaluate((s) => { const b = [...document.querySelectorAll("button")].filter((b) => b.innerText.includes(`Buy ${s}`)).pop() as HTMLButtonElement | undefined; b?.click(); return b ? (b.disabled ? "disabled" : "enabled") : "none"; }, sym);
async function waitIdle(p: Page, ms = 60_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await buyEnabled(p)) return true; await sleep(500); } return false; }
async function openCoin(p: Page) { await p.goto(`${BASE}/coin/${mint}`, { waitUntil: "domcontentloaded" }); await waitText(p, "Graduation"); await sleep(1500); const i = await p.$("input[inputmode=decimal]"); if (i) { await i.click({ clickCount: 3 }); await i.type("0.05"); } await sleep(500); }
const res: string[] = [];
const report = (name: string, b: Awaited<ReturnType<typeof snap>>, a: Awaited<ReturnType<typeof snap>>, expect = 1) => {
  const d = a.ok - b.ok; const line = `${d === expect ? "PASS" : "FAIL"} ${name}: on-chain ok tx +${d} (all +${a.all - b.all}), SOL ${(a.sol - b.sol).toFixed(4)}`; res.push(line); log(line);
};
try {
  const a = await newPage();
  await a.goto(BASE, { waitUntil: "domcontentloaded" });
  await a.locator("::-p-text(Connect)").click();
  await a.locator("::-p-text(Test wallet (localhost))").click();
  await sleep(1500);
  await openCoin(a);
  await shot(a, "00-coin");

  // 1. main path: buy once, wait; then buy again (not stuck)
  let b = await snap();
  log("click 1:", await clickBuyRaw(a)); await sleep(2500); await shot(a, "01-pending"); log("pending text:", (await text(a)).match(/(Confirming|Trading is paused|in progress)[^\n]*/)?.[0]);
  log("idle after main:", await waitIdle(a, 60_000)); await sleep(3000); await shot(a, "02-done");
  report("1 main buy", b, await snap());
  b = await snap(); log("buy again:", await clickBuyRaw(a)); await waitIdle(a); await sleep(3000);
  report("1b second buy right after (not stuck)", b, await snap());

  // 2. reload mid-trade, then hammer Buy after reload
  b = await snap(); log("click:", await clickBuyRaw(a)); await sleep(3000);
  await a.reload({ waitUntil: "domcontentloaded" }); await waitText(a, "Graduation"); await sleep(2000); await shot(a, "03-after-reload");
  log("after reload buy:", await clickBuyRaw(a), await clickBuyRaw(a));
  log("idle after reload:", await waitIdle(a, 60_000)); await sleep(3000); await shot(a, "04-reload-done");
  log("reload end text:", (await text(a)).match(/(went through|Bought|check your wallet|unlock)[^\n]*/)?.[0]);
  report("2 reload mid-trade", b, await snap());

  // 3. second tab mid-trade: try to buy in tab B, then B can trade after
  b = await snap(); log("click A:", await clickBuyRaw(a)); await sleep(2500);
  const t2 = await newPage(); await openCoin(t2); await shot(t2, "05-tab2-midtrade");
  log("tab2 buy:", await clickBuyRaw(t2), "lock msg:", (await text(t2)).match(/[^\n]*(another tab|in progress|paused)[^\n]*/)?.[0]);
  await a.bringToFront(); log("idle A:", await waitIdle(a, 60_000)); await sleep(3000);
  report("3 second tab mid-trade", b, await snap());
  await t2.bringToFront(); log("tab2 idle w/o reload:", await waitIdle(t2, 15_000)); await shot(t2, "06-tab2-after");
  b = await snap(); log("tab2 buy after:", await clickBuyRaw(t2)); await waitIdle(t2, 60_000); await sleep(3000);
  report("3b second tab trades after first finishes", b, await snap());
  await t2.close();

  // 4. triple click
  await a.bringToFront(); await openCoin(a);
  b = await snap(); await a.evaluate((s) => { const btn = [...document.querySelectorAll("button")].filter((x) => x.innerText.includes(`Buy ${s}`)).pop() as HTMLButtonElement; btn.click(); btn.click(); btn.click(); }, sym);
  await sleep(2000); log("extra clicks:", await clickBuyRaw(a), await clickBuyRaw(a)); await shot(a, "07-triple");
  log("idle:", await waitIdle(a, 60_000)); await sleep(3000); await shot(a, "08-triple-done");
  report("4 triple click + 2 more clicks mid-trade", b, await snap());
} catch (e) {
  res.push(`ERROR ${(e as Error).message.split("\n")[0]}`); log("ERROR", (e as Error).message);
  for (const [i, p] of (await browser.pages()).entries()) { await shot(p, `err-tab${i}`).catch(() => {}); log(`tab${i}:`, (await text(p).catch(() => "")).slice(0, 500).replace(/\n+/g, " | ")); }
} finally { await browser.close().catch(() => {}); }
console.log("\n" + res.join("\n"));
