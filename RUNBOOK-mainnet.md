# Mainnet runbook

Do these steps in order. Each step says what to run and what to check.
Never paste a secret value into a chat, a commit or a file in this repo.

The plan:
- The Vercel project `memestream` becomes **mainnet** on https://www.memestream.lol.
- A new Vercel project `memestream-devnet` serves **devnet** on https://devnet.memestream.lol.
- https://memestream-iota.vercel.app (the judges' link) redirects to the **devnet** site, never to
  mainnet. `next.config.ts` sends it to `MEMESTREAM_LEGACY_REDIRECT` (default
  https://devnet.memestream.lol). Never remove this redirect.
- Mainnet has coins and free-points predictions. Real-SOL markets stay off (the code forces this).

## 0. Before you start

1. Merge branch `mainnet-launch` into `main` only after a fresh auditor reports it clean
   (MAINNET-CHECKLIST.md, "Process").
2. Get a paid mainnet RPC (Helius, QuickNode or Triton). Keep its URL secret: it holds the API key.
3. Put about 0.05 SOL on mainnet in the wallet that pays for the config (any wallet you hold a key
   file for). The config costs about 0.006 SOL.
4. Run `npm run check` in an up-to-date checkout of `main`. It must pass.
5. Check Git auto-deploy on the `memestream` project: Vercel dashboard > memestream > Settings > Git.
   If a repository is connected, every push to `main` deploys production. Before mainnet, turn it
   off, so only you deploy, after an audit:
   ```
   cd ~/chat-coins/.claude/worktrees/release-predictions
   vercel git disconnect
   ```
   (Or keep it connected and set Settings > Git > Ignored Build Step to `exit 0`.) Do the same check
   for `memestream-devnet` after you create it.

## 0b. Don't move the judges' link before devnet is ready

From this branch on, memestream-iota.vercel.app redirects to https://devnet.memestream.lol.
- Decision: the alias stays on the `memestream` project (it is that project's own vercel.app
  address). Leave `MEMESTREAM_LEGACY_REDIRECT` unset there; the default sends judges to devnet.
- In `memestream-devnet`, also leave it unset. That project never serves the iota host, so the
  redirect is inert there and can't loop. (The value can never point at the iota host itself; the
  build refuses it.)
- Order: create the devnet site (step 1) BEFORE you deploy this code to `memestream`. If you must
  deploy it to `memestream` while www is still devnet, first run
  `vercel env add MEMESTREAM_LEGACY_REDIRECT production` with `https://www.memestream.lol`, and
  remove it (`vercel env rm MEMESTREAM_LEGACY_REDIRECT production`) before the mainnet deploy.
- Check after every deploy of `memestream`:
  `curl -sI https://memestream-iota.vercel.app/ | grep -i location` must show
  `https://devnet.memestream.lol/`.

## 1. Move devnet to devnet.memestream.lol

Use a separate folder, so the mainnet folder stays linked to the `memestream` project.

```
git -C ~/chat-coins worktree add ~/memestream-devnet main
cd ~/memestream-devnet
vercel project add memestream-devnet
vercel link --yes --project memestream-devnet
vercel domains add devnet.memestream.lol memestream-devnet
```

### DNS on Namecheap

1. Namecheap > Domain List > memestream.lol > Manage > Advanced DNS.
2. Add a record:
   - Type: `CNAME Record`
   - Host: `devnet`
   - Value: the value Vercel shows for devnet.memestream.lol in the project's Domains page
     (usually `cname.vercel-dns.com.`)
   - TTL: Automatic
3. Don't touch the records for `@` and `www`.
4. Wait until the Vercel Domains page shows "Valid Configuration" for devnet.memestream.lol.

### Devnet env (names only; copy each value from the `memestream` project as it is today)

Run one command per name, in `~/memestream-devnet`, and paste the value when asked.
Add `--sensitive` to the secret ones if your Vercel CLI supports it.

