# memestream worker (Railway)

The site needs a call every minute so the AI referee grabs stream frames and decides results when
nobody watches a coin. Vercel's Hobby plan only runs cron jobs once a day, so this small worker does
it instead. It runs forever. Every 60 s it sends a POST to the tick route, and to the markets
close-due route if you set one. It uses the cron secret as a bearer token.

- Each route has its own loop: a slow or failing close-due never delays the tick.
- One call at a time per route: the next starts only after the last one ends.
- Each call waits a little longer than its route may run: 130 s for the tick, 305 s for close-due.
- After a failed call that route waits longer: 2, 4, 8, then at most 10 minutes. One good call resets it.
- Both URLs must be https and on the same host. Redirects are refused, so the secret only goes there.
- It logs one line per call: the name, the status and the time taken. It never logs the secret.

No npm dependencies. Node 22. The Dockerfile starts from `node:22-slim`.

The video grabber (`../grabber/`) is a second service in the same Railway project, with its own
secret. It cuts short clips for the AI referee; see [its README](../grabber/README.md).

## Settings

| Name | Value |
|---|---|
| `MEMESTREAM_TICK_URL` | `https://www.memestream.lol/api/predictions/tick` |
| `MEMESTREAM_CRON_SECRET` | the same value as the site's `MEMESTREAM_CRON_SECRET` in Vercel (32+ characters) |
| `MEMESTREAM_CLOSE_DUE_URL` | optional: `https://www.memestream.lol/api/markets/close-due` (only does work with `MEMESTREAM_MARKETS=1`) |

The site must have `MEMESTREAM_CRON_SECRET` set. If it is unset or short, both routes answer 404.

## Deploy (run these yourself, from this folder)

```sh
cd worker
npm i -g @railway/cli        # once
railway login
railway init                 # a new project, e.g. "memestream-worker" (or: railway link, for an existing one)
railway add --service memestream-worker      # an empty service, so the variables go in before the first start
railway variables --service memestream-worker --set "MEMESTREAM_TICK_URL=https://www.memestream.lol/api/predictions/tick"
railway variables --service memestream-worker --set "MEMESTREAM_CRON_SECRET=<paste the site's secret>"
railway variables --service memestream-worker --set "MEMESTREAM_CLOSE_DUE_URL=https://www.memestream.lol/api/markets/close-due"   # optional
railway up --service memestream-worker       # builds the Dockerfile and starts it
railway logs --service memestream-worker     # expect "tick 200 …ms" once a minute
```

Type the secret only into the `railway variables` command. Never commit it or paste it into chat.
`railway.json` tells Railway to build with the Dockerfile, run 1 replica and always restart.

## Test

```sh
npm test        # from worker/; or npm run test:worker from the repo root (part of npm run check)
```
