import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { philosophers, getPhilosopherById } from "../js/data/philosophers.js";
import { buildShareUrl, buildXIntent, parseSharedSage } from "../js/services/shareService.js";

const appSource = (await readFile(new URL("../js/app.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("boot();", "");
const apiSource = (await readFile(new URL("../js/services/apiService.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export const apiService", "const apiService");
const packages = [
  { id: "v3_40", kind: "credits", name: "40回パック", price_jpy: 100, credits: 40 },
  { id: "v3_140", kind: "credits", name: "140回パック", price_jpy: 300, credits: 140 },
  { id: "v3_500", kind: "credits", name: "500回パック", price_jpy: 1000, credits: 500 },
];
const user = { id: "test-account", logged_in: true, credits: 3, credits_reserved: 0 };
const trialConfig = { salesEnabled: false, anonymousEnabled: true, turnstileSiteKey: "mock-site-key", trial: { enabled: true, allPhilosophers: true, dailyReplies: 3, resetTimezone: "Asia/Tokyo", requiresGoogle: false } };
const trialUser = (remaining = 3, credits = 0) => ({ ...user, credits, trial_eligible: true,
  trial_remaining: remaining, trial_balance: remaining, trial_used: 3 - remaining, trial_reserved: 0 });
const guestUser = (remaining = 3) => ({ ...trialUser(remaining), id: "anonymous-test", logged_in: false, is_guest: true, email: undefined });
const event = () => ({ preventDefault() {} });

class Element {
  innerHTML = "";
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  children = [];
  style = {};
  dataset = {};
  classList = { add() {}, remove() {}, contains: () => false };
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(node) { this.children.push(node); }
  focus() {}
  remove() {}
}

function setup(overrides = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element("usageMeter").querySelector = () => element("meterInner");
  const storage = new Map();
  const calls = { login: 0, checkout: 0, packages: 0, sync: 0, subscription: 0, portal: 0, cancel: 0, chat: [], replacements: [] };
  const api = {
    getConfig: async () => ({ trial: { enabled: false } }),
    getPackages: async () => { calls.packages++; return { packages }; },
    getMe: async () => ({ ...user }),
    getHistory: async () => [],
    createCheckout: async () => { calls.checkout++; return { url: "https://checkout.example.test" }; },
    syncSession: async () => { calls.sync++; return { ...user }; },
    getSubscription: async () => { calls.subscription++; return { status: "active" }; },
    createPortal: async () => { calls.portal++; return { url: "https://billing.example.test" }; },
    cancelSubscription: async () => { calls.cancel++; return { ok: true }; },
    sendChat: async (body) => {
      calls.chat.push(structuredClone(body));
      return { requestId: body.requestId, reply: "その考えを、もう少し確かめよう。", conversationId: "conversation-1", user: { ...user, credits: 2 } };
    },
    ...overrides,
  };
  const context = {
    document: { querySelector: selector => element(selector.replace(/^[#.]/, "")),
      getElementById: element, createElement: () => new Element(), body: new Element(), addEventListener() {} },
    navigator: { userAgent: "" },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "" }, scrollTo() {} },
    history: { replaceState: (_state, _title, url) => calls.replacements.push(url) },
    location: { href: "http://localhost/" },
    crypto: { randomUUID }, philosophers, getPhilosopherById, apiService: api, buildShareUrl, buildXIntent, parseSharedSage,
    signInWithGoogle: async () => { calls.login++; }, signOut: async () => {},
    initAuth: async () => {}, onAuthStateChange: async () => {},
    openTakeawayDialog: args => { calls.takeaway = args; },
    cancelTurnstile() {}, requestTurnstileToken: async options => { (calls.proofs ||= []).push(options); return "mock-proof"; },
    console, setTimeout, clearTimeout, URLSearchParams, alert() {}, confirm: () => true,
  };
  vm.runInNewContext(appSource + `\nglobalThis.ui = { state, loadConfig, refreshUser, renderList,
    renderChat, renderReflection, loadExistingMessages, handleSend, restorePendingChat, navigate,
    trialRemaining, canUseTrial, canStartReply, updateChatAccess, renderTrialOffer, renderSageCard, usageSummaryText,
    renderProfile, renderLoginGate, renderGuestGate, handleGuestStart, scheduleTrialRefresh, trialRefreshDelay, bindEvents, invalidatePrivateView, renderAvatar, identityKey, hasReplyIdentity, boot, loadSidebarHistory, renderShareActions, copyPublicLink, updateUsageMeter, renderAuthNav, composerNoteText };`, context);
  return { ...context.ui, api, calls, element, storage, context };
}

test("anonymous account failure does not block 14 sages, examples or free takeaway", async () => {
  const ui = setup({ getMe: async () => { throw Object.assign(new Error(), { status: 401 }); } });
  await ui.refreshUser();
  ui.renderList();
  assert.equal(ui.state.user, null);
  assert.equal((ui.element("app").innerHTML.match(/data-chat=/g) || []).length, 14);
  assert.match(ui.element("app").innerHTML, /ログイン不要・何度でも無料/);
  assert.equal((ui.element("app").innerHTML.match(/data-takeaway=/g) || []).length, 15);
  assert.doesNotMatch(ui.element("app").innerHTML, /料金を見る|円で|購入する/);
  assert.match(ui.element("app").innerHTML, /対話の雰囲気を読む/);
  assert.doesNotMatch(ui.element("app").innerHTML, /無料体験|記憶の書で解放/);
  assert.equal(ui.calls.packages, 0);
});

test("chat without any reply identity opens its free guest gate without account or payment calls", async () => {
  const ui = setup();
  ui.element("messageInput").value = "私はなぜ働くのか";
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 0);
  assert.equal(ui.calls.login, 0);
  assert.equal(ui.calls.checkout, 0);
  assert.match(ui.element("app").innerHTML, /ログインせずに試す/);
});

test("unknown free reply retains identical UUID and payload without spending old credits", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(3, 207);
  ui.element("messageInput").value = "他者に認められたいのはなぜか";
  const sent = [];
  ui.api.sendChat = async body => {
    sent.push(structuredClone(body));
    if (sent.length === 1) throw Object.assign(new Error(), { code: "REQUEST_UNKNOWN", status: 409 });
    return { conversationId: "conversation-1", reply: "承認とは何だろう。", usageSource: "trial", user: trialUser(2, 207) };
  };
  await ui.handleSend(event());
  assert.equal(ui.state.user.credits, 207);
  assert.equal(ui.trialRemaining(), 3);
  assert.ok(ui.state.pendingChat.requestId);
  assert.equal(ui.element("messageInput").readOnly, true);
  const saved = JSON.parse(ui.storage.get("dialogos.v3.pendingChat"));
  assert.equal(saved.requestId, sent[0].requestId);
  ui.element("messageInput").value = "変更されても送信本文は変えない";
  await ui.handleSend(event());
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.state.user.credits, 207);
  assert.equal(ui.trialRemaining(), 2);
  assert.equal(sent[0].expectChargeSource, "trial");
  assert.equal(ui.element("messageInput").readOnly, false);
  assert.equal(ui.storage.has("dialogos.v3.pendingChat"), false);
  ui.element("messageInput").value = "次の問い";
  await ui.handleSend(event());
  assert.notEqual(sent[2].requestId, sent[0].requestId);
});

test("network failure is recoverable with same request, while definitive generation failure releases input", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(3, 207);
  ui.api.getMe = async () => trialUser(3, 207);
  ui.element("messageInput").value = "よく生きるとは";
  ui.api.sendChat = async () => { throw new TypeError("network failed"); };
  await ui.handleSend(event());
  const id = ui.state.pendingChat.requestId;
  assert.equal(ui.state.user.credits, 207);
  ui.api.sendChat = async body => {
    assert.equal(body.requestId, id);
    throw Object.assign(new Error(), { code: "GENERATION_FAILED", status: 502 });
  };
  await ui.handleSend(event());
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.element("messageInput").value, "よく生きるとは");
  assert.match(ui.element("chatStatus").innerHTML, /無料回数.*消費されていません/);
  assert.doesNotMatch(ui.element("chatStatus").innerHTML, /灯火|購入|残高/);
});

test("input length is enforced in Unicode characters before any free request", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser();
  ui.element("messageInput").value = "問".repeat(1001);
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 0);
  ui.element("messageInput").value = "🤔".repeat(1000);
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 1);
});

