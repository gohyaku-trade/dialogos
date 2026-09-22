import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = async path => (await readFile(new URL(path, import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const configSource = await source("../js/services/configService.js");
const authSource = await source("../js/auth.js");
const challengeSource = await source("../js/services/turnstileService.js");

test("config is shared across concurrent callers and cached for one public visit", async () => {
  let calls = 0;
  const context = { AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls++; assert.equal(url, "/api/config"); assert.equal(options.credentials, "same-origin"); return { ok: true, json: async () => ({ anonymousEnabled: true }) }; } };
  vm.runInNewContext(configSource + "\nglobalThis.getConfig = getPublicConfig;", context);
  const [a, b] = await Promise.all([context.getConfig(), context.getConfig()]);
  assert.equal(a, b);
  assert.equal((await context.getConfig()).anonymousEnabled, true);
  assert.equal(calls, 1);
});

test("configuration failure is fail-closed without automatic request loops", async () => {
  let calls = 0;
  const context = { AbortController, setTimeout, clearTimeout, fetch: async () => { calls++; throw new Error("offline"); } };
  vm.runInNewContext(configSource + "\nglobalThis.getConfig = getPublicConfig;", context);
  const config = await context.getConfig();
  assert.equal(config.anonymousEnabled, false);
  assert.equal(config.trial.enabled, false);
  assert.equal(config.salesEnabled, false);
  await context.getConfig();
  assert.equal(calls, 1);
});

test("first-time public auth does not request config, SDK, token or account session", async () => {
  const context = { localStorage: { getItem: () => null }, window: { location: { search: "", hash: "" } },
    getPublicConfig: async () => { throw new Error("unexpected config fetch"); }, setTimeout, console };
  vm.runInNewContext(authSource + "\nglobalThis.auth = { initAuth, getAccessToken, onAuthStateChange };", context);
  assert.equal(await context.auth.initAuth(), null);
  assert.equal(await context.auth.getAccessToken(), null);
  assert.equal(await context.auth.onAuthStateChange(() => {}), undefined);
});

function challengeHarness() {
  const nodes = [], removed = [], rendered = [];
  const document = { head: { appendChild: () => { throw new Error("real challenge script prohibited in test"); } },
    body: { appendChild: node => nodes.push(node) },
    createElement: tag => ({ tag, setAttribute() {}, innerHTML: "", children: new Map(),
      querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, { textContent: "", addEventListener() {} }); return this.children.get(selector); },
      addEventListener() {}, showModal() { this.open = true; }, remove() { this.removed = true; } }) };
  const context = { document, setTimeout, clearTimeout, window: { turnstile: {
    render: (node, options) => { rendered.push(options); return "mock-widget"; }, remove: id => removed.push(id),
  } } };
  vm.runInNewContext(challengeSource + "\nglobalThis.challenge = { requestTurnstileToken, cancelTurnstile };", context);
  return { ...context.challenge, nodes, removed, rendered };
}

test("Turnstile module is inert until explicit call and rejects missing configuration", async () => {
  const ui = challengeHarness();
  assert.equal(ui.nodes.length, 0);
  await assert.rejects(ui.requestTurnstileToken({ action: "guest_session" }), { code: "TURNSTILE_NOT_CONFIGURED" });
  assert.equal(ui.nodes.length, 0);
});

test("Turnstile awaits proof, binds action and request cData, removes widget after success", async () => {
  const ui = challengeHarness();
  const pending = ui.requestTurnstileToken({ siteKey: "key", action: "guest_chat", requestId: "stable-uuid" });
  await new Promise(setImmediate);
  assert.equal(ui.nodes[0].open, true);
  assert.equal(ui.rendered[0].action, "guest_chat");
  assert.equal(ui.rendered[0].cData, "stable-uuid");
  ui.rendered[0].callback("fresh-proof");
  assert.equal(await pending, "fresh-proof");
  assert.equal(ui.nodes[0].removed, true);
  assert.deepEqual(ui.removed, ["mock-widget"]);
});

test("Turnstile failure and cancellation remove proof UI without treating either as success", async () => {
  for (const failure of [true, false]) {
    const ui = challengeHarness();
    const pending = ui.requestTurnstileToken({ siteKey: "key", action: "guest_session" });
    const rejected = assert.rejects(pending, { code: failure ? "TURNSTILE_FAILED" : "TURNSTILE_CANCELLED" });
    await new Promise(setImmediate);
    if (failure) ui.rendered[0]["error-callback"](); else ui.cancelTurnstile();
    await rejected;
    assert.equal(ui.nodes[0].removed, true);
  }
});
