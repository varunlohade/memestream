// Screenshot pages of the running local app: tsx scripts/shot.mts <path> <out.png> [width] [height]
import puppeteer from "puppeteer-core";
import { sleep } from "../src/lib/poll";
import { blockThirdParty, CHROME_PATH, LOCAL_APP } from "./browser";
const [path, out, width = "1440", height = "1080"] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  protocolTimeout: 60_000,
  args: ["--hide-scrollbars", "--mute-audio"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(width), height: Number(height) });
  page.on("pageerror", (e) => console.error("pageerror:", (e as Error).message));
  await blockThirdParty(page);
  await page.goto(`${LOCAL_APP}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(6_000);
  await page.screenshot({ path: out as `${string}.png` });
  console.log("saved", out);
} finally {
  await browser.close();
}