test("reloading completed pending request does not duplicate saved user or assistant messages", async () => {
  const ui = setup();
  const requestId = randomUUID();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser();
  ui.state.conversationId = "conversation-1";
  ui.state.pendingChat = { ownerId: user.id, ownerKind: "account", requestId, philosopherId: "socrates", conversationId: "conversation-1", message: "問い", expectChargeSource: "trial" };
  ui.api.getConversationMessages = async () => ({ conversation: {}, messages: [
    { role: "user", content: "問い", request_id: requestId },
    { role: "assistant", content: "応答", request_id: requestId },
  ] });
  await ui.loadExistingMessages(getPhilosopherById("socrates"));
  ui.api.sendChat = async () => ({ conversationId: "conversation-1", reply: "応答", usageSource: "trial", user: trialUser(2) });
  await ui.handleSend(event());
  const messages = ui.element("chatArea").children.filter(child => child.dataset.requestId === requestId);
  assert.equal(messages.length, 2);
});

test("public application contains no purchase, subscription or paid-credit entry points", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(appSource, /\b(?:loadPackages|renderPackageGrid|handlePurchaseClick|renderPurchase|renderSubscription|renderSubStatus|handlePortal|handleCancel)\s*\(/);
  assert.doesNotMatch(appSource, /apiService\.(?:getPackages|createCheckout|syncSession|getSubscription|createPortal|cancelSubscription)\s*\(/);
  assert.doesNotMatch(html, /data-route="(?:purchase|subscription|cancel)"|以前の購入分|以前の契約/);
  const ui = setup();
  for (const property of ["packages", "salesEnabled", "pendingCheckout", "checkoutLoading"]) {
    assert.equal(Object.hasOwn(ui.state, property), false, property);
  }
});

test("pending state is account scoped and reflection excludes private facts/internal moves", () => {
  const ui = setup();
  ui.storage.set("dialogos.v3.pendingChat", JSON.stringify({ ownerId: "another-account", requestId: randomUUID(), message: "private", philosopherId: "socrates" }));
  ui.state.user = { ...user };
  ui.restorePendingChat();
  assert.equal(ui.state.pendingChat, null);
  ui.renderReflection({ claims: ["<script>bad</script>"], facts: ["secret"], recentMoves: ["internal"], revisions: [{ from: "昔", to: "今" }] });
  assert.match(ui.element("dialogueReflection").innerHTML, /&lt;script&gt;/);
  assert.match(ui.element("dialogueReflection").innerHTML, /昔 → 今/);
  assert.doesNotMatch(ui.element("dialogueReflection").innerHTML, /secret|internal|<script>/);
});

test("API client keeps public catalog independent of auth and rejects anonymous protected calls", async () => {
  let token = null;
  const requests = [];
  const context = { getAccessToken: async () => token, fetch: async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => ({ packages }) };
  } };
  vm.runInNewContext(apiSource + "\nglobalThis.client = apiService;", context);
  await context.client.getPackages();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.headers["X-Guest-Id"], undefined);
  await assert.rejects(context.client.getMe(), error => error.code === "AUTH_REQUIRED");
  assert.equal(requests.length, 1);
  token = "test-token";
  const requestId = randomUUID();
  await context.client.sendChat({ philosopherId: "socrates", message: "問い", conversationId: null, requestId, expectChargeSource: "paid" });
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.parse(requests[1].options.body).requestId, requestId);
  assert.equal(JSON.parse(requests[1].options.body).expectChargeSource, "paid");
  assert.equal(context.client.restoreByEmail, undefined);
  assert.equal(context.client.cancelByEmail, undefined);
});

