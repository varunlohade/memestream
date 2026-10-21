/**
 * The 24/7 live cams the daily streamer rotates through (one a day), each with questions the
 * camera clearly shows, so the AI referee can check them from the stream picture.
 */
export const STREAMS = [
  {
    key: "beach",
    label: "Beach cam",
    prefix: "BCH",
    url: "https://www.youtube.com/watch?v=MW3fisTCXRQ",
    questions: [
      "Will there be people on the sand when betting closes?",
      "Will the beach look dark when betting closes?",
      "Will someone be in the water when betting closes?",
      "Will a boat be visible on the sea when betting closes?",
    ],
  },
  {
    key: "heathrow",
    label: "Heathrow cam",
    prefix: "LHR",
    url: "https://www.youtube.com/watch?v=uDBYuEV4zjI",
    questions: [
      "Will a plane be on screen when betting closes?",
      "Will a plane be on the runway when betting closes?",
      "Will the airport look dark when betting closes?",
      "Will two or more planes be on screen when betting closes?",
    ],
  },
  {
    key: "jackson-hole",
    label: "Jackson Hole cam",
    prefix: "JH",
    url: "https://www.youtube.com/watch?v=1EiC9bvVGnk",
    questions: [
      "Will a car be in the intersection when betting closes?",
      "Will there be people on the sidewalk when betting closes?",
      "Will the town square look dark when betting closes?",
      "Will a truck be on screen when betting closes?",
    ],
  },
  {
    key: "namib",
    label: "Namib desert cam",
    prefix: "NAMB",
    url: "https://www.youtube.com/watch?v=ydYDqZQpim8",
    questions: [
      "Will an animal be at the waterhole when betting closes?",
      "Will the waterhole look dark when betting closes?",
      "Will two or more animals be on screen when betting closes?",
      "Will a bird be on screen when betting closes?",
    ],
  },
  {
    key: "shinjuku",
    label: "Shinjuku cam",
    prefix: "TKYO",
    url: "https://www.youtube.com/watch?v=6dp-bvQ7RWo",
    questions: [
      "Will people be crossing the street when betting closes?",
      "Will a bus be on screen when betting closes?",
      "Will the street look dark when betting closes?",
      "Will a taxi be on screen when betting closes?",
    ],
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Day 0 of the rotation. */
const EPOCH_DAY = Date.UTC(2026, 9, 1) / DAY_MS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");

/** Every stream, starting with today's (one step a UTC day since EPOCH_DAY), so a stream that isn't live falls through to the next. */
export function rotation(now, streams = STREAMS) {
  const n = streams.length;
  const start = (((Math.floor(now / DAY_MS) - EPOCH_DAY) % n) + n) % n;
  return streams.map((_, i) => streams[(start + i) % n]);
}

/** The UTC day a time falls on, as [start, end) in ms. */
export function utcDay(now) {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return [start, start + DAY_MS];
}

/** The coin for a stream on a UTC day: "Beach cam · Oct 22", BCH261022 (the year keeps tickers unique). */
export function coinFor(stream, now) {
  const d = new Date(now);
  return {
    name: `${stream.label} · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
    symbol: `${stream.prefix}${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`,
    streamUrl: stream.url,
  };
}
