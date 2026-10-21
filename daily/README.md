# memestream daily stream job (Railway cron)

Once a day, our own streamer wallet launches a coin on a 24/7 YouTube live cam on the **devnet**
site. Then it asks 2-3 yes/no questions that the AI referee can check from the stream picture.
This is our own content. It is not user traction: leave the streamer wallet out of every
traction count (see "Traction" below).

One run is one day:

1. Checks the settings: the site URL must be an https origin and the RPC URL must be https.
2. Stops unless the RPC's genesis hash is devnet's.
3. Stops unless the site's own page says devnet: the wallet chain `solana:devnet` in its page data
   and the "Devnet" badge. Any mention of `solana:mainnet` stops it. If `DAILY_SITE_URL`
   redirects (e.g. apex to www), it follows that redirect once and checks the new host.
4. Reads the server's own public URL (`MEMESTREAM_PUBLIC_URL`) from a coin's metadata
   (`external_url`). It sends that URL as the Origin header and signs in with its domain, as the
   site's routes require. If the URL differs from `DAILY_SITE_URL`, the log says so.
5. Looks for today's (UTC) daily coin in the site's coin list and on the chain. On the chain, any
   successful transaction the streamer paid for today counts. It pages back through the
   streamer's signatures to yesterday, up to 500 of them. If it can't get back that far, it
   stops. If today's coin exists, it never launches again. It resumes instead: it signs in and
   asks only the missing questions (step 9). So a run that stopped part way, a retry, or a coin
   hidden from the lists never leads to a second launch.