```
vercel env add MEMESTREAM_PUBLIC_URL production        # https://devnet.memestream.lol (new value)
vercel env add MEMESTREAM_RPC_URL production           # secret: the devnet RPC
vercel env add MEMESTREAM_CONFIG production            # Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg
vercel env add MEMESTREAM_WALLET_CHAIN production      # solana:devnet
vercel env add MEMESTREAM_NETWORK_LABEL production     # Devnet
vercel env add MEMESTREAM_PREDICTIONS production       # 1
vercel env add MEMESTREAM_PREDICTIONS_SECRET production   # secret: same as today
vercel env add MEMESTREAM_MARKETS production           # 1
vercel env add MEMESTREAM_MARKET_ORACLE production
vercel env add MEMESTREAM_MARKET_ORACLE_KEY production     # secret
vercel env add MEMESTREAM_MARKET_SECRET production     # secret: EXACTLY today's value, or every devnet market is lost
vercel env add MEMESTREAM_MARKET_SEED_SOL production
vercel env add MEMESTREAM_CRON_SECRET production       # secret
vercel env add MEMESTREAM_ADMIN_WALLETS production
vercel env add MEMESTREAM_HIDDEN_CREATORS production
vercel env add MEMESTREAM_HIDDEN_MINTS production
vercel env add TYPESAFE_API_KEY production             # secret
vercel env add OPENROUTER_API_KEY production           # secret
```

Redis: in the Vercel dashboard, open Storage, and connect the existing Upstash database
"memestream-limits" to `memestream-devnet` (Production). This adds the `KV_*` variables and keeps
devnet's points and predictions.

Then deploy and check:

```
vercel deploy --prod --yes
```

- https://devnet.memestream.lol opens, shows "Devnet", lists the devnet coins.
- Wallet sign-in for predictions works there (it checks the devnet host now).
- Known side effect: old devnet coins have `https://www.memestream.lol/api/meta/<mint>` in their
  on-chain metadata. Once www is mainnet, wallets show no picture for those devnet coins. The site
  itself still works.

## 2. Create the mainnet config

Work in your mainnet folder (`~/chat-coins/.claude/worktrees/release-predictions`, on `main`).
The config can never change after it exists. Read every line of the dry run.

Dry run first (nothing is sent):

```
export MAINNET_RPC_URL='<your paid mainnet RPC URL>'    # only in this terminal; never commit it
npx tsx scripts/mainnet-config.mts --payer <path to the payer key file>
```

