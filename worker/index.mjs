/**
 * memestream worker (Railway): keeps the predictions clock running with nobody watching. Every
 * minute it calls the site's tick route (frame grabs and the AI referee) and, if set, the markets
 * close-due route. Settings come from the environment:
 *   MEMESTREAM_TICK_URL       e.g. https://www.memestream.lol/api/predictions/tick (required)
 *   MEMESTREAM_CLOSE_DUE_URL  e.g. https://www.memestream.lol/api/markets/close-due (optional)
 *   MEMESTREAM_CRON_SECRET    the site's cron secret, 32+ characters (required; never logged)
 */
import { runLoop } from "./loop.mjs";

const { MEMESTREAM_TICK_URL, MEMESTREAM_CLOSE_DUE_URL, MEMESTREAM_CRON_SECRET } = process.env;
const MIN_SECRET_CHARS = 32;

if (!MEMESTREAM_TICK_URL || !/^https?:\/\//.test(MEMESTREAM_TICK_URL)) {
  console.error("Set MEMESTREAM_TICK_URL to the site's /api/predictions/tick URL");
  process.exit(1);
}
if (!MEMESTREAM_CRON_SECRET || MEMESTREAM_CRON_SECRET.length < MIN_SECRET_CHARS) {
  console.error(`Set MEMESTREAM_CRON_SECRET (${MIN_SECRET_CHARS}+ characters, the same as the site's)`);
  process.exit(1);
}

const targets = [{ name: "tick", url: MEMESTREAM_TICK_URL }];
if (MEMESTREAM_CLOSE_DUE_URL) targets.push({ name: "close-due", url: MEMESTREAM_CLOSE_DUE_URL });

const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stop.abort());

console.log(`worker: ${targets.map((t) => t.name).join(" + ")} every 60s`);
await runLoop({ targets, secret: MEMESTREAM_CRON_SECRET, signal: stop.signal });
console.log("worker: stopped");
