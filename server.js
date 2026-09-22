import "dotenv/config";
import express from "express";
import apiApp from "./api/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT || 5177);
const ROOT = dirname(fileURLToPath(import.meta.url));
export const app = express();

app.disable("x-powered-by");
app.use("/api", apiApp);
// Original portraits are editing sources, not downloadable public assets.
app.use("/assets", (req, res, next) => {
  let path;
  try { path = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
  if (/[/\\]profile\.png$/i.test(path)) return res.sendStatus(404);
  next();
});
for (const directory of ["assets", "css", "js"]) {
  app.use("/" + directory, express.static(join(ROOT, directory), { dotfiles: "deny" }));
}
for (const file of ["index.html", "legal.html", "terms.html", "privacy.html"]) {
  app.get(file === "index.html" ? ["/", "/index.html"] : "/" + file, (_req, res) => res.sendFile(join(ROOT, file)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) app.listen(PORT, "127.0.0.1", () => {
  console.log(`Dialogos ready: http://127.0.0.1:${PORT}/`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL ? "configured" : "missing"}`);
  console.log(`  Stripe: ${process.env.STRIPE_SECRET_KEY ? "configured" : "missing"}`);
  console.log(`  OpenAI: ${process.env.OPENAI_API_KEY ? "configured" : "missing"}`);
});