Check the printout:
- Fee claimer and leftover receiver: `BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf`.
- Quote token: SOL.
- Launch fee schedule: 50% at launch, 60 steps of 1 s, down to 1.00%.
- Volatility fee: on. Trading fee split: 80% to the streamer, 20% to memestream (after Meteora's 20%).
- Launch fee per coin: 0.05 SOL. Graduation: 3 SOL. Graduates to MET_DAMM_V2, pool fee FixedBps100.
- Graduated liquidity: streamer 100% locked, memestream 0%. Creator vesting: none.
- Simulation: OK.

The script saves the new config's key to `.keys/mainnet-config.json` (git-ignored). Keep that file
until the config exists. A second run reuses it, so the dry run and the send use the same address.

Then send:

```
npx tsx scripts/mainnet-config.mts --payer <path to the payer key file> --send
```

It asks you to type a phrase. Type it exactly. It prints the config address. Then:
1. Write the address in MAINNET-CHECKLIST.md ("After") and commit it.
2. Check it on https://solscan.io/account/<config address>.

## 3. Mainnet env on the `memestream` project

Run these in the mainnet folder (linked to `memestream`). For a name that already exists, remove it
first: `vercel env rm NAME production`, then add it again.

Set:

| Name | Value | Secret |
|---|---|---|
| `MEMESTREAM_PUBLIC_URL` | `https://www.memestream.lol` | no |
| `MEMESTREAM_RPC_URL` | the paid mainnet RPC URL | **yes** |
| `MEMESTREAM_CONFIG` | the config address from step 2 | no |
| `MEMESTREAM_WALLET_CHAIN` | `solana:mainnet` | no |
| `MEMESTREAM_NETWORK_LABEL` | `Mainnet` (the code forces it anyway) | no |
| `MEMESTREAM_PREDICTIONS` | `1` | no |
| `MEMESTREAM_PREDICTIONS_SECRET` | a NEW random value, 32+ characters (`openssl rand -hex 32`) | **yes** |
| `MEMESTREAM_ADMIN_WALLETS` | `BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf` | no |
| `MEMESTREAM_PRIORITY_FEE_MAX` | optional; default 1000000 micro-lamports per CU | no |
| `TYPESAFE_API_KEY` | as today | **yes** |
| `OPENROUTER_API_KEY` | as today | **yes** |
| `KV_*` | from a NEW Upstash database (below) | **yes** |

Remove (they must not exist on mainnet):

```
vercel env rm MEMESTREAM_MARKETS production
vercel env rm MEMESTREAM_MARKET_ORACLE production
vercel env rm MEMESTREAM_MARKET_ORACLE_KEY production
vercel env rm MEMESTREAM_MARKET_SECRET production
vercel env rm MEMESTREAM_MARKET_SEED_SOL production
vercel env rm MEMESTREAM_CRON_SECRET production
vercel env rm MEMESTREAM_HIDDEN_CREATORS production
vercel env rm MEMESTREAM_HIDDEN_MINTS production
vercel env rm MEMESTREAM_DEV_WALLET_KEY production
```

Hidden coins: start mainnet with no hidden lists. Never copy devnet's lists. Add a mainnet coin to
`MEMESTREAM_HIDDEN_MINTS` later only if you want it off the home page.

Redis: in Storage, create a new Upstash database (e.g. "memestream-mainnet") and connect it to
`memestream` (Production), then disconnect "memestream-limits" from `memestream`. Mainnet then
starts with clean points, limits and double-pay records.

If `MEMESTREAM_DEV_WALLET_KEY` is set, the mainnet build stops with "Unsafe memestream settings".
That is on purpose.

## 4. Deploy mainnet

```
git pull -q origin main
vercel deploy --prod --yes
```

Check:
- https://www.memestream.lol shows "Mainnet" in the top bar.
- https://memestream-iota.vercel.app redirects to https://devnet.memestream.lol (not www).
- The home page is empty (no coins yet), with no errors.
- A Solscan link opens without `?cluster=devnet`.

## 5. Smoke test (small amounts)

Use two wallets: A (the test streamer) and B (a viewer). The site won't let A buy its own coin.

1. As A: Go live. Launch a test coin. It costs 0.05 SOL plus rent. Check the tx on Solscan.
2. Wait at least 60 seconds. (The fee starts at 50% and falls to 1% over the first minute.)
3. As B: buy 0.01 SOL of the coin. Check it lands and the trade shows on the coin page.
4. As B: sell half. Check it lands.
5. As A: on the coin page, claim streamer earnings. Check SOL arrives.
6. As the owner (wallet BxfZ…): open https://www.memestream.lol/admin/fees.
   - Press the button to sign in. It shows about 0.045 SOL launch fee plus a little trading fee.
   - Press "Claim". Sign in the wallet. Check the SOL arrives.
   - Or claim from a terminal: `npx tsx scripts/claim-partner-fees.mts --config <config>`
     (dry run; add `--claimer <key file> --send` only if you hold the claimer's key file).
7. Optional graduation test: it needs about 3 SOL in the curve. Do it only if you accept that cost
   (most comes back if you sell after graduation, minus fees).
8. If you don't want the test coin on the home page, add its mint to `MEMESTREAM_HIDDEN_MINTS`
   and deploy.

Tick the boxes in MAINNET-CHECKLIST.md ("After").

## Rollback

**Never put a devnet build on www.** Every `memestream` deployment from before the mainnet deploy
is a devnet build. It keeps the env it was built with: markets on, the market oracle key, devnet
RPC and the old Redis. Promoting one would serve devnet on the mainnet domain and put the oracle
key back in a live build.

- **Right after the mainnet deploy works:** note its deployment URL as "first good mainnet". In
  Deployments, remove the older devnet production deployments of `memestream` (`vercel rm <url>`),
  or at least never promote one. The devnet site lives in `memestream-devnet` now.
- **Site problem, no money at risk:** promote the last good **mainnet** deployment only
  (`vercel rollback <mainnet-deployment-url>`, or Deployments > Promote). Check the top bar says
  "Mainnet" before and after.
- **No good mainnet deployment yet:** don't roll back to devnet. Fix forward: revert the bad
  commit on `main` and deploy again, or stop the damage by removing `MEMESTREAM_CONFIG` and
  deploying (the site then shows errors and builds no transactions) while you fix it.
- **After mainnet coins exist:** prefer a fix forward. Their metadata URI points at
  www.memestream.lol forever.
- **Bad config:** a config can't be changed or deleted. Create a new one with step 2 (remove
  `.keys/mainnet-config.json` first so it gets a new address), set `MEMESTREAM_CONFIG` to it, and
  deploy. Coins on the old config keep trading on chain, but the site lists only the new config's.
- **Leaked claimer key:** move the remaining SOL out at once. The config's fee claimer can't
  change, so fees not yet claimed are at risk. Claim often.
- **Devnet project problem:** it doesn't affect mainnet. Promote its last good deployment.
