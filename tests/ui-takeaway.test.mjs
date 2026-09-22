import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { philosophers } from "../js/data/philosophers.js";
import { CHATGPT_URL, buildTakeawayPrompt } from "../js/services/takeawayService.js";
import { copyTakeawayText } from "../js/ui/takeawayDialog.js";

const source = (await readFile(new URL("../js/ui/takeawayDialog.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

class Node {
  constructor() { this.listeners = new Map(); this.nodes = new Map(); this.value = ""; this.textContent = ""; this.checked = false; this.disabled = false; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Node()); return this.nodes.get(selector); }
  fire(name) { return this.listeners.get(name)?.({}); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  setSelectionRange(start, end) { this.range = [start, end]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  remove() { this.removed = true; }
}

function setup({ secureContext = true, deny = false } = {}) {
  const nodes = [];
  const events = [];
  const writes = [];
  const focus = new Node();
  const context = {
    philosophers, CHATGPT_URL, buildTakeawayPrompt,
    trackEvent: (name, attributes) => events.push({ name, attributes }),
    document: { activeElement: focus, getElementById: id => nodes.find(node => node.id === id && !node.removed), createElement: () => new Node(), body: { appendChild: node => nodes.push(node) } },
    navigator: { clipboard: { writeText: async text => { if (deny) throw new Error("NotAllowedError"); writes.push(text); } } },
    window: { isSecureContext: secureContext },
  };
  vm.runInNewContext(source + "\nglobalThis.open = openTakeawayDialog;", context);
  return { open: context.open, events, writes, focus, get dialog() { return nodes.at(-1); } };
}

test("all fourteen personas are portable without authentication, credits, network or prior dialogue", () => {
  const ui = setup();
  for (const sage of philosophers) {
    ui.open({ philosopherId: sage.id, source: "card" });
    assert.equal(ui.dialog.open, true);
    assert.ok(ui.dialog.querySelector("#takeawayPrompt").value.length > 300);
    assert.equal(ui.dialog.querySelector("#takeawayIncludeConversation").checked, false);
    assert.equal(ui.dialog.querySelector("#takeawayIncludeConversation").disabled, true);
  }
  assert.equal(ui.events.filter(event => event.name === "takeaway_open").length, 14);
  assert.equal(ui.writes.length, 0);
});

test("conversation inclusion defaults off, uses only displayed user/assistant and warns before export", async () => {
  const ui = setup();
  ui.open({ philosopherId: "socrates", source: "chat", messages: [
    { role: "user", content: "相談の秘密 123", email: "excluded@example.test" },
    { role: "assistant", content: "PRIVATE_ASSISTANT_REPLY_123", state: { facts: ["内部メモ"] } },
    { role: "system", content: "不可視の内部指示" },
  ] });
  const preview = ui.dialog.querySelector("#takeawayPrompt");
  const checkbox = ui.dialog.querySelector("#takeawayIncludeConversation");
  assert.doesNotMatch(preview.value, /相談の秘密|PRIVATE_ASSISTANT_REPLY_123/);
  assert.match(ui.dialog.innerHTML, /個人情報や相談内容/);
  assert.match(ui.dialog.innerHTML, /履歴全体ではありません/);
  checkbox.checked = true;
  await checkbox.fire("change");
  assert.match(preview.value, /相談の秘密 123/);
  assert.match(preview.value, /PRIVATE_ASSISTANT_REPLY_123/);
  assert.doesNotMatch(preview.value, /excluded@example|内部メモ|不可視の内部指示/);
  checkbox.checked = false;
  await checkbox.fire("change");
  assert.doesNotMatch(preview.value, /相談の秘密|PRIVATE_ASSISTANT_REPLY_123/);
});

test("clipboard success is reported only after successful write and never opens ChatGPT automatically", async () => {
  const ui = setup();
  ui.open({ philosopherId: "socrates", source: "hero" });
  const status = ui.dialog.querySelector("#takeawayStatus");
  assert.doesNotMatch(status.textContent, /コピーしました/);
  await ui.dialog.querySelector("#takeawayCopy").fire("click");
  assert.equal(ui.writes.length, 1);
  assert.equal(ui.writes[0], ui.dialog.querySelector("#takeawayPrompt").value);
  assert.match(status.textContent, /コピーしました/);
  assert.equal(ui.events.filter(event => event.name === "takeaway_chatgpt_open").length, 0);
  assert.equal(ui.events.filter(event => event.name === "takeaway_copy_success").length, 1);
});

for (const options of [{ deny: true }, { secureContext: false }]) {
  test(`clipboard ${options.deny ? "denial" : "insecure context"} selects the preview and never claims success`, async () => {
    const ui = setup(options);
    ui.open({ philosopherId: "plato", source: "card" });
    await ui.dialog.querySelector("#takeawayCopy").fire("click");
    assert.equal(ui.writes.length, 0);
    assert.equal(ui.dialog.querySelector("#takeawayPrompt").selected, true);
    assert.match(ui.dialog.querySelector("#takeawayStatus").textContent, /自動コピーはできていません/);
    assert.doesNotMatch(ui.dialog.querySelector("#takeawayStatus").textContent, /コピーしました/);
    assert.equal(ui.events.filter(event => event.name === "takeaway_copy_success").length, 0);
  });
}

test("ChatGPT link is canonical, explicit, isolated and contains no prompt or conversation in its URL", async () => {
  const ui = setup();
  ui.open({ philosopherId: "socrates", source: "chat", messages: [{ role: "user", content: "private@email.test" }] });
  const link = ui.dialog.querySelector("#takeawayOpenChatGPT");
  assert.equal(link.href, "https://chatgpt.com/");
  assert.match(ui.dialog.innerHTML, /target="_blank" rel="noopener noreferrer"/);
  await link.fire("click");
  const event = ui.events.at(-1);
  assert.equal(event.name, "takeaway_chatgpt_open");
  assert.deepEqual(Object.keys(event.attributes).sort(), ["philosopherId", "source"]);
  assert.doesNotMatch(JSON.stringify(ui.events), /private@email|prompt|messages|conversation/);
});

test("each new dialog resets conversation opt-in and close returns focus", () => {
  const ui = setup();
  const messages = [{ role: "user", content: "private" }];
  ui.open({ philosopherId: "socrates", messages });
  ui.dialog.querySelector("#takeawayIncludeConversation").checked = true;
  ui.open({ philosopherId: "plato", messages });
  assert.equal(ui.dialog.querySelector("#takeawayIncludeConversation").checked, false);
  ui.dialog.querySelector("#takeawayClose").fire("click");
  assert.equal(ui.dialog.removed, true);
  assert.equal(ui.focus.focused, true);
});

test("long conversations show the builder's omission warning in preview", () => {
  const ui = setup();
  ui.open({ philosopherId: "socrates", messages: Array.from({ length: 30 }, () => ({ role: "user", content: "長い問い".repeat(700) })) });
  ui.dialog.querySelector("#takeawayIncludeConversation").checked = true;
  ui.dialog.querySelector("#takeawayIncludeConversation").fire("change");
  assert.equal(ui.dialog.querySelector("#takeawayWarning").hidden, false);
  assert.match(ui.dialog.querySelector("#takeawayWarning").textContent, /上限|先頭/);
});

test("clipboard helper also handles unavailable clipboard without throwing", async () => {
  let selected = false;
  assert.equal(await copyTakeawayText("text", { secureContext: true, select: () => { selected = true; } }), false);
  assert.equal(selected, true);
});