test("API client normalizes backend history and legacy account contract", async () => {
  const context = { getAccessToken: async () => "token", fetch: async path => ({ ok: true, json: async () => path === "/api/history"
    ? { conversations: [{ id: "record-1" }] }
    : { subscription_status: "active", current_period_end: "2030-01-01", cancel_at_period_end: true } }) };
  vm.runInNewContext(apiSource + "\nglobalThis.client = apiService;", context);
  const history = await context.client.getHistory();
  assert.equal(history[0].id, "record-1");
  const subscription = await context.client.getSubscription();
  assert.equal(subscription.status, "active");
  assert.equal(subscription.currentPeriodEnd, "2030-01-01");
  assert.equal(subscription.cancelAtPeriodEnd, true);
});

test("public trial CTA advertises shared daily three replies across 14 sages at JST midnight", async () => {
  const ui = setup({ getConfig: async () => trialConfig });
  await ui.loadConfig();
  ui.renderList();
  assert.match(ui.element("app").innerHTML, /好きな賢者と、1日3往復/);
  assert.match(ui.element("app").innerHTML, /Googleログイン不要/);
  assert.match(ui.element("app").innerHTML, /日本時間0時に更新/);
  assert.match(ui.element("app").innerHTML, /全14人で合計3往復/);
  assert.match(ui.renderSageCard(getPhilosopherById("socrates")), /人格コピー無料/);
  assert.match(ui.renderSageCard(getPhilosopherById("plato")), /人格コピー無料/);
  assert.equal(ui.canStartReply("socrates"), false);
});

test("disabled trial configuration does not advertise or spend trial even if account has a balance", async () => {
  const ui = setup({ getConfig: async () => ({ trial: { ...trialConfig.trial, enabled: false } }) });
  ui.state.user = trialUser();
  await ui.loadConfig();
  ui.renderList();
  assert.match(ui.renderTrialOffer(), /人格の持ち帰りは、いつでも無料/);
  assert.equal(ui.canUseTrial("socrates"), false);
  assert.doesNotMatch(ui.element("app").innerHTML, /無料で3往復|初回無料/);
  ui.element("messageInput").value = "問い";
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 0);
  ui.state.user.credits = 1;
  assert.equal(ui.canStartReply("socrates"), false);
  assert.equal(ui.canStartReply("plato"), false);
});

test("failed or incompatible public configuration never promises a trial", async () => {
  const ui = setup({ getConfig: async () => { throw new TypeError("offline"); } });
  await ui.loadConfig();
  assert.match(ui.renderTrialOffer(), /人格の持ち帰りは、いつでも無料/);
  ui.api.getConfig = async () => ({ trial: { ...trialConfig.trial, dailyReplies: 10 } });
  await ui.loadConfig();
  assert.equal(ui.state.trial.enabled, false);
});

for (const oldCredits of [0, 207]) {
  test(`three daily account replies share sages and never spend ${oldCredits} old credits`, async () => {
    const ui = setup();
    ui.state.trial = { enabled: true };
    ui.state.user = trialUser(3, oldCredits);
    ui.api.sendChat = async body => {
      assert.equal(ui.state.user.trial_remaining, 3 - ui.calls.chat.length);
      assert.equal(ui.state.user.credits, oldCredits);
      assert.equal(body.expectChargeSource, "trial");
      ui.calls.chat.push(structuredClone(body));
      return { conversationId: "conversation-1", reply: "何をよいと呼ぶだろう。", usageSource: "trial",
        user: trialUser(3 - ui.calls.chat.length, oldCredits) };
    };
    for (const philosopherId of ["socrates", "plato", "buddha", "nietzsche"]) {
      ui.state.philosopherId = philosopherId;
      ui.element("messageInput").value = "よく生きるとは";
      await ui.handleSend(event());
    }
    assert.equal(ui.calls.chat.length, 3);
    assert.deepEqual(ui.calls.chat.map(body => body.philosopherId), ["socrates", "plato", "buddha"]);
    assert.equal(ui.trialRemaining(), 0);
    assert.equal(ui.state.user.credits, oldCredits);
    assert.doesNotMatch(ui.element("meterInner").innerHTML, /購入分|灯火|207/);
    assert.match(ui.element("meterInner").innerHTML, /今日の無料/);
  });
}

test("last trial reply stays visible while fourth reply is gated and new conversation does not reset it", async () => {
  const ui = setup({ getMe: async () => trialUser(0) });
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(1);
  ui.element("messageInput").value = "三つ目の問い";
  ui.api.sendChat = async body => {
    ui.calls.chat.push(body);
    return { conversationId: "conversation-1", reply: "最後の無料返答です。", usageSource: "trial", user: trialUser(0) };
  };
  await ui.handleSend(event());
  assert.equal(ui.trialRemaining(), 0);
  assert.equal(ui.element("messageInput").disabled, true);
  assert.equal(ui.element("send-button").disabled, true);
  assert.ok(ui.element("chatArea").children.some(child => child.innerHTML.includes("最後の無料返答")));
  assert.match(ui.element("chatAccessNotice").innerHTML, /人格を無料で持ち帰る/);
  assert.match(ui.element("chatAccessNotice").innerHTML, /日本時間0時/);
  ui.element("messageInput").value = "四つ目の問い";
  await ui.handleSend(event());
  ui.state.conversationId = null;
  await ui.handleSend(event());
  await ui.refreshUser();
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 1);
  assert.equal(ui.canStartReply(), false);
});

test("all fourteen sages share the same remaining daily allowance", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser();
  for (const sage of philosophers) {
    ui.state.philosopherId = sage.id;
    assert.equal(ui.canStartReply(), true);
    assert.equal(ui.trialRemaining(), 3);
  }
  assert.equal(ui.calls.chat.length, 0);
  ui.state.user = trialUser(0);
  for (const sage of philosophers) assert.equal(ui.canStartReply(sage.id), false);
});

