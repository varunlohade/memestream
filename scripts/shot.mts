// Screenshot pages of the running local app: tsx scripts/shot.mts <path> <out.png> [width] [height]
import puppeteer from "puppeteer-core";
const [path, out, width = "1440", height = "1080"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  protocolTimeout: 60_000,
  args: ["--hide-scrollbars", "--mute-audio"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(width), height: Number(height) });
  page.on("pageerror", (e) => console.error("pageerror:", (e as Error).message));
  // Only our own app and Google Fonts: third-party embeds (Twitch etc.) stall headless capture.
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (["127.0.0.1", "localhost", "fonts.googleapis.com", "fonts.gstatic.com"].includes(host) || req.url().startsWith("data:")) req.continue();
    else req.abort();
  });
  await page.goto(`http://127.0.0.1:3000${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 6_000));
  await page.screenshot({ path: out as `${string}.png` });
  console.log("saved", out);
} finally {
  await browser.close();
}
