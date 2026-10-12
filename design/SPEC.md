# memestream: design spec (FINAL: option B, Deepslate night)

2026-10-07, updated 2026-10-08. Status: FINAL. Look B picked as-is (2026-10-07). Overlay A and wordmark 1 are FINAL (2026-10-08).

**Name:** the product is "memestream", always lowercase (domain memestream.lol). It replaces "Chat Coins" (and the short-lived long name). Body copy may still say "stream coins". In the B mock, the logo is the coin sprite plus the word.

**Build B only.** Source of truth: `design/mock/mc.html?opt=B` (all screens) and the B column below. Stills: `design/mock/mc/B-{coin,home,golive}.png`. Columns A and C stay for the record only. Do not build them.

## Direction (the owner, 2026-10-07)
The whole site has a Minecraft feel: pixel fonts, blocky panels, inventory-slot buttons,
an XP-bar graduation bar, a dirt/stone/grass palette.

Legal limits:
- Use original pixel art only. All textures and sprites are drawn in code (16×16 noise tiles, small sprites).
- Do not use Mojang textures, logos, sounds or the official Minecraft font.
- Do not use the word "Minecraft" in the product UI.

## Boards (open these)
- `design/boards/MC-coin.png`: coin page, A/B/C
- `design/boards/MC-home.png`: home, A/B/C
- `design/boards/MC-golive.png`: go-live form, A/B/C
- Full-size stills: `design/mock/mc/{A,B,C}-{coin,home,golive}.png`
- Live mock (source of truth for values): `design/mock/mc.html?opt=A|B|C&screen=coin|home|golive`
- Re-render: `design/mock/render-mc.sh [A B C]` (headless Chrome, Google Fonts need network)

The plain, non-pixel mocks in `design/mock/index.html` + `mock/png/` are superseded. Keep them for reference only.

## The three options

| | A (not picked) | **B: Deepslate night (FINAL)** | C (not picked) |
|---|---|---|---|
| Page background | dark dirt tile | deepslate tile | flat sky `#8FC7F2` |
| Top bar | grass-block side tile | deepslate tile | grass-block side tile |
| Panels | light gray GUI `#C6C6C6`, bevel `#FFF`/`#555` | stone `#2C2C30`, bevel `#4A4A50`/`#161618` | sand-oak `#E3C99A`, grass top edge `#4E8A32` |
| Text | `#262626` | `#EDEDED` | `#2E1F0E` |
| Headings font | Press Start 2P | Silkscreen | Pixelify Sans 600 |
| Body font | VT323 | VT323 | Pixelify Sans |
| XP bar fill | `#80FF20` | `#80FF20` | `#FCDB05` (gold) |
| Home layout | list rows in one panel | 3-column tiles | list rows in one panel |

Shared rules (apply to B):
- Panel: 4px black outline, 4px inner bevel (light top-left, dark bottom-right). No rounded corners.
- Slot (inputs, amount chips, thumbnails): inverted bevel (dark top-left, light bottom-right).
- Button: 4px black outline, bevel, white text with a 3px hard drop shadow. Primary = green `#3C8527` (A) / `#17A34A` (B) / `#1E9E3E` (C). Secondary = stone tile. Off = `#3A3A3A`.
- XP bar: black track with 18 segments. The percent floats centered above, in the fill color with a black text stroke.
- Up/down colors: A `#2E8B22`/`#B02E26`, B `#5CFF6A`/`#FF5A4E`, C `#1F6E12`/`#9E2219`.
- Real stream pictures and video render smooth (no pixelation). They sit inside the slot bevel, `object-fit: cover`.
- `image-rendering: pixelated` applies only to sprites, textures and the fallback pixel scene.
- Numbers: `tabular-nums`.
- Sprites (original): gold coin (logo), red heart (fees/wallet), image icon (upload).
- Header wordmark (FINAL, option 1): "memestream" in VT323 44px, true lowercase. Option 2 (`?wm=1`) is not used.
- Phone header (≤520px): 16px side padding, 72px tall, 32px coin, wordmark 38px, wallet chip shrinks to a 48px heart button (address hidden). Checked at a true 390px in the built app (qa/2026-10-08-unverified/home-phone.png). Note: headless Chrome won't go below 500px, so mock phone shots need an iframe of the real width.

