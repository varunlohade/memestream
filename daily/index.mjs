/**
 * memestream daily stream job (a Railway cron job): one run a day. Settings (see README.md):
 *   DAILY_SITE_URL      the devnet site, an https origin, e.g. https://www.memestream.lol
 *   DAILY_RPC_URL       a devnet RPC (https); its genesis hash must be devnet's
 *   DAILY_STREAMER_KEY  base58 secret key of the devnet-only streamer wallet (never logged)
 *   DAILY_DRY_RUN=1     every check, then print what it would do: no transaction, no sign-in
 */
import { runDaily } from "./job.mjs";

process.exitCode = await runDaily({ env: process.env });
