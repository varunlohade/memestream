/**
 * memestream video grabber (Railway): cuts short clips of live streams for the site's AI referee.
 * Settings come from the environment:
 *   GRABBER_SECRET     the shared secret, 32+ characters (required: without it every clip is refused; never logged)
 *   YTDLP_COOKIES_B64  optional: a base64 cookies.txt for yt-dlp, when YouTube asks the server to sign in
 *   PORT               set by Railway (default 8080)
 */
import { createServer } from "node:http";
import { createHandler, MIN_SECRET_CHARS, secretUsable } from "./grab.mjs";

const { GRABBER_SECRET, YTDLP_COOKIES_B64, PORT = "8080" } = process.env;
if (!secretUsable(GRABBER_SECRET)) console.error(`GRABBER_SECRET is unset or under ${MIN_SECRET_CHARS} characters: every clip is refused`);

const server = createServer(createHandler({ secret: GRABBER_SECRET, cookiesB64: YTDLP_COOKIES_B64 || null }));
server.listen(Number(PORT), () => console.log(`grabber: listening on ${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