test("last free reply stays visible and 207 old credits never enable a fourth reply", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(1, 207);
  ui.element("messageInput").value = "最後の体験";
  const sent = [];
  ui.api.sendChat = async body => {
    sent.push(structuredClone(body));
    return { conversationId: "conversation-1", reply: "最後の無料の返答。", usageSource: "trial", user: trialUser(0, 207) };
  };
  await ui.handleSend(event());
  assert.equal(ui.state.user.credits, 207);
  assert.equal(ui.element("messageInput").disabled, true);
  assert.equal(ui.state.visibleMessages.at(-1).content, "最後の無料の返答。");
  assert.match(ui.usageSummaryText(), /今日の無料 残り0\/3往復/);
  ui.updateUsageMeter();
  for (const text of [ui.usageSummaryText(), ui.element("meterInner").innerHTML,
    ui.element("chatStatus").innerHTML, ui.element("composerNote").textContent]) {
    assert.doesNotMatch(text, /旧購入|灯火|有料|207/);
  }
  ui.element("messageInput").value = "4回目は送信されない";
  await ui.handleSend(event());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].expectChargeSource, "trial");
  assert.equal(ui.state.user.credits, 207);
  for (const sage of philosophers) assert.equal(ui.canStartReply(sage.id), false);
});

test("trial retry keeps UUID and never decrements trial optimistically or twice", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser();
  ui.element("messageInput").value = "同じ問い";
  const sent = [];
  ui.api.sendChat = async body => {
    sent.push(structuredClone(body));
    if (sent.length === 1) throw Object.assign(new Error(), { code: "REQUEST_PENDING", status: 409 });
    return { conversationId: "conversation-1", reply: "同じ返答", usageSource: "trial", user: trialUser(2) };
  };
  await ui.handleSend(event());
  assert.equal(ui.trialRemaining(), 3);
  assert.equal(ui.state.user.credits, 0);
  await ui.handleSend(event());
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(ui.trialRemaining(), 2);
  assert.equal(sent[0].expectChargeSource, "trial");
  assert.equal(ui.state.user.credits, 0);
});

test("definitive trial generation failure does not consume free allowance", async () => {
  const ui = setup({ getMe: async () => trialUser(), sendChat: async () => { throw Object.assign(new Error(), { code: "GENERATION_FAILED", status: 502 }); } });
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser();
  ui.element("messageInput").value = "失敗する問い";
  await ui.handleSend(event());
  assert.equal(ui.trialRemaining(), 3);
  assert.equal(ui.state.pendingChat, null);
  assert.match(ui.element("chatStatus").innerHTML, /無料回数.*消費されていません/);
  assert.doesNotMatch(ui.element("chatStatus").innerHTML, /灯火|購入/);
});

test("trial promotion budget failure never falls back to spending paid balance", async () => {
  const ui = setup({ getMe: async () => trialUser(3, 40) });
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(3, 40);
  ui.element("messageInput").value = "受付上限の問い";
  ui.api.sendChat = async body => { ui.calls.chat.push(body); throw Object.assign(new Error(), { code: "TRIAL_BUDGET_EXHAUSTED", status: 503 }); };
  await ui.handleSend(event());
  assert.equal(ui.calls.chat.length, 1);
  assert.equal(ui.state.user.credits, 40);
  assert.equal(ui.trialRemaining(), 3);
  assert.equal(ui.state.pendingChat, null);
  assert.match(ui.element("chatStatus").innerHTML, /無料体験の受付上限/);
});

test("non-Google account is not given a trial by client UI", () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = { ...trialUser(), trial_eligible: false };
  assert.equal(ui.trialRemaining(), 0);
  assert.equal(ui.canStartReply("socrates"), false);
  assert.match(ui.renderTrialOffer(), /このアカウントでは無料対話を利用できません/);
});

test("reserved trial reply cannot be reused and is described as pending, not exhausted", () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = { ...trialUser(0), trial_balance: 1, trial_reserved: 1 };
  assert.equal(ui.canStartReply(), false);
  ui.updateChatAccess();
  assert.match(ui.element("chatAccessNotice").innerHTML, /返答を確認中/);
  assert.doesNotMatch(ui.renderTrialOffer(), /終了しました/);
});

test("stale trial exhaustion blocks a second send even when old credits remain", async () => {
  const ui = setup({ getMe: async () => trialUser(0, 207) });
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(1, 207);
  ui.element("messageInput").value = "別タブとの境界で送る問い";
  const sent = [];
  ui.api.sendChat = async body => {
    sent.push(structuredClone(body));
    throw Object.assign(new Error(), { code: "BALANCE_CHANGED", status: 409 });
  };
  await ui.handleSend(event());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].expectChargeSource, "trial");
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.state.user.credits, 207);
  assert.equal(ui.trialRemaining(), 0);
  assert.doesNotMatch(ui.element("composerNote").textContent, /購入|灯火|有料/);
  assert.doesNotMatch(ui.element("chatStatus").innerHTML, /購入|灯火|有料/);
  await ui.handleSend(event());
  assert.equal(sent.length, 1);
  assert.equal(ui.state.user.credits, 207);
});

