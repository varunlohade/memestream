// Home and coin page at 1440 desktop and 390 phone. Usage: tsx shots.mts <base url> <out dir>
import puppeteer from "puppeteer-core";
const [BASE = "http://127.0.0.1:3100", OUT = "."] = process.argv.slice(2);
const COIN = "8W6q3qacNm6qvczMAu4xRm2JiVswmgT6uhz6eo3bgTqh";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--mute-audio"] });
try {
  for (const [name, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR", (e as Error).message));
    await page.setViewport({ width, height });
    for (const [label, path, ready] of [["home", "/", ".card"], ["coin", `/coin/${COIN}`, ".holder-list"]] as const) {
      await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
      await page.waitForSelector(ready, { timeout: 30_000 }).catch(() => console.log(`no ${ready} on ${label}`));
      await new Promise((r) => setTimeout(r, 1500));
      // A string, so tsx's name helpers don't leak into the page.
      const m = await page.evaluate(`(() => {
        const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
        return { scrollW: document.documentElement.scrollWidth, stream: r(".embed"), chart: r(".cp-chart"), trade: r(".cp-trade"), holders: r(".cp-holders"), king: r(".koth"), card: r(".card") };
      })()`);
      console.log(name, label, JSON.stringify(m));
      await page.screenshot({ path: `${OUT}/pump-${label}-${name}.png`, fullPage: true });
    }
    if (name === "desktop") {
      // Search from the coin page: typing goes to the board, which filters by ticker or name.
      await page.type(".search", "newss");
      await page.waitForSelector(".card", { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 1000));
      console.log("search 'newss' cards:", await page.$$eval(".card h4", (h) => h.map((x) => x.textContent)));
      await page.click("::-p-text(about to graduate)");
      console.log("about to graduate + search:", await page.$$eval(".card h4", (h) => h.map((x) => x.textContent)));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
