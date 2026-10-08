/** Shared setup for the headless-Chrome scripts that drive the local app (e2e, mid-trade, shot). */
import type { Page } from "puppeteer-core";

/** Where npm run dev serves the app (it binds 127.0.0.1). */
export const LOCAL_APP = "http://127.0.0.1:3000";
export const CHROME_PATH = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ALLOWED_HOSTS = ["127.0.0.1", "localhost", "fonts.googleapis.com", "fonts.gstatic.com"];

/** Loads only our own app and Google Fonts: third-party embeds (Twitch etc.) stall headless capture. */
export async function blockThirdParty(page: Page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (ALLOWED_HOSTS.includes(new URL(req.url()).hostname) || req.url().startsWith("data:")) req.continue();
    else req.abort();
  });
}

/** Replaces the trade box amount with `value`, as a user would type it. */
export async function typeAmount(page: Page, value: string) {
  const input = await page.waitForSelector('input[aria-label^="Amount in"]');
  await input!.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input!.type(value);
}
