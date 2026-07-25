import fs from "node:fs/promises";
import path from "node:path";
import { Jimp } from "jimp";

// Per-pixel pseudo-random noise, not a smooth gradient: real photos have far
// more visual entropy than a gradient, and low-entropy synthetic images can
// end up perceptually "close" to each other regardless of actual content,
// making the near-duplicate threshold impossible to calibrate against them.
function makePattern(width, height, seed) {
  let state = seed;
  function nextByte() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % 256;
  }
  const image = new Jimp({ width, height, color: 0xffffffff });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = nextByte();
      const color = (((v << 24) | (v << 16) | (v << 8) | 0xff) >>> 0);
      image.setPixelColor(color, x, y);
    }
  }
  return image;
}

async function create() {
  const dir = path.resolve("./test-photos");
  await fs.mkdir(path.join(dir, "nested", "vacation"), { recursive: true });
  await fs.mkdir(path.join(dir, "nested", "family"), { recursive: true });

  const photoA = makePattern(400, 300, 1);
  await photoA.write(path.join(dir, "photo-a.png"));
  // exact duplicate, different name/folder
  await photoA.write(path.join(dir, "nested", "vacation", "photo-a-copy.png"));
  // near duplicate: same image, resized (should be flagged, not the same bytes)
  const photoAResized = photoA.clone().resize({ w: 200, h: 150 });
  await photoAResized.write(path.join(dir, "nested", "family", "photo-a-small.png"));

  const photoB = makePattern(320, 240, 2);
  await photoB.write(path.join(dir, "nested", "vacation", "photo-b.png"));

  const photoC = makePattern(500, 500, 3);
  await photoC.write(path.join(dir, "nested", "family", "photo-c.png"));

  console.log(`Created test photos in ${dir}`);
}

create().catch((err) => {
  console.error(err);
  process.exit(1);
});
