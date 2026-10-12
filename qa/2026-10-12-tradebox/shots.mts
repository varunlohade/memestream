// Trade box stills (buy and sell, desktop and 390px phone) from a local `next start`.
// A read-only "watch" wallet shows a real holder's balances; it can't sign anything.
// tsx qa/2026-10-12-tradebox/shots.mts <outDir> [baseUrl] [mint] [holder]
import puppeteer, { type Page } from "puppeteer-core";
import { blockThirdParty, CHROME_PATH } from "../../scripts/browser";
import { sleep } from "../../src/lib/poll";

const [outDir, base = "http://127.0.0.1:3417", mint = "7KcY7TxsgbHwTjqDzahTarybrMNGYNMNphAoTqaoLHKi", holder = "BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf"] =
  process.argv.slice(2);

function watchWallet(address: string) {
  const name = "QA watch wallet";
  const account = { address, publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: [] };
  const wallet = {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async () => {
          throw new Error("watch wallet: read-only");
        },
      },
    },
  };
  const register = (api: { register: (w: unknown) => void }) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => register((e as CustomEvent).detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  localStorage.setItem("memestream.wallet", name);
}

async function shoot(page: Page, file: string) {
  await sleep(2_500);
  const box = await page.$('section[aria-label="Trade"]');
  await box!.screenshot({ path: `${outDir}/${file}` as `${string}.png` });
  const overflow = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    wide: [...document.querySelectorAll('section[aria-label="Trade"] *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "hidden").map((el) => el.className || el.tagName),
  }));
  console.log(file, JSON.stringify(overflow));
  const widest = await page.evaluate(() =>
    [...document.querySelectorAll("body *")].filter((el) => !el.closest(".tape"))
      .map((el) => ({ el: `${el.tagName}.${el.className}`, right: Math.round(el.getBoundingClientRect().right) }))
      .filter((x) => x.right > 390)
      .slice(0, 8),
  );
  if (widest.length) console.log("  past 390px:", JSON.stringify(widest));
}

const clickText = (page: Page, text: string) =>
  page.evaluate((t) => {
    const buttons = [...document.querySelectorAll('section[aria-label="Trade"] button')];
    const button = buttons.find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
    if (!button) throw new Error(`no "${t}" button in: ${buttons.map((b) => b.textContent).join(" | ")}`);
    button.click();
  }, text);

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: ["--hide-scrollbars", "--mute-audio"] });
try {
  for (const [tag, width, mobile] of [["desktop", 1440, false], ["phone", 390, true]] as const) {
    const context = await browser.createBrowserContext(); // fresh storage per width
    const page = await context.newPage();
    await page.setViewport({ width, height: 1400, isMobile: false, hasTouch: mobile, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error("pageerror:", (e as Error).message));
    await blockThirdParty(page);
    await page.evaluateOnNewDocument("globalThis.__name = (f) => f"); // tsx's helper, missing in the page
    await page.evaluateOnNewDocument(watchWallet, holder);
    await page.goto(`${base}/coin/${mint}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector('section[aria-label="Trade"]', { timeout: 60_000 });
    await sleep(6_000);
    await shoot(page, `trade-buy-${tag}.png`);
    await clickText(page, "Sell");
    await clickText(page, "set max slippage");
    await sleep(300);
    await clickText(page, "1%");
    await sleep(300);
    // Reopen the chips to show them with the pick, as in mock A's sell panel.
    await clickText(page, "slippage: 1%");
    await clickText(page, "50%");
    await shoot(page, `trade-sell-${tag}.png`);
    await clickText(page, "switch to SOL");
    await shoot(page, `trade-sell-sol-${tag}.png`);
    await clickText(page, "Buy");
    await clickText(page, "switch to $FAKEMEDIA");
    await clickText(page, "10M");
    await shoot(page, `trade-buy-coin-${tag}.png`);
    await context.close();
  }
} finally {
  await browser.close();
}