for (const source of ["paid", undefined]) {
  for (const placement of ["storage", "memory"]) {
    test(`${placement} pending with ${source || "missing"} intent is discarded without a model request`, async () => {
      const ui = setup();
      ui.state.trial = { enabled: true };
      ui.state.user = trialUser(3, 207);
      const pending = { ownerId: user.id, ownerKind: "account", requestId: randomUUID(),
        philosopherId: "socrates", conversationId: null, message: "旧版の未確認の問い",
        ...(source ? { expectChargeSource: source } : {}) };
      ui.storage.set("dialogos.v3.pendingChat", JSON.stringify(pending));
      if (placement === "memory") {
        ui.state.pendingChat = pending;
        ui.element("messageInput").value = "このクリックで新しい問いにも置き換えない";
        await ui.handleSend(event());
      } else {
        ui.restorePendingChat();
      }
      assert.equal(ui.state.pendingChat, null);
      assert.equal(ui.storage.has("dialogos.v3.pendingChat"), false);
      assert.equal(ui.calls.chat.length, 0);
      assert.equal(ui.calls.proofs, undefined);
      assert.equal(ui.state.user.credits, 207);
      assert.equal(ui.trialRemaining(), 3);
    });
  }
  test(`restore rejects in-memory ${source || "missing"} intent instead of trusting its owner match`, () => {
    const ui = setup();
    ui.state.user = trialUser(3, 207);
    ui.state.pendingChat = { ownerId: user.id, ownerKind: "account", requestId: randomUUID(),
      philosopherId: "socrates", message: "旧版", ...(source ? { expectChargeSource: source } : {}) };
    ui.storage.set("dialogos.v3.pendingChat", JSON.stringify(ui.state.pendingChat));
    ui.restorePendingChat();
    assert.equal(ui.state.pendingChat, null);
    assert.equal(ui.storage.has("dialogos.v3.pendingChat"), false);
  });
}

test("explicit trial pending restores and retries identically even with no daily allowance left", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(0, 207);
  const pending = { ownerId: user.id, ownerKind: "account", requestId: randomUUID(),
    philosopherId: "socrates", conversationId: "saved-conversation", message: "無料の未確認の問い", expectChargeSource: "trial" };
  ui.storage.set("dialogos.v3.pendingChat", JSON.stringify(pending));
  ui.restorePendingChat();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.state.pendingChat)), pending);
  const sent = [];
  ui.api.sendChat = async body => {
    sent.push(structuredClone(body));
    return { conversationId: "saved-conversation", reply: "保存済み無料の返答", usageSource: "trial", user: trialUser(0, 207) };
  };
  await ui.handleSend(event());
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [pending]);
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.state.user.credits, 207);
});

test("midnight refresh waits for server confirmation and backs off five minutes on a stale reset or fast clock", () => {
  const ui = setup();
  const now = Date.parse("2026-09-21T15:00:00.000Z");
  assert.equal(ui.trialRefreshDelay(now - 1, now), 300000);
  assert.equal(ui.trialRefreshDelay(now, now), 300000);
  assert.equal(ui.trialRefreshDelay(now + 10000, now), 11000);
});

test("rendering the login gate removes no-longer-visible conversation from takeaway state", () => {
  const ui = setup();
  ui.state.visibleMessages = [{ role: "user", content: "previous conversation" }];
  ui.renderLoginGate();
  assert.equal(ui.state.visibleMessages.length, 0);
  assert.match(ui.element("app").innerHTML, /人格を無料で持ち帰る/);
});

for (const signedOut of [false, true]) {
  test(`${signedOut ? "auth loss" : "account switch"} closes the export modal and invalidates its private snapshot`, async () => {
    const ui = setup({ getMe: async () => {
      if (signedOut) throw Object.assign(new Error(), { status: 401 });
      return { ...user, id: "different-account" };
    } });
    ui.state.user = { ...user };
    ui.state.visibleMessages = [{ role: "user", content: "private previous account" }];
    const modal = ui.element("takeawayDialog");
    modal.open = true;
    modal.close = () => { modal.open = false; modal.closed = true; };
    modal.remove = () => { modal.removed = true; };
    await ui.refreshUser();
    assert.equal(modal.closed, true);
    assert.equal(modal.removed, true);
    assert.equal(ui.state.visibleMessages.length, 0);
    assert.equal(ui.state.activeRequestId, null);
    assert.equal(ui.state.conversationId, null);
  });
}

test("late reply from a previous account cannot replace the new account or reveal its reply", async () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = trialUser(3, 207);
  ui.element("messageInput").value = "previous account question";
  let finish;
  ui.api.sendChat = () => new Promise(resolve => { finish = resolve; });
  const request = ui.handleSend(event());
  ui.api.getMe = async () => ({ ...user, id: "different-account", credits: 70 });
  await ui.refreshUser();
  finish({ reply: "private previous account reply", conversationId: "old", usageSource: "trial", user: trialUser(2, 207) });
  await request;
  assert.equal(ui.state.user.id, "different-account");
  assert.equal(ui.state.user.credits, 70);
  assert.equal(ui.state.conversationId, null);
  assert.equal(ui.state.loading, false);
  assert.equal(ui.state.visibleMessages.length, 0);
  assert.equal(ui.element("chatArea").children.some(node => node.innerHTML.includes("private previous account reply")), false);
});

function enableGuest(ui, remaining = 3) {
  ui.state.user = guestUser(remaining);
  ui.state.trial = { enabled: true };
  ui.state.anonymousEnabled = true;
  ui.state.turnstileSiteKey = "mock-site-key";
  return ui;
}

for (const salesEnabled of [false, true]) {
  test(`public boot ignores salesEnabled=${salesEnabled} and fetches no packages or guest session`, async () => {
    const calls = [];
    const ui = setup({ getConfig: async () => { calls.push("config"); return { ...trialConfig, salesEnabled }; },
      getMe: async () => { throw Object.assign(new Error(), { status: 401 }); },
      getPackages: async () => { calls.push("packages"); return { packages }; },
      getGuestMe: async () => { calls.push("guest"); return guestUser(); } });
    await ui.boot();
    assert.deepEqual(calls, ["config"]);
    assert.equal(ui.calls.proofs, undefined);
    assert.equal(ui.calls.checkout, 0);
    assert.equal(ui.state.anonymousEnabled, true);
    assert.equal((ui.element("app").innerHTML.match(/data-chat=/g) || []).length, 14);
  });
}