## Screens (B)

**Coin page**
- Left: the live stream plays in a 16:9 slot, muted, with the Live tag on top (YouTube or Twitch player), then a panel with coin image slot, `$TICKER`, "<stream name> by <streamer>", and Recent trades (Buy/Sell, SOL, coins, wallet, time ago).
- Right, panel 1: Market cap (hero number), change, pixel step chart (one connected line: flat steps joined by vertical segments, never loose dots, even with few trades), Graduation label + "52.7 of 85 SOL", XP bar with %, then the heart row **"80% of fees go to the streamer"** (must stay visible).
- Right, panel 2: Buy/Sell tabs, amount slot in SOL, chips 0.1 / 0.5 / 1 / Max, "You get about N TICKER", primary "Buy TICKER".
- Launch fee line (first 60 s, anti-sniper window; 2026-10-09): "Launch fee now 45.9%, drops to 1% in 55s", VT323 22px, muted, tabular numbers, directly above "You get about". The fee number itself uses the sell red `#FF5A4E` while it is above 10%, then muted. The line disappears after the window. Signed off on design/build/e2e/04.png.
- Empty chart (no trades yet): show the muted line "The chart starts with the first trade." in the chart area, not an empty gap.
- Streamer's own coin: the disabled button reads "Can't buy your own coin" (one line). The longer reason stays in the fair-rule copy.

**Home**
- "Live coins", one line "Buy the stream you think will pop.", Go live button.
- Sort: Hot / New / Close to graduation.
- B layout: 3-column tiles. Each tile: the stream picture (16:9) with Live tag, then two rows. Row 1: `$TICKER` left, market cap right. Row 2: stream name (one line, cut off with an ellipsis if long). No change % on tiles for now: it would cost ~25 RPC calls per coin per list scan. Add it later only from a cheap source (e.g. a stored price snapshot). Then the small XP bar. No "% to graduation" text on tiles; the bar shows it. No text wraps in a tile.

**Go live**
- One panel: Image slot (square; NOT BUILT, the app has no upload yet, so leave it out until it does), Stream name, Ticker, Stream link (placeholder "YouTube or Twitch live link"; Kick links are not allowed).
- Heart row: "80% of trade fees go to you. Your wallet can't buy this coin."
- Primary button "Launch coin".

## Copy rules
Sentence case. No ellipses. No arrows on buttons. Ticker always has `$` in titles, no `$` in buttons ("Buy MIRA").

## Stream pictures (2026-10-08, the owner: real stream video, not pixel art)
- Home tile: the stream's live picture from YouTube or Twitch.
- Coin icon (header slot, overlay slot): a square center crop of the stream picture, else the pixel scene. Later, when image upload exists, the uploaded image comes first.
- Coin page: the stream plays muted. People unmute it in the player.
- Tags on the picture: "Live" = red `#C62828`, white text. "Graduated" = XP green `#80FF20`, black text, so the two never look alike.
- Fallback: if there is no picture (stream offline, bad link, load error), show the pixel scene. Do not show a broken image or an empty box.
- Ended or private YouTube streams: our page can't see inside the player, so YouTube shows its own "Video unavailable" panel. Follow-up (design wants it before real streamers in week 3, since every stream ends): check the stream on the server (oEmbed/thumbnail) before embedding; if it's gone, show the stream picture with an "Ended" tag (stone `#3E3E44`, like Unverified), else the pixel scene.
- The pixel scenes in the mock stills stand in for these real pictures.

## OBS overlay (week 2, style B): FINAL = A, Corner panel
Build A only. B and C stay for the record. Reason given: A covers the least gameplay, and game HUDs often sit at bottom center, where C would go.
Board: `design/boards/MS-overlay.png`. Mock: `mc.html?opt=B&screen=overlay&v=A|B|C&phase=live|grad`. Stills: `design/mock/mc/B-overlay-*.png`.
- A Corner panel: 600px panel bottom-left. Row 1: coin slot, $TICKER, market cap (one line) over change. Row 2: the link, full width, 26px, text color `#EDEDED` (not muted: it is the one thing viewers act on), no "https://", one line, ellipsis only as a last resort. Then the XP bar with %, then "to graduation".
- B Top strip: full-width strip at the top. Coin, ticker, cap, change, XP bar, %, link.
- C Hotbar: bottom center, 1080px wide, like a game hotbar. XP bar on top, four slots below (ticker, cap, change, link).
- Graduated state (all): the bar fills, the % becomes "Graduated", and A adds "Now trading on Meteora".
- The real overlay page has a transparent body. The game picture in the mocks is a stand-in. Text sizes are for a 1920×1080 canvas; the XP number has an 8px black stroke for busy backgrounds.

