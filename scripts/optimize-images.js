import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { philosophers } from "../js/data/philosophers.js";

export const IMAGE_WIDTHS = Object.freeze([128, 320, 640]);
export const WEBP_OPTIONS = Object.freeze({ quality: 80, effort: 6, smartSubsample: true });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Ordinary deterministic resampling only: no generated art, crop, face edits,
// retouching or source replacement. Original PNGs remain the source of truth.
export async function optimizeImages(projectRoot = root) {
  const imageRoot = realpathSync(join(projectRoot, "assets", "images"));
  const results = [];
  for (const sage of philosophers) {
    if (!/^[a-z]+$/.test(sage.id)) throw new Error("Unexpected image identifier");
    const directory = join(imageRoot, sage.id);
    if (lstatSync(directory).isSymbolicLink() || relative(imageRoot, realpathSync(directory)).startsWith("..")) {
      throw new Error(`Unsafe image directory: ${sage.id}`);
    }
    const sourcePath = join(directory, "profile.png");
    if (!lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink()) throw new Error(`Unsafe original: ${sage.id}`);
    const source = readFileSync(sourcePath);
    const sourceHash = hash(source);
    const sourceMetadata = await sharp(source).metadata();
    const variants = [];
    for (const width of IMAGE_WIDTHS) {
      const outputPath = join(directory, `profile-${width}.webp`);
      if (existsSync(outputPath)) {
        const existing = lstatSync(outputPath);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error(`Unsafe derivative: ${sage.id}/${width}`);
      }
      // Width alone preserves the non-square Muhammad artwork as authored.
      const { data, info } = await sharp(source)
        .resize({ width, withoutEnlargement: true, kernel: "lanczos3" })
        .webp(WEBP_OPTIONS).toBuffer({ resolveWithObject: true });
      if (info.width !== width) throw new Error(`Original is too small: ${sage.id}`);
      writeFileSync(outputPath, data);
      variants.push({ width: info.width, height: info.height, bytes: statSync(outputPath).size });
    }
    if (hash(readFileSync(sourcePath)) !== sourceHash) throw new Error(`Original changed: ${sage.id}`);
    results.push({ id: sage.id, sourceBytes: source.length, sourceWidth: sourceMetadata.width,
      sourceHeight: sourceMetadata.height, variants });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await optimizeImages();
  const totals = Object.fromEntries(IMAGE_WIDTHS.map(width => [width,
    results.reduce((total, image) => total + image.variants.find(variant => variant.width === width).bytes, 0)]));
  console.log(JSON.stringify({ originals: results.reduce((total, image) => total + image.sourceBytes, 0), totals, images: results }, null, 2));
}
