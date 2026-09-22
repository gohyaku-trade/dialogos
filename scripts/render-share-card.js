// Optional authoring utility, not a build/runtime dependency. Commit the rendered
// JPG so deploys do not depend on locally installed Japanese fonts.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../assets/share/", import.meta.url));
mkdirSync(directory, { recursive: true });
await sharp(fileURLToPath(new URL("./share-card.svg", import.meta.url)))
  .jpeg({ quality: 86, mozjpeg: true }).toFile(directory + "/dialogos-card.jpg");
console.log("Rendered 1200x630 static share card.");
