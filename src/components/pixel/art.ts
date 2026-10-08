/**
 * Original pixel art drawn in code (no external textures). Ported from design/mock/mc.html.
 * Browser-only: uses canvas.
 */

/** Small deterministic random generator, so the same seed always draws the same art. */
export function seededRandom(seed: number): () => number {
  let state = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** Stable numeric seed from any string, e.g. a mint address. */
export function seedFrom(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
  return hash;
}

const TEXTURE_COLORS = {
  deep: ["#2f2f34", "#28282c", "#38383e", "#222225", "#333338"],
  stone: ["#7F7F7F", "#747474", "#8F8F8F", "#686868", "#9A9A9A"],
} as const;
export type TextureKind = keyof typeof TEXTURE_COLORS;

/** A 16×16 noise tile as a data URL, for `background-image`. */
export function textureUrl(kind: TextureKind, seed = 1): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const random = seededRandom(seed * 977 + kind.length * 31);
  const colors = TEXTURE_COLORS[kind];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      ctx.fillStyle = colors[Math.floor(random() * colors.length)];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL();
}

/** Sprites as rows of palette letters; "." is transparent. */
export const SPRITES = {
  coin: {
    rows: ["....aaaa....", "..aabbbbaa..", ".abbccccbba.", ".abccddccba.", "abccdccdccba", "abcddccddcba", "abcdccccdcba", "abccdccdccba", ".abccddccba.", ".abbccccbba.", "..aabbbbaa..", "....aaaa...."],
    palette: { a: "#3b2a00", b: "#c98f00", c: "#ffd23f", d: "#fff3a8" },
  },
  heart: {
    rows: [".aa...aa.", "abba.abba", "abbbabbba", "abbbbbbba", ".abbbbba.", "..abbba..", "...aba...", "....a...."],
    palette: { a: "#2b0000", b: "#e0352b" },
  },
} satisfies Record<string, { rows: string[]; palette: Record<string, string> }>;
export type SpriteName = keyof typeof SPRITES;

export function drawSprite(canvas: HTMLCanvasElement, name: SpriteName) {
  const { rows, palette } = SPRITES[name];
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  rows.forEach((row, y) =>
    [...row].forEach((letter, x) => {
      const color = (palette as Record<string, string>)[letter];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }),
  );
}

const SCENE_PALETTES = [
  ["#1d3b8f", "#e94f37", "#f6c90e", "#3fb950", "#7b2cbf", "#00b4d8"],
  ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#8ecae6"],
  ["#3a0ca3", "#f72585", "#4cc9f0", "#ffbe0b", "#06d6a0", "#ef476f"],
];

/** Blocky low-res "stream" picture used as a coin's image and as the stand-in for a missing embed. */
export function drawScene(canvas: HTMLCanvasElement, seed: number) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const random = seededRandom(seed * 7919 + 13);
  const palette = SCENE_PALETTES[Math.floor(random() * SCENE_PALETTES.length)];
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, w, h);
  for (let band = 0; band < 5; band++) {
    ctx.fillStyle = palette[(band + 1) % 6];
    ctx.fillRect(0, Math.round(h * (0.35 + band * 0.13)), w, Math.ceil(h * 0.13));
  }
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = palette[Math.floor(random() * 6)];
    const size = Math.max(1, Math.round((random() * w) / 14));
    ctx.fillRect(Math.floor(random() * w), Math.floor(random() * h), size, Math.max(1, Math.round(size * (0.5 + random()))));
  }
}

/** Pixel stair-step line chart of `values` (oldest first). */
export function drawStepChart(canvas: HTMLCanvasElement, values: number[], color: string) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  ctx.fillStyle = color;
  // A connected stair line: flat until the next trade, then a vertical step to its price.
  let previous: { x: number; y: number } | null = null;
  values.forEach((value, i) => {
    const x = Math.min(Math.round(i * step), w - 2);
    const y = Math.round(h - 3 - ((value - min) / span) * (h - 6));
    if (previous) {
      ctx.fillRect(previous.x, previous.y, x - previous.x + 2, 2);
      ctx.fillRect(x, Math.min(previous.y, y), 2, Math.abs(y - previous.y) + 2);
    }
    previous = { x, y };
  });
}
