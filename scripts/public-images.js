import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { philosophers } from "../js/data/philosophers.js";

export const originalImagePaths = Object.freeze(philosophers.map(({ id }) => `assets/images/${id}/profile.png`));
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const isWithin = (parent, child) => {
  const difference = relative(parent, child);
  return difference !== "" && !difference.startsWith("..") && !isAbsolute(difference);
};

// These are recoverable generated duplicates, NOT the source originals. Refuse
// unknown bytes or symlinks and validate every target before deleting any file.
// No recursive delete, glob or directory cleanup is performed.
export function removeGeneratedPngCopies(projectRoot, outputRoot) {
  const root = realpathSync(projectRoot);
  const output = resolve(outputRoot);
  if (output !== join(root, "public") || !isWithin(root, output) || lstatSync(output).isSymbolicLink()) {
    throw new Error("Unsafe public output directory");
  }
  const targets = [];
  for (const relativePath of originalImagePaths) {
    const target = join(output, relativePath);
    if (!existsSync(target)) continue;
    let component = output;
    for (const part of relativePath.split("/")) {
      component = join(component, part);
      if (lstatSync(component).isSymbolicLink()) throw new Error(`Symlink in generated image path: ${relativePath}`);
    }
    const source = join(root, relativePath);
    if (!isWithin(output, realpathSync(target)) || !lstatSync(target).isFile() ||
        !existsSync(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink() ||
        hash(target) !== hash(source)) {
      throw new Error(`Unexpected generated image: ${relativePath}; source originals were not removed`);
    }
    targets.push(target);
  }
  for (const target of targets) unlinkSync(target);
  return targets.length;
}

export function publicAssetFilter(projectRoot) {
  const originals = new Set(originalImagePaths.map(path => resolve(projectRoot, path)));
  return source => !originals.has(resolve(source));
}

export function assertOptimizedImages(projectRoot) {
  for (const { id } of philosophers) {
    for (const width of [128, 320, 640]) {
      const path = join(projectRoot, "assets", "images", id, `profile-${width}.webp`);
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new Error(`Missing safe optimized image ${id}/${width}. Run npm run images:optimize.`);
      }
    }
  }
}
