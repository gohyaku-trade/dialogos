import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("deployment ignore rules retain required catalogs while excluding root runtime data and secrets", t => {
  // Vercel uses gitignore semantics. Check the real rule file with Git in an
  // isolated fixture so this repository's separate .gitignore cannot mask it.
  // No deployment, authentication, dependency install or network request occurs.
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, "dialogos-deploy-ignore-"));
  t.after(() => {
    const actual = realpathSync(directory);
    const child = relative(base, actual);
    assert.ok(child.startsWith("dialogos-deploy-ignore-") && !child.includes("..") && !child.includes("/") && !child.includes("\\"));
    rmSync(actual, { recursive: true });
  });
  const runGit = (args, input) => {
    const result = spawnSync("git", args, { cwd: directory, input, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_DIR: join(directory, ".git"), GIT_COMMON_DIR: join(directory, ".git"),
        GIT_WORK_TREE: directory, GIT_INDEX_FILE: join(directory, ".git", "index"),
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
    assert.equal(result.error, undefined, "Git is required for the deployment package regression check");
    return result;
  };
  const initialized = runGit(["init", "--quiet"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(join(directory, ".gitignore"), readFileSync(join(root, ".vercelignore")));
  const required = [
    "index.html", "vercel.json", "package.json", "package-lock.json", "api/index.js", "lib/api-v3.js",
    "lib/guest-security.js", "shared/dialogue.js", "scripts/build-public.js", "scripts/public-images.js",
    "js/app.js", "js/auth.js", "js/data/philosophers.js", "js/data/takeawayPersonas.js",
    "js/services/takeawayService.js", "js/services/configService.js", "js/services/turnstileService.js",
    "assets/images/socrates/profile-320.webp",
  ];
  const excluded = ["data/runtime.db", ".env", ".env.production", "node_modules/example/index.js",
    "qa-output/sample-response.json", "tests/mock-credentials.js", ".vercel/project.json"];
  for (const path of [...required, ...excluded]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), "fixture only");
  }
  for (const path of required) assert.equal(existsSync(join(root, path)), true, `Missing build dependency: ${path}`);
  const checked = runGit(["check-ignore", "--no-index", "--stdin"], [...required, ...excluded].join("\n") + "\n");
  assert.equal(checked.status, 0, checked.stderr);
  const ignored = new Set(checked.stdout.trim().split(/\r?\n/u));
  for (const path of required) assert.equal(ignored.has(path), false, `Required deployment file excluded: ${path}`);
  for (const path of excluded) assert.equal(ignored.has(path), true, `Private/runtime file not excluded: ${path}`);
});
