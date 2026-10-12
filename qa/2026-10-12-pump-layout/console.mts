// Loads pages and prints console errors (hydration mismatches show here in a dev build). Usage: tsx console.mts <base url> <path>...
import puppeteer from "puppeteer-core";
const [BASE, ...PATHS] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--mute-audio"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 400)));
  page.on("response", (r) => r.status() >= 400 && console.log("HTTP", r.status(), r.url().slice(0, 160)));
  page.on("pageerror", (e) => console.log("PAGEERROR", (e as Error).message.slice(0, 400)));
  for (const path of PATHS) {
    console.log("---", path);
    await page.goto(BASE + path, { waitUntil: "networkidle2", timeout: 120_000 }).catch((e) => console.log("goto", (e as Error).message));
    await new Promise((r) => setTimeout(r, 4000));
    console.log("scrollWidth", await page.evaluate("document.documentElement.scrollWidth"));
  }
} finally {
  await browser.close();
}