6. Checks the balance (0.05 SOL plus the config's launch fee).
7. Picks today's cam. The list rotates one step per UTC day, counted from 2026-10-01. It skips a
   cam that isn't live now. To tell, it reads the `isLiveNow` flag on the YouTube watch page,
   following redirects such as consent pages. If the page doesn't say, it logs "could not tell"
   and skips that cam too. (The `hqdefault_live.jpg` preview picture is no use here: YouTube
   serves it for ended streams and ordinary videos too.)
8. Launches the coin through `/api/tx/launch`, the route the Go Live page uses, e.g.
   "Beach cam · Oct 22", `$BCH261022`. The ticker includes the year, so next year's coin never
   clashes. If a ticker is taken, it tries the next cam. Before signing, it checks that the
   streamer pays and that the transaction uses the devnet config
   `Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg`. It waits for the site to confirm the
   transaction. If the transaction expires, it asks the chain once, then stops if the transaction
   did not land.
9. Signs in to predictions (a signed message, no transaction). It counts the coin's questions:
   live, done, and any still under review, which it waits for. Then it asks the cam's other
   questions one at a time. Each one goes through the normal AI review, which picks the betting
   window. If the review rejects a question, it tries the next one. It stops once 3 are live.

Network errors and 5xx answers are retried 3 times (2, 4, then 8 s apart). This covers the
status poll, the sign-in (with a new signed message each try) and the question posts.

It never bets, trades or resolves. The AI referee decides results, as on any coin. Each step logs
one line. The key is never logged, and neither is the RPC URL (only its host).

**Devnet cost per day:** the launch needs about 0.05 devnet SOL from the streamer wallet. Each
question that goes live also makes the site's markets oracle create a devnet prediction market. The
oracle wallet seeds each market with 0.05 devnet SOL (`MEMESTREAM_MARKET_SEED_SOL`, when markets
are on). So 3 questions take about 0.15 devnet SOL a day from the oracle wallet. Keep it funded too.

Exit code 0: done, or already done today. Exit code 1: a check failed, or fewer than 2 questions
are live or done.

The cams are in `streams.mjs`: Koh Phangan beach, Heathrow, Jackson Hole town square, the Namib
desert waterhole and Shinjuku. All five were live on 2026-10-21 (`yt-dlp -F`). To add a cam, give
it a ticker prefix (4 characters at most) and 3 or more questions about things the camera clearly
shows. `npm run test:daily` checks them against the app's own rules.

No npm dependencies. It uses plain `fetch`, `node:crypto` ed25519 and JSON-RPC, so the image is
just `node:22-slim` plus four small files. The tests import the app's own code from `src/lib`
(stream links, tickers, question rules, the sign-in message), so the job can't drift from the app
without `npm run check` failing.

## Settings

| Name | Value |
|---|---|
| `DAILY_SITE_URL` | `https://www.memestream.lol` now; `https://devnet.memestream.lol` once mainnet takes the main domain |
| `DAILY_RPC_URL` | a devnet RPC, e.g. `https://api.devnet.solana.com` or a Helius devnet URL |
| `DAILY_STREAMER_KEY` | base58 secret key of the devnet-only streamer wallet (never logged) |
| `DAILY_DRY_RUN` | optional: `1` runs every check and prints what it would do. It sends no transaction and does not sign in. |

## The streamer wallet (devnet only)

Make a new wallet for this job only. Never use it on mainnet, and never commit it.

```sh
solana-keygen new --no-bip39-passphrase -o ~/memestream-daily-streamer.json   # outside the repo
solana address -k ~/memestream-daily-streamer.json                            # its public address
```

Fund it with devnet SOL: `solana airdrop 1 <address> --url devnet`, or use
https://faucet.solana.com. The job needs at least 0.05 SOL in the wallet before each launch. The
devnet config's launch fee is 0 SOL today (`GET /api/launch-fee`). Most of the cost is rent for
the new mint, pool and metadata, plus fees. 1 SOL lasts many days. Check the balance in the
`balance:` log line.

`DAILY_STREAMER_KEY` takes the base58 form. Never put the key on a command line: other processes
and the shell history can read it there. Never paste it into chat. This writes it to a file
(run from `daily/`):

```sh
node --input-type=module -e 'import { base58Encode } from "./solana.mjs"; import { readFileSync } from "node:fs"; process.stdout.write(base58Encode(Uint8Array.from(JSON.parse(readFileSync(process.argv[1], "utf8")))))' ~/memestream-daily-streamer.json > ~/memestream-daily-streamer.b58
chmod 600 ~/memestream-daily-streamer.b58
```

Open the file, copy the key, and paste it as `DAILY_STREAMER_KEY` in the service's Variables tab
in the Railway dashboard. Then delete the `.b58` file: `rm ~/memestream-daily-streamer.b58`.

## Deploy (run these yourself, from this folder)

The job is a service in your private Railway project.

```sh
cd daily
railway link                                   # your project
railway add --service memestream-daily          # an empty service, so the variables go in first
railway variables --service memestream-daily --set "DAILY_SITE_URL=https://www.memestream.lol"
railway variables --service memestream-daily --set "DAILY_RPC_URL=https://api.devnet.solana.com"
# DAILY_STREAMER_KEY: paste it in the dashboard (see above), not here
railway variables --service memestream-daily --set "DAILY_DRY_RUN=1"   # first run: checks only
railway up --service memestream-daily
railway logs --service memestream-daily         # after the first run: every check line, then "dry run: ..."
railway variables --service memestream-daily --set "DAILY_DRY_RUN=0"   # then the real daily runs
```

If `DAILY_RPC_URL` holds an API key (e.g. a Helius devnet URL), paste it in the dashboard too.

`railway.json` builds the Dockerfile and runs the job on the cron schedule `0 9 * * *` (09:00 UTC,
14:30 IST) with restart policy NEVER. A failed run waits for the next day. A run on the same day
resumes the questions instead of launching again. To run it now, use "Run now" on the service in
the Railway dashboard.

## Traction

Each daily coin is ours. Leave the streamer wallet's coins out of the traction numbers in the main
README. Adding the wallet to the site's `MEMESTREAM_HIDDEN_CREATORS` would also hide the coins from
the home page and the tape, and the coins are there to be seen. The job would still find a hidden coin
through the chain check.

## Test

```sh
npm run test:daily   # from the repo root (part of npm run check); uses tsx for the src/lib contract tests
```
