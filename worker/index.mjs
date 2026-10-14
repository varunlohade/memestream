/**
 * memestream worker (Railway): keeps the predictions clock running with nobody watching. Every
 * minute it calls the site's tick route (frame grabs, the AI referee, results that count) and, if
 * set, the markets close-due route, each on its own schedule. Settings come from the environment:
 *   MEMESTREAM_TICK_URL       e.g. https://www.memestream.lol/api/predictions/tick (required, https)
 *   MEMESTREAM_CLOSE_DUE_URL  e.g. https://www.memestream.lol/api/markets/close-due (optional, same host)
 *   MEMESTREAM_CRON_SECRET    the site's cron secret, 32+ characters (required; never logged)
 */
import { runLoops, targetsFrom } from "./loop.mjs";

const { MEMESTREAM_TICK_URL, MEMESTREAM_CLOSE_DUE_URL, MEMESTREAM_CRON_SECRET } = process.env;
const MIN_SECRET_CHARS = 32;

let targets;
try {
  targets = targetsFrom(MEMESTREAM_TICK_URL, MEMESTREAM_CLOSE_DUE_URL);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (!MEMESTREAM_CRON_SECRET || MEMESTREAM_CRON_SECRET.length < MIN_SECRET_CHARS) {
  console.error(`Set MEMESTREAM_CRON_SECRET (${MIN_SECRET_CHARS}+ characters, the same as the site's)`);
  process.exit(1);
}

const stop = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stop.abort());

console.log(`worker: ${targets.map((t) => t.name).join(" + ")}, each every 60s`);
await runLoops({ targets, secret: MEMESTREAM_CRON_SECRET, signal: stop.signal });
console.log("worker: stopped");