## Unverified badge (2026-10-08): FINAL = A, Gray tag
The owner picked A ("a makes sense"). Build A only; B and C stay for the record. One tweak: the tag has the same height as the LIVE/GRADUATED tag next to it.
- Behavior: on the coin page a tap opens the note (phones have no hover) and a tap outside closes it; hover also shows it. On tiles, hover only (the tile is a link).
Why: anyone can launch a coin with any YouTube/Twitch link, and there's no channel check until channel OAuth (week 3). Audit M2; the team approved an honest label. Not on the OBS overlay.
Board: `design/boards/MS-unverified.png`. Mock: `mc.html?opt=B&screen=home|coin&unv=A|B|C`.
- A Gray tag: "Unverified" tag next to Live on the tile picture (`#3E3E44`, `#D8D8DC` text, VT323 22px, 3px black border). On the coin page, the same tag after $TICKER, with a hover/tap note.
- B Quiet word: muted "Unverified" at the right of tile row 2. On the coin page, a muted line under "by <wallet>": "Unverified. We haven't checked that this streamer owns the channel." No hover needed.
- C Icon: small gray "?" block after $TICKER on tiles and the coin page, with the hover/tap note.
- Note text (all): "We haven't checked that this streamer owns the channel."
- (Design had recommended B; the owner chose A.)

## Ticker tape (2026-10-08): FINAL = B, Live trades
The owner picked B (2026-10-08, in this session: "b"). Build B only; A and C stay for the record.
- Thin data rule: B shows the latest trades the app already has, newest first (max ~20). If there are fewer than 5 trades from the last 30 minutes, fill the rest with C-style items ("$TICKER, mini XP bar, %") from the cached coin list, so the tape is never empty or stuck on old trades. If there are no coins at all, hide the strip.
- Repeats: merge back-to-back trades with the same wallet, side and coin into one item with the summed SOL ("CEmpNR bought 0.015 SOL of $SYNTH"), so the tape never shows the same line three times in a row.
- Signed off 2026-10-08, with the repeat merge as the one tweak.
A strip under the top bar, on every page except the OBS overlay. Board: `design/boards/MS-tickertape.png`. Mock: `mc.html?opt=B&screen=home&tape=A|B|C`.
- Strip: 48px tall (40px on phones), `#111113`, 4px black bottom border, VT323 26px (22px on phones). Items are separated by a 6px gray square `#5A5A62`, not "·". No emoji: a graduation uses the coin sprite and XP green `#80FF20`.
- A Market cap: stream thumbnail (32×18), $TICKER, market cap. No change % (that costs ~25 RPC calls per coin).
- B Live trades: "<wallet> bought|sold <SOL> of $TICKER" (bought green, sold red), with graduation events in green.
- C Graduation race: $TICKER, a mini XP bar (90px, 60px on phones), % in green. A graduation event appears in green when a coin graduates.
- Motion (all): slow scroll (~40 px/s). Pause on hover and focus. No motion under prefers-reduced-motion: the strip sits still and scrolls by hand. Each item links to its coin.
- (Design had recommended C: it uses data the coin list already has, it repeats the product's one hook (the XP bar), and it stays quiet. B is the liveliest, but its trades come only from coin pages people opened, so it goes stale or empty when traffic is low. the owner chose B; the thin data rule above covers that.)

## Open
- Signed off 2026-10-08 on stills from commit d37aa1b: home, coin, go-live, overlay A live + graduated.
- Overlay on the deployed site signed off 2026-10-08 (672c701), with one tweak: the link row in `#EDEDED`.
- USD or SOL as the big price number: the owner decides before the demo video.
