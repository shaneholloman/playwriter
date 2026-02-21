/*
 * Generate pixelated placeholder images for the website.
 *
 * Scans website/public/ for all image files (png, jpg, jpeg, webp) and
 * generates a tiny 32px-wide version of each. When displayed at full size
 * with CSS `image-rendering: pixelated` (nearest-neighbor / point sampling),
 * these produce a crisp mosaic effect instead of a blurry upscale.
 *
 * Skips files that already have the `placeholder-` prefix.
 * Skips regeneration if the placeholder is newer than the source image.
 *
 * Usage: tsx website/scripts/generate-placeholders.ts
 */

import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../public");
const PLACEHOLDER_PREFIX = "placeholder-";
const PLACEHOLDER_WIDTH = 32;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

async function main() {
  const entries = fs.readdirSync(PUBLIC_DIR);

  const images = entries.filter((name) => {
    if (name.startsWith(PLACEHOLDER_PREFIX)) {
      return false;
    }
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });

  if (images.length === 0) {
    console.error("No images found in public/");
    return;
  }

  for (const name of images) {
    const inputPath = path.join(PUBLIC_DIR, name);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    const outputPath = path.join(PUBLIC_DIR, `${PLACEHOLDER_PREFIX}${base}${ext}`);

    // Skip if placeholder already exists and is newer than source
    if (fs.existsSync(outputPath)) {
      const srcMtime = fs.statSync(inputPath).mtimeMs;
      const outMtime = fs.statSync(outputPath).mtimeMs;
      if (outMtime > srcMtime) {
        continue;
      }
    }

    await sharp(inputPath)
      .resize(PLACEHOLDER_WIDTH)
      .png({ compressionLevel: 9 })
      .toFile(outputPath);

    const stats = fs.statSync(outputPath);
    console.error(
      `Generated ${PLACEHOLDER_PREFIX}${base}${ext} (${PLACEHOLDER_WIDTH}px wide, ${stats.size} bytes)`,
    );
  }
}

main();