test("guest start waits for session proof and existing cookie does not reset exhausted quota", async () => {
  const ui = setup({ getGuestMe: async () => { throw Object.assign(new Error(), { status: 401, code: "GUEST_SESSION_REQUIRED" }); } });
  await ui.loadConfig();
  ui.state.anonymousEnabled = true;
  ui.state.turnstileSiteKey = "mock-site-key";
  let resolveProof, sessions = 0;
  ui.context.requestTurnstileToken = () => new Promise(resolve => { resolveProof = resolve; });
  ui.api.startGuestSession = async token => { sessions++; assert.equal(token, "session-proof"); return guestUser(); };
  const starting = ui.handleGuestStart();
  await new Promise(setImmediate);
  assert.equal(sessions, 0);
  resolveProof("session-proof");
  await starting;
  assert.equal(ui.state.user.is_guest, true);
  assert.equal(sessions, 1);
  ui.state.user = null;
  ui.api.getGuestMe = async () => guestUser(0);
  await ui.handleGuestStart();
  assert.equal(ui.trialRemaining(), 0);
  assert.equal(sessions, 1);
  assert.equal(ui.calls.login, 0);
});

test("guest 3 replies share all sages, preserve third reply, and block fourth without proof or POST", async () => {
  const ui = enableGuest(setup());
  const sent = [];
  ui.api.sendGuestChat = async body => {
    sent.push(structuredClone(body));
    return { requestId: body.requestId, reply: `guest reply ${sent.length}`, conversationId: "guest-conversation", user: guestUser(3 - sent.length) };
  };
  for (const philosopherId of ["socrates", "nietzsche", "buddha", "confucius"]) {
    ui.state.philosopherId = philosopherId;
    ui.element("messageInput").value = "What is good?";
    await ui.handleSend(event());
  }
  assert.equal(sent.length, 3);
  assert.equal(ui.calls.proofs.length, 3);
  assert.deepEqual(sent.map(body => body.expectChargeSource), ["trial", "trial", "trial"]);
  assert.equal(ui.calls.proofs.every((options, index) => options.action === "guest_chat" && options.requestId === sent[index].requestId), true);
  assert.equal(ui.state.visibleMessages.at(-1).content, "guest reply 3");
  assert.match(ui.element("chatAccessNotice").innerHTML, /人格を無料で持ち帰る/);
  assert.equal(ui.calls.chat.length, 0);
});

test("cancelled guest proof generates nothing and persists no proof or pending request", async () => {
  const ui = enableGuest(setup());
  ui.context.requestTurnstileToken = async () => { throw Object.assign(new Error(), { code: "TURNSTILE_CANCELLED" }); };
  let sent = 0;
  ui.api.sendGuestChat = async () => { sent++; };
  ui.element("messageInput").value = "my question";
  await ui.handleSend(event());
  assert.equal(sent, 0);
  assert.equal(ui.trialRemaining(), 3);
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.storage.has("dialogos.v3.pendingChat"), false);
  assert.equal(ui.state.loading, false);
});

test("unknown guest reply retries same UUID without a fresh proof; proof is never persisted", async () => {
  const ui = enableGuest(setup());
  const sent = [];
  ui.api.sendGuestChat = async body => {
    sent.push(structuredClone(body));
    if (sent.length === 1) throw Object.assign(new Error(), { code: "REQUEST_UNKNOWN", status: 409 });
    return { reply: "saved reply", conversationId: "guest", user: guestUser(2) };
  };
  ui.element("messageInput").value = "my question";
  await ui.handleSend(event());
  assert.doesNotMatch(ui.storage.get("dialogos.v3.pendingChat"), /mock-proof|turnstileToken/);
  await ui.handleSend(event());
  assert.equal(ui.calls.proofs.length, 1);
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(sent[1].turnstileToken, undefined);
  assert.equal(ui.trialRemaining(), 2);
});

test("proof refusal preserves UUID and obtains fresh proof only after another explicit retry", async () => {
  const ui = enableGuest(setup());
  const sent = [];
  ui.api.sendGuestChat = async body => {
    sent.push(structuredClone(body));
    if (sent.length === 1) throw Object.assign(new Error(), { code: "TURNSTILE_FAILED", status: 403 });
    return { reply: "reply", conversationId: "guest", user: guestUser(2) };
  };
  ui.element("messageInput").value = "my question";
  await ui.handleSend(event());
  assert.equal(sent.length, 1);
  assert.equal(ui.trialRemaining(), 3);
  assert.equal(ui.state.pendingChat.needsProof, true);
  await ui.handleSend(event());
  assert.equal(ui.calls.proofs.length, 2);
  assert.equal(sent[0].requestId, sent[1].requestId);
});

test("expired guest cookie clears pending rather than transferring it into a new identity", async () => {
  const ui = enableGuest(setup());
  ui.api.sendGuestChat = async () => { throw Object.assign(new Error(), { code: "GUEST_SESSION_REQUIRED", status: 401 }); };
  ui.element("messageInput").value = "my question";
  await ui.handleSend(event());
  assert.equal(ui.state.user, null);
  assert.equal(ui.state.pendingChat, null);
  assert.equal(ui.storage.has("dialogos.v3.pendingChat"), false);
  assert.match(ui.element("app").innerHTML, /ログインせずに試す/);
});

test("new account from empty identity invalidates a delayed guest session response", async () => {
  const ui = setup({ getGuestMe: async () => { throw Object.assign(new Error(), { status: 401, code: "GUEST_SESSION_REQUIRED" }); } });
  ui.state.anonymousEnabled = true;
  ui.state.turnstileSiteKey = "mock-site-key";
  let resolveSession;
  ui.api.startGuestSession = () => new Promise(resolve => { resolveSession = resolve; });
  const starting = ui.handleGuestStart();
  await new Promise(setImmediate);
  await ui.refreshUser({ account: true });
  resolveSession(guestUser());
  await starting;
  assert.equal(ui.state.user.id, user.id);
  assert.equal(ui.state.user.logged_in, true);
  assert.equal(ui.state.guestStarting, false);
});

