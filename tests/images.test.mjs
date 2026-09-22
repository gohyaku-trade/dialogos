import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { philosophers } from "../js/data/philosophers.js";
import { IMAGE_WIDTHS, WEBP_OPTIONS } from "../scripts/optimize-images.js";
import { assertOptimizedImages, publicAssetFilter, removeGeneratedPngCopies } from "../scripts/public-images.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("all 14 original images remain; all 42 WebP variants preserve aspect ratio with bounded bytes", async () => {
  assert.equal(philosophers.length, 14);
  assertOptimizedImages(root);
  const totals = { 128: 0, 320: 0, 640: 0 };
  let originalBytes = 0;
  for (const sage of philosophers) {
    const original = join(root, "assets", "images", sage.id, "profile.png");
    const source = await sharp(original).metadata();
    assert.equal(source.format, "png");
    originalBytes += statSync(original).size;
    for (const width of IMAGE_WIDTHS) {
      const path = join(root, "assets", "images", sage.id, `profile-${width}.webp`);
      const metadata = await sharp(path).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, Math.round(source.height * width / source.width));
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.icc, undefined);
      totals[width] += statSync(path).size;
    }
    const portrait = await sharp(join(root, sage.portrait)).metadata();
    const icon = await sharp(join(root, sage.portraitIcon)).metadata();
    assert.equal(portrait.width, sage.portraitWidth);
    assert.equal(portrait.height, sage.portraitHeight);
    assert.equal(icon.width, sage.portraitIconWidth);
    assert.equal(icon.height, sage.portraitIconHeight);
    assert.equal(sage.portraitSrcSet, `${sage.portrait} 320w, ./assets/images/${sage.id}/profile-640.webp 640w`);
  }
  assert.equal(originalBytes, 33059274);
  assert.ok(totals[128] < 65000, JSON.stringify(totals));
  assert.ok(totals[320] < 275000, JSON.stringify(totals));
  assert.ok(totals[640] < 900000, JSON.stringify(totals));
});

test("WebP files exactly match the deterministic resize pipeline without changing originals", async () => {
  for (const { id } of philosophers) {
    const path = join(root, "assets", "images", id, "profile.png");
    const source = readFileSync(path);
    const originalHash = hash(source);
    for (const width of IMAGE_WIDTHS) {
      const expected = await sharp(source).resize({ width, withoutEnlargement: true, kernel: "lanczos3" })
        .webp(WEBP_OPTIONS).toBuffer();
      assert.equal(hash(readFileSync(join(dirname(path), `profile-${width}.webp`))), hash(expected), `${id}/${width}`);
    }
    assert.equal(hash(readFileSync(path)), originalHash, id);
  }
});

function fixture(t) {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, "dialogos-image-test-"));
  const output = join(directory, "public");
  mkdirSync(output);
  t.after(() => {
    const actual = realpathSync(directory);
    const child = relative(base, actual);
    assert.ok(child.startsWith("dialogos-image-test-") && !child.includes("..") && !child.includes("/") && !child.includes("\\"));
    rmSync(actual, { recursive: true });
  });
  return { directory, output };
}

function writeFixtureFile(rootPath, relativePath, content = "original fixture") {
  const path = join(rootPath, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test("build removes only hash-matching generated PNG duplicates and preserves originals and unknown files", t => {
  const { directory, output } = fixture(t);
  const relativePath = "assets/images/socrates/profile.png";
  const original = writeFixtureFile(directory, relativePath);
  const duplicate = writeFixtureFile(output, relativePath);
  const unrelated = writeFixtureFile(output, "assets/unrelated.png", "user owned");
  assert.equal(removeGeneratedPngCopies(directory, output), 1);
  assert.equal(existsSync(duplicate), false);
  assert.equal(readFileSync(original, "utf8"), "original fixture");
  assert.equal(readFileSync(unrelated, "utf8"), "user owned");
  assert.equal(removeGeneratedPngCopies(directory, output), 0);
  assert.throws(() => removeGeneratedPngCopies(directory, directory), /Unsafe public output/);
});

test("build validates every old PNG before any removal and refuses unexpected contents", t => {
  const { directory, output } = fixture(t);
  for (const id of ["socrates", "plato"]) writeFixtureFile(directory, `assets/images/${id}/profile.png`);
  const valid = writeFixtureFile(output, "assets/images/socrates/profile.png");
  const unknown = writeFixtureFile(output, "assets/images/plato/profile.png", "not a generated duplicate");
  assert.throws(() => removeGeneratedPngCopies(directory, output), /Unexpected generated image/);
  assert.equal(existsSync(valid), true);
  assert.equal(readFileSync(unknown, "utf8"), "not a generated duplicate");
});

test("build refuses symlinked generated image directories", t => {
  const { directory, output } = fixture(t);
  const outside = join(directory, "unrelated-assets");
  writeFixtureFile(outside, "images/socrates/profile.png");
  writeFixtureFile(directory, "assets/images/socrates/profile.png");
  try {
    symlinkSync(outside, join(output, "assets"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("OS does not permit test symlinks");
    throw error;
  }
  assert.throws(() => removeGeneratedPngCopies(directory, output), /Symlink/);
  assert.equal(existsSync(join(outside, "images/socrates/profile.png")), true);
});

test("asset copy filter publishes optimized files but never re-adds known original PNGs", t => {
  const { directory, output } = fixture(t);
  const original = writeFixtureFile(directory, "assets/images/socrates/profile.png");
  writeFixtureFile(directory, "assets/images/socrates/profile-320.webp", "optimized fixture");
  cpSync(join(directory, "assets"), join(output, "assets"), { recursive: true, filter: publicAssetFilter(directory) });
  assert.equal(existsSync(join(output, "assets/images/socrates/profile.png")), false);
  assert.equal(readFileSync(join(output, "assets/images/socrates/profile-320.webp"), "utf8"), "optimized fixture");
  assert.equal(existsSync(original), true);
  assert.throws(() => assertOptimizedImages(directory), /Missing safe optimized image/);
});
