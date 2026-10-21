# memestream video grabber (Railway)

The AI referee normally looks at the platform's preview picture, which can be minutes old. At the
moments that matter (after betting closes, and when it checks a result) the site asks this service
for a short clip instead: the last few seconds of the live stream as a few JPEG frames and a small
mp3. Kick has no preview picture, so there the clip is the only evidence.

- `POST /clip` with JSON `{ "url": "<stream link>", "seconds": 20 }` and the header
  `x-grabber-secret: <GRABBER_SECRET>`. Answers
  `{ frames: [{ mime: "image/jpeg", base64 }], audio: { format: "mp3", base64 } | null, startedAt, endedAt }`
  (ms epoch, the grabber's clock around the ffmpeg cut).
- `GET /health` answers 200.
- Links must be https on youtube.com, www.youtube.com, youtu.be, twitch.tv, www.twitch.tv or
  kick.com. Anything else gets 400, so the service never fetches a URL of the caller's choosing.
- `seconds` is kept within 5..30 (15 when missing).
- A wrong or missing secret gets 401. If `GRABBER_SECRET` is unset or under 32 characters, every clip
  gets 401.
- At most 2 clips run at once; a third gets 429.
- yt-dlp finds the stream's HLS URLs (YouTube: one video and one audio; Twitch and Kick: one with
  both). ffmpeg starts 4 segments back from the live edge, takes a frame every 5 s (1280 wide, at most
  6) and 16 kHz mono mp3 audio at 32 kbps.
- Both tools run without a shell. They are killed at the clip's seconds + 40 s. Each request has its
  own temp dir, which is always removed.
- The answer stays under about 4 MB: the oldest frames go first, then the audio.
- One log line per request: the outcome, the reason, the host and the video id or channel. It never
  logs the secret or an HLS URL.

A 10 s clip of a YouTube live takes about 16 s and gives 2 frames of about 150 KB and a 40 KB mp3.

## Settings

| Name | Value |
|---|---|
| `GRABBER_SECRET` | a random secret, 32+ characters (`openssl rand -hex 32`); the same value as the site's `MEMESTREAM_GRABBER_SECRET` in Vercel |
| `YTDLP_COOKIES_B64` | optional: a base64 Netscape `cookies.txt` from a throwaway YouTube account (see below) |

Railway sets `PORT`.

On the site (Vercel), set `MEMESTREAM_GRABBER_URL` (this service's https URL, for example
`https://memestream-grabber-production.up.railway.app`) and `MEMESTREAM_GRABBER_SECRET`. Without
both, the referee uses only the preview pictures, as before.

### YouTube and cloud servers

YouTube often blocks data-center IPs with "Sign in to confirm you're not a bot". The log then says
`clip failed (youtube bot check (cookies needed))` and the site falls back to the preview picture.
To get past it, export the cookies of a throwaway Google account as `cookies.txt` and set
`YTDLP_COOKIES_B64` to `base64 -i cookies.txt`. Each request writes them to its own temp dir and
passes them to yt-dlp with `--cookies`. Twitch and Kick need no cookies.

## Deploy (run these yourself, from this folder)

Add it as a second service in the same Railway project as the worker:

```sh
cd grabber
railway link                                   # pick the worker's project
railway add --service memestream-grabber       # an empty service, so the variables go in first
railway variables --service memestream-grabber --set "GRABBER_SECRET=<paste a new secret>"
railway variables --service memestream-grabber --set "YTDLP_COOKIES_B64=<base64 cookies.txt>"   # optional
railway up --service memestream-grabber        # builds the Dockerfile and starts it
railway domain --service memestream-grabber    # a public https domain for the site to call
railway logs --service memestream-grabber      # expect "grabber: listening on …"
```

Type the secret only into the `railway variables` command. Never commit it or paste it into chat.
The Dockerfile starts from `node:22-slim` and adds ffmpeg and yt-dlp at a pinned version
(`YTDLP_VERSION`). YouTube changes often: when clips start to fail with "yt-dlp found no stream",
raise the pin to the newest yt-dlp release and redeploy.

## Test

```sh
npm test        # from grabber/; or npm run test:grabber from the repo root (part of npm run check)
```

The tests use a fake spawn: they never run yt-dlp or ffmpeg.