test("account switch while guest proof is pending suppresses its model request", async () => {
  const ui = enableGuest(setup());
  let resolveProof, sent = 0;
  ui.context.requestTurnstileToken = () => new Promise(resolve => { resolveProof = resolve; });
  ui.api.sendGuestChat = async () => { sent++; };
  ui.element("messageInput").value = "private question";
  const sending = ui.handleSend(event());
  await ui.refreshUser({ account: true });
  resolveProof("old-proof");
  await sending;
  assert.equal(sent, 0);
  assert.equal(ui.state.user.id, user.id);
  assert.equal(ui.state.visibleMessages.length, 0);
});

test("guest sidebar never queries account history; old history response is discarded after identity change", async () => {
  let finish, historyCalls = 0;
  const ui = enableGuest(setup({ getHistory: () => { historyCalls++; return new Promise(resolve => { finish = resolve; }); } }));
  await ui.loadSidebarHistory();
  assert.equal(historyCalls, 0);
  ui.state.user = user;
  const loading = ui.loadSidebarHistory();
  ui.invalidatePrivateView();
  ui.state.user = guestUser();
  finish([{ id: "private-history", philosopher_id: "socrates" }]);
  await loading;
  assert.equal(ui.state.history.length, 0);
  assert.doesNotMatch(ui.element("sidebarHistoryList").innerHTML, /private-history/);
});

test("missing anonymous key disables trial start while all persona copies remain available", async () => {
  const ui = setup({ getConfig: async () => ({ ...trialConfig, turnstileSiteKey: "" }) });
  await ui.loadConfig();
  await ui.handleGuestStart();
  ui.renderGuestGate();
  assert.equal(ui.state.anonymousEnabled, false);
  assert.equal(ui.calls.proofs, undefined);
  assert.match(ui.element("app").innerHTML, /data-guest-start disabled/);
  assert.match(ui.element("app").innerHTML, /data-takeaway=/);
});

test("responsive images use WebP dimensions, lazy nonfirst cards and small chat icons", () => {
  const ui = setup(), sage = philosophers[0];
  assert.match(ui.renderAvatar(sage, "card"), /srcset=.*320w.*640w/s);
  assert.match(ui.renderAvatar(sage, "card"), /loading="lazy"/);
  assert.match(ui.renderAvatar(sage, "card", true), /loading="eager".*fetchpriority="high"/);
  assert.match(ui.renderAvatar(sage, "bust"), /profile-128.webp/);
  assert.doesNotMatch(ui.renderAvatar(sage, "bust"), /srcset=/);
});

test("guest API sends same-origin cookie without bearer token, owner metadata or guest ID", async () => {
  const calls = [];
  const context = { getAccessToken: async () => { throw new Error("must not request account auth"); },
    fetch: async (path, options) => { calls.push({ path, ...options }); return { ok: true, json: async () => guestUser() }; } };
  vm.runInNewContext(apiSource + "\nglobalThis.api = apiService;", context);
  await context.api.getGuestMe();
  await context.api.startGuestSession("session-proof");
  await context.api.sendGuestChat({ philosopherId: "buddha", requestId: randomUUID(), message: "question", expectChargeSource: "trial", turnstileToken: "chat-proof", ownerId: "must-not-send", ownerKind: "guest" });
  assert.deepEqual(calls.map(call => call.path), ["/api/guest/me", "/api/guest/session", "/api/guest/chat"]);
  assert.equal(calls.every(call => call.credentials === "same-origin" && !call.headers.Authorization), true);
  assert.doesNotMatch(calls[2].body, /ownerId|ownerKind|must-not-send/);
});

test("shared sage entry opens only its anonymous start gate without login, challenge or generation", async () => {
  const paths = [];
  const ui = setup({ getConfig: async () => trialConfig, getMe: async () => { throw Object.assign(new Error(), { status: 401 }); },
    getGuestMe: async () => { paths.push("guest"); return guestUser(); } });
  ui.context.window.location.search = "?sage=buddha&utm_source=x&conversation=private&access_token=secret";
  ui.context.window.location.pathname = "/";
  ui.context.history = { replaceState: (_state, _title, url) => { paths.push(url); } };
  await ui.boot();
  assert.equal(ui.state.philosopherId, "buddha");
  assert.equal(ui.state.route, "chat");
  assert.equal(ui.state.conversationId, null);
  assert.match(ui.element("app").innerHTML, /ブッダと、少し話してみる/);
  assert.match(ui.element("app").innerHTML, /ログインせずに試す/);
  assert.deepEqual(paths, ["/?sage=buddha"]);
  assert.equal(ui.calls.login, 0);
  assert.equal(ui.calls.proofs, undefined);
  assert.equal(ui.calls.chat.length, 0);
});

test("sharing controls require canonical metadata and never include visible conversation", () => {
  const ui = setup();
  assert.equal(ui.renderShareActions(), "");
  ui.element('link[rel="canonical"]').getAttribute = () => "https://dialogos.example.com/";
  ui.state.visibleMessages = [{ role: "user", content: "secret private question" }];
  const html = ui.renderShareActions("buddha");
  assert.match(html, /Xで紹介する/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /secret|private|question|conversation/);
});

test("public link copy awaits clipboard success and falls back to manual selection on refusal", async () => {
  const ui = setup();
  ui.element('link[rel="canonical"]').getAttribute = () => "https://dialogos.example.com/";
  ui.context.window.isSecureContext = true;
  const status = new Element(), field = new Element();
  field.select = () => { field.selected = true; };
  const button = { dataset: { copyShare: "buddha" }, closest: () => ({ querySelector: selector => selector === ".public-share-status" ? status : field }) };
  let finish;
  ui.context.navigator.clipboard = { writeText: url => {
    assert.equal(url, "https://dialogos.example.com/?sage=buddha");
    return new Promise(resolve => { finish = resolve; });
  } };
  const copying = ui.copyPublicLink(button);
  assert.equal(status.textContent, "");
  finish();
  await copying;
  assert.match(status.textContent, /コピーしました/);
  ui.context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await ui.copyPublicLink(button);
  assert.equal(field.selected, true);
  assert.equal(field.value, "https://dialogos.example.com/?sage=buddha");
  assert.match(status.textContent, /手動でコピー/);
  assert.doesNotMatch(status.textContent, /コピーしました/);
});

