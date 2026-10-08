# memestream: design spec (FINAL: option B, Deepslate night)

2026-10-07. Owner: art_design. Status: FINAL. Boss man picked B as-is (2026-10-07, via varun-14).

**Name:** the product is "memestream", always lowercase (domain memestream.lol). It replaces "Chat Coins" (and the short-lived long name). Body copy may still say "stream coins". In the B mock, the logo is the coin sprite plus the word.

**Build B only.** Source of truth: `design/mock/mc.html?opt=B` (all screens) and the B column below. Stills: `design/mock/mc/B-{coin,home,golive}.png`. Columns A and C stay for the record only. Do not build them.

## Direction (Boss man, 2026-10-07)
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
- Images: `image-rendering: pixelated`. Stream thumbnails show pixelated.
- Numbers: `tabular-nums`.
- Sprites (original): gold coin (logo), red heart (fees/wallet), image icon (upload).
- Header wordmark: "memestream" in VT323 44px, true lowercase (option 1, the mock default). Option 2 (Silkscreen, which draws as caps) is `?wm=1`. Waiting for Boss man; board `design/boards/MS-wordmark.png`.
- Phone header (≤520px): 16px side padding, 72px tall, 32px coin, wordmark 38px, wallet chip shrinks to a 48px heart button (address hidden). Checked at 390px.

## Screens (B)

**Coin page**
- Left: stream embed (16:9, Live tag), then a panel with coin image slot, `$TICKER`, "<stream name> by <streamer>", and Recent trades (Buy/Sell, SOL, coins, wallet, time ago).
- Right, panel 1: Market cap (hero number), change in the last hour, pixel step chart, Graduation label + "52.7 of 85 SOL", XP bar with %, then the heart row **"80% of fees go to the streamer"** (must stay visible).
- Right, panel 2: Buy/Sell tabs, amount slot in SOL, chips 0.1 / 0.5 / 1 / Max, "You get about N TICKER", primary "Buy TICKER".

**Home**
- "Live coins", one line "Buy the stream you think will pop.", Go live button.
- Sort: Hot / New / Close to graduation.
- B layout: 3-column tiles. Each tile: thumbnail with Live tag, `$TICKER`, stream name by streamer, market cap, 1-hour change, small XP bar with "% to graduation".

**Go live**
- One panel: Image slot (square), Stream name, Ticker, Stream link ("Twitch, YouTube or Kick link").
- Heart row: "80% of trade fees go to you. Your wallet can't buy this coin."
- Primary button "Launch coin".

## Copy rules
Sentence case. No ellipses. No arrows on buttons. Ticker always has `$` in titles, no `$` in buttons ("Buy MIRA").

## OBS overlay (week 2, style B): waiting for Boss man's pick
Board: `design/boards/MS-overlay.png`. Mock: `mc.html?opt=B&screen=overlay&v=A|B|C&phase=live|grad`. Stills: `design/mock/mc/B-overlay-*.png`.
- A Corner panel: 600px panel bottom-left. Coin slot, $TICKER, memestream.lol/<ticker>, market cap, change, XP bar with %, "to graduation".
- B Top strip: full-width strip at the top. Coin, ticker, cap, change, XP bar, %, link.
- C Hotbar: bottom center, 1080px wide, like a game hotbar. XP bar on top, four slots below (ticker, cap, change, link).
- Graduated state (all): the bar fills, the % becomes "Graduated", and A adds "Now trading on Meteora".
- The real overlay page has a transparent body. The game picture in the mocks is a stand-in. Text sizes are for a 1920×1080 canvas; the XP number has an 8px black stroke for busy backgrounds.

## Open
- Overlay pick (A/B/C above) and wordmark pick (1/2).
- The stream embed in the mocks is a stand-in drawing, not a real stream.