test("sage introductions label their opening text as creative rather than a verified primary quote", () => {
  for (const sage of philosophers) assert.equal(sage.welcomeAttr, "思想に着想を得た創作");
  assert.doesNotMatch(getPhilosopherById("socrates").description, /答えを与える者ではない/);
  assert.doesNotMatch(getPhilosopherById("plato").description, /ただの影/);
  assert.doesNotMatch(getPhilosopherById("aristotle").description, /だけを問う/);
  assert.match(getPhilosopherById("schopenhauer").description, /同情/);
});

function assertNoPaymentCalls(ui) {
  for (const name of ["checkout", "packages", "sync", "subscription", "portal", "cancel"]) {
    assert.equal(ui.calls[name], 0, name);
  }
}

for (const route of ["purchase", "subscription", "cancel"]) {
  for (const loggedIn of [false, true]) {
    test(`legacy ${route} URL is inert and returns to list while ${loggedIn ? "signed in" : "anonymous"}`, async () => {
      const ui = setup({ getConfig: async () => ({ ...trialConfig, salesEnabled: true }), getMe: async () => {
        if (!loggedIn) throw Object.assign(new Error(), { status: 401 });
        return { ...trialUser(3, 207), subscription_status: "active" };
      } });
      ui.context.window.location.search = `?route=${route}&sage=plato`;
      await ui.boot();
      assert.equal(ui.state.route, "list");
      assert.equal(ui.state.conversationId, null);
      assert.deepEqual(ui.calls.replacements, ["/"]);
      assert.equal(ui.calls.login, 0);
      assert.equal(ui.calls.chat.length, 0);
      assert.equal(ui.calls.proofs, undefined);
      assertNoPaymentCalls(ui);
      assert.doesNotMatch(ui.element("app").innerHTML, /以前の購入|以前の契約|月額契約|Stripe|data-pkg/);
    });
  }
  test(`legacy ${route} navigation and OAuth return cannot reopen its removed view`, async () => {
    const ui = setup({ getConfig: async () => trialConfig, getMe: async () => trialUser(3, 207) });
    ui.storage.set("dialogos.v3.returnTo", JSON.stringify({ route, philosopherId: "plato", conversationId: "old-conversation" }));
    await ui.boot();
    assert.equal(ui.state.route, "list");
    assert.equal(ui.storage.has("dialogos.v3.returnTo"), false);
    ui.navigate(route);
    assert.equal(ui.state.route, "list");
    assertNoPaymentCalls(ui);
  });
}

for (const query of [
  "?checkout=success&session_id=cs_old_test_12345678",
  "?payment=success&session_id=cs_old_test_12345678",
  "?checkout=success",
  "?checkout=cancelled",
  "?payment=cancelled",
  "?checkout=unknown",
]) {
  test(`legacy payment return ${query} does not synchronize or advertise a purchase`, async () => {
    const ui = setup({ getConfig: async () => trialConfig, getMe: async () => trialUser(3, 207) });
    ui.context.window.location.search = query + "&sage=socrates";
    ui.storage.set("dialogos.pendingSession", "cs_saved_test_12345678");
    await ui.boot();
    assert.equal(ui.state.route, "list");
    assert.equal(ui.storage.has("dialogos.pendingSession"), false);
    assert.deepEqual(ui.calls.replacements, ["/"]);
    assertNoPaymentCalls(ui);
    assert.equal(ui.calls.chat.length, 0);
    assert.equal(ui.calls.login, 0);
    assert.doesNotMatch(ui.element("successBanner").innerHTML + ui.element("app").innerHTML, /購入内容|残高|以前の購入|Stripe/);
  });
}

test("plain boot also removes obsolete saved payment session without a synchronization request", async () => {
  const ui = setup({ getConfig: async () => trialConfig, getMe: async () => trialUser(3, 207) });
  ui.storage.set("dialogos.pendingSession", "cs_saved_test_12345678");
  await ui.boot();
  assert.equal(ui.storage.has("dialogos.pendingSession"), false);
  assertNoPaymentCalls(ui);
});

test("active legacy contract and reserved credits never appear in public navigation or usage text", () => {
  const ui = setup();
  ui.state.trial = { enabled: true };
  ui.state.user = { ...trialUser(2, 207), credits_reserved: 1, subscribed: true, subscription_status: "active" };
  ui.renderAuthNav();
  ui.updateUsageMeter();
  for (const text of [ui.element("authNav").innerHTML, ui.element("meterInner").innerHTML,
    ui.usageSummaryText(), ui.composerNoteText()]) {
    assert.doesNotMatch(text, /購入|灯火|契約|有料|207|data-route="(?:purchase|subscription|cancel)"/);
  }
});

test("Google history route remains available without restoring payment UI", async () => {
  let historyCalls = 0;
  const ui = setup({ getConfig: async () => trialConfig, getMe: async () => trialUser(3, 207),
    getHistory: async () => { historyCalls++; return []; } });
  ui.context.window.location.search = "?route=history";
  await ui.boot();
  assert.equal(ui.state.route, "history");
  assert.equal(historyCalls, 1);
  assert.match(ui.element("app").innerHTML, /賢者との記録/);
  assertNoPaymentCalls(ui);

  const anonymous = setup({ getMe: async () => { throw Object.assign(new Error(), { status: 401 }); } });
  anonymous.context.window.location.search = "?route=history";
  await anonymous.boot();
  assert.equal(anonymous.state.route, "history");
  assert.match(anonymous.element("app").innerHTML, /Googleでログイン/);
  assert.equal(anonymous.calls.login, 0);
  assertNoPaymentCalls(anonymous);
});
