import express from "express";
import Stripe from "stripe";
import { createHash } from "node:crypto";
import { buildDialogueInstructions, buildDialogueInput, parseDialogueResponse, DIALOGUE_SCHEMA } from "../shared/dialogue.js";
import { guestSecurity, virtualGuest } from "./guest-security.js";

export const PACKAGES = Object.freeze([
  { id: "v3_40", name: "灯火 40", kind: "credits", credits: 40, price_jpy: 100, description: "40回の対話。自動更新なし。" },
  { id: "v3_140", name: "灯火 140", kind: "credits", credits: 140, price_jpy: 300, description: "140回の対話。自動更新なし。" },
  { id: "v3_500", name: "灯火 500", kind: "credits", credits: 500, price_jpy: 1000, description: "500回の対話。自動更新なし。" },
]);
export const LEGACY_PACKAGES = Object.freeze([
  { id: "memory_book_monthly", kind: "subscription", credits: 60, price_jpy: 680, price_id: "price_1Tc42DR4lgjy27fJW85jwg3v" },
  { id: "embers_150", kind: "credits", credits: 20, price_jpy: 500, price_id: "price_1Tc44SR4lgjy27fJdXiFNQP7" },
  { id: "embers_400", kind: "credits", credits: 60, price_jpy: 1000, price_id: "price_1Tc45TR4lgjy27fJrWhyAqk4" },
  { id: "embers_1000", kind: "credits", credits: 160, price_jpy: 2000, price_id: "price_1Tc45vR4lgjy27fJkehRTmqu" },
]);
export const MODEL = "gpt-5.4-mini";
export const MAX_INPUT_TOKENS = 6000;
export const MAX_OUTPUT_TOKENS = 900;
export const MAX_COST_MICRO = 8550; // 6000 * .75 + 900 * 4.5 micro-USD. Cache savings are not assumed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sid = value => typeof value === "string" ? value : value?.id || null;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const error = (status, code, message) => Object.assign(new Error(message || code), { status, code, publicMessage: message });
const q = encodeURIComponent;

export function publicUser(user) {
  if (user.is_guest) user = { ...user, credits: 0, reserved_credits: 0, email: null, avatar_url: null,
    display_name: "", subscription_status: null, subscription_plan: null, subscription_current_period_end: null, subscription_cancel_at_period_end: false };
  const available = Math.max(0, Number(user.credits || 0) - Number(user.reserved_credits || 0));
  const trialBalance = Number(user.trial_remaining || 0);
  const trialReserved = Number(user.trial_reserved || 0);
  const trialAvailable = user.trial_eligible ? Math.max(0, trialBalance - trialReserved) : 0;
  return {
    id: user.id, logged_in: !user.is_guest, is_guest: user.is_guest === true, email: user.email || null, avatar_url: user.avatar_url || null,
    display_name: user.display_name || "", credits: available, remaining: available,
    credit_balance: Number(user.credits || 0), credits_reserved: Number(user.reserved_credits || 0),
    free_count: 0, hasLongTermMemory: !user.is_guest, unlocked_characters: ["all"],
    trial_remaining: trialAvailable, trial_balance: trialBalance, trial_reserved: trialReserved,
    trial_used: Math.max(0, 3 - trialBalance), trial_eligible: Boolean(user.trial_eligible),
    trial_day: user.trial_day || null, trial_resets_at: user.trial_resets_at || null,
    trial_resetsAt: user.trial_resets_at || null, trial_limit: 3, trial_resetTimezone: "Asia/Tokyo",
    remainingFor: { socrates: available + trialAvailable, other: available + trialAvailable, all: available + trialAvailable },
    subscribed: ["active", "trialing"].includes(user.subscription_status),
    subscription_status: user.subscription_status || null, subscription_plan: user.subscription_plan || null,
    subscription_current_period_end: user.subscription_current_period_end || null,
    subscription_cancel_at_period_end: Boolean(user.subscription_cancel_at_period_end),
  };
}

export function costMicro(usage) {
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  if (![input, output, cached].every(Number.isSafeInteger) || input < 0 || output < 0 || cached < 0 || cached > input) {
    throw error(502, "USAGE_UNKNOWN", "利用量を確認できないため、処理を保留しています。");
  }
  return Math.ceil(((input - cached) * 750 + cached * 75 + output * 4500) / 1000);
}

export function validateChat(body) {
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || [...message].length > 1000) throw error(400, "INVALID_MESSAGE", "問いは1〜1,000文字で入力してください。");
  if (!UUID.test(body?.requestId || "")) throw error(400, "INVALID_REQUEST_ID", "送信識別子が無効です。画面を再読み込みしてください。");
  if (body.conversationId != null && !UUID.test(body.conversationId)) throw error(400, "INVALID_CONVERSATION", "対話の識別子が無効です。");
  if (typeof body.philosopherId !== "string" || body.philosopherId.length > 80) throw error(400, "INVALID_PHILOSOPHER", "賢者を選択してください。");
  try { buildDialogueInstructions(body.philosopherId); } catch { throw error(400, "INVALID_PHILOSOPHER", "この賢者は選択できません。"); }
  if (body.expectChargeSource != null && !["trial", "paid"].includes(body.expectChargeSource)) throw error(400, "INVALID_CHARGE_SOURCE", "対話の利用条件を確認してください。");
  const value = { philosopherId: body.philosopherId, message, conversationId: body.conversationId || null, requestId: body.requestId, expectChargeSource: body.expectChargeSource || null };
  const canonical = [value.philosopherId, value.message, value.conversationId];
  value.legacyFingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  value.fingerprint = value.expectChargeSource ? createHash("sha256").update(JSON.stringify([...canonical, value.expectChargeSource])).digest("hex") : value.legacyFingerprint;
  return value;
}

export function createStore(env, fetchImpl) {
  const base = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  async function request(path, options = {}) {
    if (!base || !key) throw error(503, "DB_NOT_CONFIGURED", "公開準備中です。");
    const response = await fetchImpl(`${base}/rest/v1/${path}`, {
      ...options, signal: AbortSignal.timeout(12000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...options.headers },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const known = /NETWORK_RATE_LIMITED|TURNSTILE_REQUIRED|TURNSTILE_FAILED|BALANCE_CHANGED|CHARGE_SOURCE_REQUIRED|TRIAL_BUDGET_EXHAUSTED|TRIAL_NOT_READY|BILLING_NOT_READY|AUTH_REQUIRED|REQUEST_CONFLICT|IN_FLIGHT|LOCKED|BUDGET_EXHAUSTED|CONVERSATION_NOT_FOUND|CUSTOMER_MISMATCH|PAYMENT_CONFLICT|RATE_LIMIT/.exec(data?.message || "")?.[0];
      const statuses = { NETWORK_RATE_LIMITED: 429, TURNSTILE_REQUIRED: 403, TURNSTILE_FAILED: 403, BALANCE_CHANGED: 409, CHARGE_SOURCE_REQUIRED: 400, AUTH_REQUIRED: 401, LOCKED: 402, IN_FLIGHT: 429, RATE_LIMIT: 429, BUDGET_EXHAUSTED: 503, REQUEST_CONFLICT: 409, CONVERSATION_NOT_FOUND: 404, CUSTOMER_MISMATCH: 403, PAYMENT_CONFLICT: 409 };
      const messages = { TRIAL_BUDGET_EXHAUSTED: "無料体験の受付上限に達しました。体験回数・灯火は消費していません。時間をおいてお試しください。", TRIAL_NOT_READY: "無料体験はただいま準備中です。", LOCKED: "サイト内で利用できる対話回数がありません。無料対話は全賢者合計1日3往復で、日本時間0時に更新されます。人格を無料で持ち帰り、ご自身のChatGPTで続きを楽しめます。", BUDGET_EXHAUSTED: "本日の対話受付上限に達しました。体験回数・灯火は消費していません。", RATE_LIMIT: "問いの送信は1分に6回までです。少し待ってからもう一度送信してください。灯火は消費していません。" };
      messages.BALANCE_CHANGED = "体験回数または灯火の利用条件が変わりました。残り回数を確認してから、もう一度送信してください。今回は消費していません。";
      messages.NETWORK_RATE_LIMITED = "この接続元からの試用が集中しています。時間をおいてお試しください。人格の持ち帰りは利用できます。";
      messages.TURNSTILE_REQUIRED = messages.TURNSTILE_FAILED = "不正利用防止の確認をやり直してください。無料回数は消費していません。";
      throw error(statuses[known] || 503, known === "RATE_LIMIT" ? "RATE_LIMITED" : known || "DB_UNAVAILABLE", messages[known] || "処理を完了できませんでした。");
    }
    return data;
  }
  return {
    get: (table, filter) => request(`${table}?${filter}`),
    patch: (table, filter, value) => request(`${table}?${filter}`, { method: "PATCH", body: JSON.stringify(value) }),
    rpc: (name, args) => request(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) }),
  };
}

export function createApi({ env = process.env, fetchImpl = globalThis.fetch, store = null, stripeClient, authenticate } = {}) {
  const app = express();
  const db = store || createStore(env, fetchImpl);
  const stripe = stripeClient === undefined ? (env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 15000 }) : null) : stripeClient;
  const dailyLimit = positiveUSD(env.API_DAILY_BUDGET_USD ?? "3");
  const monthlyLimit = positiveUSD(env.API_MONTHLY_BUDGET_USD ?? "30");
  const trialDailyLimit = positiveUSD(env.API_TRIAL_DAILY_BUDGET_USD ?? "0.50");
  const trialMonthlyLimit = positiveUSD(env.API_TRIAL_MONTHLY_BUDGET_USD ?? "5");
  const baseUrl = validAppUrl(env.APP_URL);
  const guest = guestSecurity(env, fetchImpl);
  const anonymousEnabled = Boolean(env.ANONYMOUS_TRIAL_ENABLED === "true" && env.TRIAL_ENABLED === "true"
    && guest.ready && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.OPENAI_API_KEY
    && dailyLimit && monthlyLimit && trialDailyLimit && trialMonthlyLimit);
  app.disable("x-powered-by");
  app.use((req, res, next) => { if (req.url.startsWith("/api/")) req.url = req.url.slice(4); res.set("Cache-Control", "no-store"); next(); });

  async function requireBilling() {
    if (env.BILLING_ENABLED !== "true" || !stripe || !env.STRIPE_WEBHOOK_SECRET || !baseUrl || !dailyLimit || !monthlyLimit) {
      throw error(503, "BILLING_NOT_READY", "決済・対話の公開準備中です。");
    }
    await requireMigration();
  }
  async function requireMigration() {
    const versions = await db.get("dialogos_v3_schema", "version=eq.6&select=version&limit=1");
    if (!versions?.length) throw error(503, "MIGRATION_REQUIRED", "公開準備中です。");
  }
  async function getUser(id) {
    const user = await db.rpc("dialogos_v5_user_state", { p_user_id: id });
    if (!user) throw error(404, "USER_NOT_FOUND", "アカウントが見つかりません。");
    return user;
  }
  async function ownedCustomer(user) {
    if (!user.stripe_customer_id) throw error(404, "NO_CUSTOMER", "このアカウントの購入履歴はまだありません。");
    const owners = await db.get("users", `stripe_customer_id=eq.${q(user.stripe_customer_id)}&select=id&limit=2`);
    if (owners.length !== 1 || owners[0].id !== user.id) throw error(403, "CUSTOMER_MISMATCH", "購入履歴の本人確認が必要です。サポートにご連絡ください。");
    return user.stripe_customer_id;
  }
  async function grant(user, session, pack, paymentKey) {
    return db.rpc("dialogos_v3_grant", { p_user_id: user.id, p_payment_key: paymentKey,
      p_customer_id: sid(session.customer), p_package_id: pack.id, p_amount_jpy: session.amount_total,
      p_credits: pack.credits, p_kind: pack.kind });
  }

  async function fulfillSession(sessionId, expectedUserId = null) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items.data.price"] });
    if (session.payment_status !== "paid" || session.status !== "complete") throw error(409, "NOT_PAID", "お支払いを確認中です。少し待ってから再確認してください。");
    const isV3 = session.metadata?.billing_version === "3";
    const pack = (isV3 ? PACKAGES : LEGACY_PACKAGES).find(p => p.id === (isV3 ? session.metadata?.package_id : session.metadata?.packageId));
    if (!pack) throw error(400, "INVALID_PAYMENT", "購入内容を確認できません。");
    let user;
    if (isV3) {
      if (!UUID.test(session.metadata?.user_id || "") || session.client_reference_id !== session.metadata.user_id) throw error(400, "INVALID_PAYMENT");
      user = await getUser(session.metadata.user_id);
    } else {
      const users = await db.get("users", `guest_id=eq.${q(session.metadata?.guest_id || "")}&limit=2`);
      if (users.length !== 1) throw error(400, "LEGACY_OWNER_REQUIRED");
      [user] = users;
    }
    if (expectedUserId && expectedUserId !== user.id) throw error(403, "FORBIDDEN", "この購入は別のアカウントのものです。");
    const lines = session.line_items?.data || [];
    const line = lines[0];
    const correctLine = lines.length === 1 && line.quantity === 1 && line.price?.currency === "jpy" && line.price?.unit_amount === pack.price_jpy;
    if (!correctLine || session.currency !== "jpy" || session.amount_subtotal !== pack.price_jpy
      || (isV3 ? session.amount_total !== pack.price_jpy || session.mode !== "payment" : line.price.id !== pack.price_id || session.mode !== (pack.kind === "subscription" ? "subscription" : "payment"))
      || !Number.isSafeInteger(session.amount_total) || session.amount_total < 0 || session.amount_total > pack.price_jpy
      || !sid(session.customer)) throw error(400, "INVALID_PAYMENT", "購入金額・商品を確認できません。");
    if (user.stripe_customer_id) {
      if (await ownedCustomer(user) !== sid(session.customer)) throw error(403, "CUSTOMER_MISMATCH");
    } else if (isV3) throw error(403, "CUSTOMER_MISMATCH");
    // Existing legacy checkout fulfillment is preserved; no new subscription is created.
    let legacySubscription = null;
    if (!isV3 && pack.kind === "subscription" && sid(session.subscription)) {
      legacySubscription = await stripe.subscriptions.retrieve(sid(session.subscription));
      if (sid(legacySubscription.customer) !== sid(session.customer) || (user.subscription_id && user.subscription_id !== legacySubscription.id)) throw error(403, "CUSTOMER_MISMATCH");
    }
    await grant(user, session, pack, session.id);
    if (legacySubscription) await updateSubscription(user, legacySubscription);
  }

  async function updateSubscription(user, sub) {
    if (user.subscription_id && user.subscription_id !== sub.id) throw error(403, "SUBSCRIPTION_MISMATCH");
    const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
    await db.patch("users", `id=eq.${q(user.id)}`, { subscription_id: sub.id, subscription_status: sub.status,
      subscription_plan: "memory_book_monthly", subscription_cancel_at_period_end: Boolean(sub.cancel_at_period_end),
      ...(end ? { subscription_current_period_end: new Date(end * 1000).toISOString() } : {}) });
  }
  async function handleLegacyInvoice(invoice) {
    if (invoice.status !== "paid" || invoice.billing_reason !== "subscription_cycle") return;
    const subscriptionId = sid(invoice.subscription) || sid(invoice.parent?.subscription_details?.subscription);
    const customer = sid(invoice.customer);
    const [user] = await db.get("users", `subscription_id=eq.${q(subscriptionId || "")}&stripe_customer_id=eq.${q(customer || "")}&limit=1`);
    if (!user) throw error(400, "LEGACY_OWNER_REQUIRED");
    await ownedCustomer(user);
    const pack = LEGACY_PACKAGES[0];
    const lines = invoice.lines?.data || [];
    const line = lines[0];
    const priceId = sid(line?.price) || sid(line?.pricing?.price_details?.price);
    if (invoice.currency !== "jpy" || invoice.lines?.has_more || lines.length !== 1 || priceId !== pack.price_id || line.quantity !== 1
      || line.amount !== pack.price_jpy || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 0 || invoice.amount_paid > pack.price_jpy
      || line.proration || line.parent?.subscription_item_details?.proration) throw error(400, "INVALID_LEGACY_INVOICE");
    await grant(user, { customer, amount_total: invoice.amount_paid }, pack, `invoice_${invoice.id}`);
  }

  // Signature verification must see raw bytes before JSON parsing and before auth.
  app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), wrap(async (req, res) => {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw error(503, "STRIPE_NOT_CONFIGURED");
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.header("stripe-signature"), env.STRIPE_WEBHOOK_SECRET); }
    catch { throw error(400, "INVALID_SIGNATURE", "Invalid signature."); }
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      // Unpaid async sessions are acknowledged; their later paid event fulfills.
      if (event.data.object.payment_status === "paid") await fulfillSession(event.data.object.id);
    } else if (["invoice.paid", "invoice.payment_succeeded"].includes(event.type)) {
      const invoice = await stripe.invoices.retrieve(event.data.object.id);
      await handleLegacyInvoice(invoice);
    } else if (["customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      const sub = await stripe.subscriptions.retrieve(event.data.object.id);
      const [user] = await db.get("users", `subscription_id=eq.${q(sub.id)}&stripe_customer_id=eq.${q(sid(sub.customer) || "")}&limit=1`);
      if (user) { await ownedCustomer(user); await updateSubscription(user, sub); }
    }
    res.json({ received: true });
  }));

  app.use(express.json({ limit: "32kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, version: 3, billingEnabled: env.BILLING_ENABLED === "true" }));
  app.get("/config", (_req, res) => res.json({ supabaseUrl: env.SUPABASE_URL || "", supabaseAnonKey: env.SUPABASE_ANON_KEY || "", salesEnabled: env.SALES_ENABLED === "true", paidOnly: env.TRIAL_ENABLED !== "true", anonymousEnabled, turnstileSiteKey: anonymousEnabled ? env.TURNSTILE_SITE_KEY : "", trial: { enabled: env.TRIAL_ENABLED === "true", dailyReplies: 3, resetTimezone: "Asia/Tokyo", allPhilosophers: true, requiresGoogle: false } }));
  app.get("/packages", (_req, res) => res.json({ packages: PACKAGES }));

  function requireGuestReady() {
    if (!anonymousEnabled) throw error(503, "GUEST_NOT_READY", "サイト内の無料対話は準備中です。人格の持ち帰りは利用できます。");
  }
  async function guestState(id, recover = true) {
    const [existing] = await db.get("users", `id=eq.${q(id)}&limit=1`);
    if (!existing) return virtualGuest(id);
    if (!existing.is_guest || existing.auth_user_id !== `guest:v6:${id}`) throw error(401, "GUEST_SESSION_REQUIRED", "試用を開始し直してください。");
    if (recover) await db.rpc("dialogos_v3_release_stale", { p_user_id: id });
    return getUser(id);
  }
  function guestIdentity(req, mutation = false) {
    const network = guest.checkRequest(req, mutation);
    const session = guest.readCookie(req);
    if (!session) throw error(401, "GUEST_SESSION_REQUIRED", "試用の有効期限が切れました。試用を開始し直してください。");
    return { ...network, id: session.id };
  }
  app.post("/guest/session", wrap(async (req, res) => {
    requireGuestReady();
    const network = guest.checkRequest(req, true);
    await guest.verify(req.body?.turnstileToken, network, "guest_session");
    const existing = guest.readCookie(req);
    const issued = guest.issueCookie(existing?.id);
    // A new session creates no DB row (and needs no visit/issuance counter).
    // If an existing cookie is renewed, its quota is read, never reset.
    const user = existing ? await guestState(existing.id) : virtualGuest(issued.id);
    res.set("Set-Cookie", issued.header).json(publicUser(user));
  }));
  app.get("/guest/me", wrap(async (req, res) => {
    const session = guestIdentity(req);
    await requireMigration();
    res.json(publicUser(await guestState(session.id)));
  }));
  app.post("/guest/chat", wrap(async (req, res) => {
    const session = guestIdentity(req, true);
    const chat = validateChat(req.body);
    if (chat.expectChargeSource !== "trial") throw error(400, "INVALID_CHARGE_SOURCE", "匿名試用では無料対話だけを利用できます。");
    await requireMigration();
    req.user = await guestState(session.id);
    const [existing] = await db.get("dialogos_requests", `id=eq.${q(chat.requestId)}&user_id=eq.${q(session.id)}&limit=1`);
    if (existing) {
      if (existing.fingerprint !== chat.fingerprint) throw error(409, "REQUEST_CONFLICT", "同じ送信識別子に別の内容が指定されています。");
      return cachedResponse(existing, req, res);
    }
    requireGuestReady();
    if (Number(req.user.trial_remaining) - Number(req.user.trial_reserved || 0) <= 0) {
      throw error(402, "LOCKED", "今日の無料対話3往復は終了しました。日本時間0時に更新されます。続きは人格を無料で持ち帰って楽しめます。");
    }
    const proof = await guest.verify(req.body?.turnstileToken, session, "guest_chat", chat.requestId);
    const reservation = await db.rpc("dialogos_v6_guest_reserve", {
      p_guest_id: session.id, p_request_id: chat.requestId, p_fingerprint: chat.fingerprint,
      p_conversation_id: chat.conversationId, p_philosopher_id: chat.philosopherId, p_message: chat.message,
      p_reserve_micro: MAX_COST_MICRO, p_daily_limit_micro: dailyLimit, p_monthly_limit_micro: monthlyLimit,
      p_trial_daily_limit_micro: trialDailyLimit, p_trial_monthly_limit_micro: trialMonthlyLimit,
      p_network_hash: session.networkHash, p_proof_hash: proof,
    });
    if (!reservation.new_reservation) return cachedResponse(reservation, req, res);
    return runGeneration(req, res, chat, reservation);
  }));
  app.use((req, _res, next) => {
    (async () => {
      const bearer = /^Bearer ([^\s]+)$/.exec(req.header("authorization") || "")?.[1];
      if (!bearer || bearer.length > 8192) throw error(401, "AUTH_REQUIRED", "ログインしてからご利用ください。");
      let auth;
      if (authenticate) auth = await authenticate(bearer);
      else {
        if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw error(503, "AUTH_NOT_CONFIGURED", "公開準備中です。");
        const result = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
          headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10000),
        });
        if (!result.ok) throw error(401, "INVALID_TOKEN", "もう一度ログインしてください。");
        auth = await result.json();
      }
      if (!auth?.id || !UUID.test(auth.id)) throw error(401, "INVALID_TOKEN", "もう一度ログインしてください。");
      const googleSubject = !auth.is_anonymous && auth.identities?.find(identity => identity.provider === "google")?.identity_data?.sub;
      const googleHash = typeof googleSubject === "string" && googleSubject.length > 0 && googleSubject.length <= 256
        ? createHash("sha256").update(googleSubject).digest("hex") : null;
      req.user = await db.rpc("dialogos_v5_user", { p_auth_id: auth.id, p_email: auth.email || null, p_avatar: auth.user_metadata?.avatar_url || null, p_google_subject: googleHash });
      if (req.user.is_guest) throw error(401, "AUTH_REQUIRED", "アカウントでログインしてください。");
      if ((req.method === "GET" && req.path === "/me") || (req.method === "POST" && req.path === "/chat")) {
        const recovered = await db.rpc("dialogos_v3_release_stale", { p_user_id: req.user.id });
        if (recovered.released > 0) req.user = await getUser(req.user.id);
      }
    })().then(() => next(), next);
  });

  app.get("/me", wrap(async (req, res) => res.json(publicUser(req.user))));
  app.post("/me/name", wrap(async (req, res) => {
    const name = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
    if ([...name].length > 40) throw error(400, "INVALID_NAME", "表示名は40文字以内で入力してください。");
    await db.patch("users", `id=eq.${q(req.user.id)}`, { display_name: name });
    res.json(publicUser(await getUser(req.user.id)));
  }));
  app.get("/history", wrap(async (req, res) => {
    const rows = await db.get("conversations", `user_id=eq.${q(req.user.id)}&order=updated_at.desc&limit=50`);
    const conversations = await Promise.all(rows.map(async row => {
      const [last] = await db.get("messages", `conversation_id=eq.${q(row.id)}&order=id.desc&limit=1&select=content`);
      return { ...row, last_message: last?.content || "" };
    }));
    res.json({ conversations });
  }));
  app.get("/history/:conversationId/messages", wrap(async (req, res) => {
    if (!UUID.test(req.params.conversationId)) throw error(404, "CONVERSATION_NOT_FOUND");
    const [conversation] = await db.get("conversations", `id=eq.${q(req.params.conversationId)}&user_id=eq.${q(req.user.id)}&limit=1`);
    if (!conversation) throw error(404, "CONVERSATION_NOT_FOUND", "対話が見つかりません。");
    const latest = await db.get("messages", `conversation_id=eq.${q(conversation.id)}&order=id.desc&limit=501`);
    res.json({ conversation, messages: latest.slice(0, 500).reverse(), hasOlder: latest.length > 500 });
  }));
  app.get("/memories", wrap(async (req, res) => {
    const memories = await db.get("memories", `user_id=eq.${q(req.user.id)}&order=updated_at.desc&limit=40`);
    res.json({ memories });
  }));

  app.post("/stripe/checkout", wrap(async (req, res) => {
    if (env.SALES_ENABLED !== "true") throw error(410, "SALES_DISABLED", "新しい灯火の販売は終了しました。購入済みの灯火は引き続き利用できます。");
    await requireBilling();
    const pack = PACKAGES.find(p => p.id === req.body.packageId);
    if (!pack || !UUID.test(req.body.requestId || "")) throw error(400, "INVALID_PACKAGE", "購入内容を選び直してください。");
    let customer = req.user.stripe_customer_id;
    if (customer) await ownedCustomer(req.user);
    else {
      const created = await stripe.customers.create({ metadata: { user_id: req.user.id, billing_version: "3" }, ...(req.user.email ? { email: req.user.email } : {}) }, { idempotencyKey: `dialogos-v3-customer-${req.user.id}` });
      customer = created.id;
      await db.patch("users", `id=eq.${q(req.user.id)}&stripe_customer_id=is.null`, { stripe_customer_id: customer });
      // Another process cannot silently replace ownership.
      if ((await getUser(req.user.id)).stripe_customer_id !== customer) throw error(409, "CUSTOMER_MISMATCH");
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer, client_reference_id: req.user.id, payment_method_types: ["card"],
      line_items: [{ quantity: 1, price_data: { currency: "jpy", unit_amount: pack.price_jpy, product_data: { name: `Dialogos ${pack.name}` } } }],
      metadata: { billing_version: "3", user_id: req.user.id, package_id: pack.id },
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
    }, { idempotencyKey: `dialogos-v3-checkout-${req.user.id}-${req.body.requestId}` });
    res.json({ url: session.url });
  }));
  app.post("/me/sync-session", wrap(async (req, res) => {
    if (!stripe) throw error(503, "STRIPE_NOT_CONFIGURED");
    if (!/^cs_[a-zA-Z0-9_]{8,255}$/.test(req.body.sessionId || "")) throw error(400, "INVALID_SESSION");
    await fulfillSession(req.body.sessionId, req.user.id);
    res.json(publicUser(await getUser(req.user.id)));
  }));
  app.get("/subscription", wrap(async (req, res) => {
    const user = publicUser(req.user);
    res.json({ ...user, active: user.subscribed, legacy: true, newSubscriptionsAvailable: false, plan: user.subscription_plan, current_period_end: user.subscription_current_period_end, cancel_at_period_end: user.subscription_cancel_at_period_end });
  }));
  app.post("/stripe/portal", wrap(async (req, res) => {
    if (!stripe || !baseUrl) throw error(503, "STRIPE_NOT_CONFIGURED");
    const customer = await ownedCustomer(req.user);
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${baseUrl}/` });
    res.json({ url: portal.url });
  }));
  app.post("/stripe/cancel", wrap(async (req, res) => {
    if (!stripe || !req.user.subscription_id) throw error(404, "NO_SUBSCRIPTION");
    const customer = await ownedCustomer(req.user);
    const sub = await stripe.subscriptions.retrieve(req.user.subscription_id);
    if (sid(sub.customer) !== customer) throw error(403, "FORBIDDEN");
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    await updateSubscription(req.user, updated);
    res.json({ ok: true, message: "旧プランの自動更新を停止しました。購入済み灯火は引き続き使えます。" });
  }));
  for (const path of ["/me/restore-by-email", "/stripe/cancel-by-email", "/me/restore-subscription"]) {
    app.post(path, (_req, res) => res.status(410).json({ code: "OWNERSHIP_VERIFICATION_REQUIRED", message: "メールアドレスだけでの購入復元・解約は終了しました。購入時のアカウントでログインしてください。旧ゲスト購入の移行は本人確認を伴うサポートが必要です。" }));
  }

  async function cachedResponse(row, req, res) {
    if (row.status === "completed") { res.json({ ...row.response_body, user: publicUser(await getUser(req.user.id)) }); return; }
    const code = row.status === "unknown" ? "REQUEST_UNKNOWN" : row.status === "failed" ? "GENERATION_FAILED" : "REQUEST_PENDING";
    throw error(row.status === "failed" ? 502 : 409, code, row.status === "unknown" ? "前回の処理結果を確認中です。同じ送信の再確認は重複請求されません。" : row.status === "failed" ? "応答を保存できませんでした。灯火は消費していません。" : "前回の応答を処理中です。少し待ってから再確認してください。");
  }
  app.post("/chat", wrap(async (req, res) => {
    const chat = validateChat(req.body);
    const [existing] = await db.get("dialogos_requests", `id=eq.${q(chat.requestId)}&user_id=eq.${q(req.user.id)}&limit=1`);
    if (existing) {
      const oldSourceFingerprint = !chat.expectChargeSource && ["trial", "paid"].includes(existing.usage_source)
        ? createHash("sha256").update(JSON.stringify([chat.philosopherId, chat.message, chat.conversationId, existing.usage_source])).digest("hex") : null;
      if (existing.fingerprint !== chat.fingerprint && existing.fingerprint !== chat.legacyFingerprint && existing.fingerprint !== oldSourceFingerprint) throw error(409, "REQUEST_CONFLICT", "同じ送信識別子に別の内容が指定されています。");
      return cachedResponse(existing, req, res);
    }
    if (!chat.expectChargeSource) {
      throw error(400, "CHARGE_SOURCE_REQUIRED", "無料対話か購入済み灯火の利用かを画面で確認し、もう一度送信してください。");
    }
    const usesTrial = req.user.trial_eligible && Number(req.user.trial_remaining) - Number(req.user.trial_reserved || 0) > 0;
    if (chat.expectChargeSource !== (usesTrial ? "trial" : "paid")) throw error(409, "BALANCE_CHANGED", "体験回数または灯火の利用条件が変わりました。残り回数を確認し、もう一度送信してください。今回は消費していません。");
    if (usesTrial) {
      if (env.TRIAL_ENABLED !== "true" || !dailyLimit || !monthlyLimit || !trialDailyLimit || !trialMonthlyLimit) throw error(503, "TRIAL_NOT_READY", "無料体験はただいま準備中です。");
      await requireMigration();
    } else {
      if (Number(req.user.credits) - Number(req.user.reserved_credits || 0) < 1) throw error(402, "LOCKED", "サイト内で利用できる対話回数がありません。無料対話は全賢者合計1日3往復で、日本時間0時に更新されます。人格を無料で持ち帰り、ご自身のChatGPTで続きを楽しめます。");
      await requireBilling();
    }
    if (!env.OPENAI_API_KEY) throw error(503, "AI_NOT_CONFIGURED", "対話の公開準備中です。");
    const reservation = await db.rpc("dialogos_v5_reserve", {
      p_user_id: req.user.id, p_request_id: chat.requestId, p_fingerprint: chat.fingerprint,
      p_conversation_id: chat.conversationId, p_philosopher_id: chat.philosopherId, p_message: chat.message,
      p_reserve_micro: MAX_COST_MICRO, p_daily_limit_micro: dailyLimit, p_monthly_limit_micro: monthlyLimit,
      p_trial_enabled: env.TRIAL_ENABLED === "true",
      p_paid_enabled: Boolean(env.BILLING_ENABLED === "true" && stripe && env.STRIPE_WEBHOOK_SECRET && baseUrl && dailyLimit && monthlyLimit),
      p_trial_daily_limit_micro: trialDailyLimit, p_trial_monthly_limit_micro: trialMonthlyLimit,
      p_expected_source: chat.expectChargeSource,
    });
    if (!reservation.new_reservation) return cachedResponse(reservation, req, res);
    return runGeneration(req, res, chat, reservation);
  }));

  async function runGeneration(req, res, chat, reservation) {
    let generationStarted = false;
    let usage = null;
    let actual = null;
    let generationCompleted = false;
    try {
      const [conversation] = await db.get("conversations", `id=eq.${q(reservation.conversation_id)}&user_id=eq.${q(req.user.id)}&limit=1`);
      if (!conversation) throw error(404, "CONVERSATION_NOT_FOUND");
      const recent = (await db.get("messages", `conversation_id=eq.${q(conversation.id)}&order=id.desc&limit=12`)).reverse();
      let messages = recent;
      const buildBody = () => ({ model: MODEL, instructions: buildDialogueInstructions(chat.philosopherId),
        input: buildDialogueInput({ messages, state: conversation.dialogue_state || {}, message: chat.message }),
        reasoning: { effort: "low" }, text: { format: DIALOGUE_SCHEMA }, max_output_tokens: MAX_OUTPUT_TOKENS, store: false, service_tier: "default",
      });
      let body;
      let accepted = false;
      // Authoritative model token count, after reservation and before generation.
      // If history is too large, keep its newest complete pair on the second try.
      for (let attempt = 0; attempt < 2; attempt++) {
        body = buildBody();
        const count = await fetchImpl("https://api.openai.com/v1/responses/input_tokens", {
          method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: body.model, instructions: body.instructions, input: body.input, text: body.text, reasoning: body.reasoning }),
          signal: AbortSignal.timeout(15000),
        });
        if (!count.ok) throw error(503, "TOKEN_COUNT_UNAVAILABLE", "対話の長さを確認できません。灯火は消費していません。");
        const counted = await count.json();
        if (!Number.isSafeInteger(counted.input_tokens) || counted.input_tokens < 1) throw error(503, "TOKEN_COUNT_UNAVAILABLE");
        if (counted.input_tokens <= MAX_INPUT_TOKENS) { accepted = true; break; }
        messages = messages.slice(-2);
        if (messages[0]?.role !== "user") messages = [];
      }
      if (!accepted) throw error(400, "INPUT_LIMIT", "対話が長くなりました。新しい対話を始めてください。灯火は消費していません。");
      generationStarted = true;
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json", "X-Client-Request-Id": chat.requestId },
        body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        if ([400, 401, 403, 404, 422, 429].includes(response.status)) actual = 0;
        throw error(502, "GENERATION_FAILED", "応答を生成できませんでした。");
      }
      const data = await response.json();
      usage = data.usage;
      actual = costMicro(usage);
      const parsed = parseDialogueResponse(data);
      generationCompleted = true;
      const result = await db.rpc("dialogos_v3_finalize", {
        p_user_id: req.user.id, p_request_id: chat.requestId, p_reply: parsed.reply, p_state: parsed.state,
        p_usage: usage, p_actual_micro: actual, p_provider_id: data.id || null,
      });
      res.json({ ...result, user: publicUser(await getUser(req.user.id)) });
    } catch (err) {
      // A finalize transport failure may have committed. Fail RPC leaves a
      // completed row untouched; otherwise retain reservation for reconciliation.
      const settlement = generationCompleted ? null : !generationStarted ? 0 : actual;
      let settled;
      try { settled = await db.rpc("dialogos_v3_fail", { p_user_id: req.user.id, p_request_id: chat.requestId, p_actual_micro: settlement, p_usage: usage, p_code: err.code || "UPSTREAM_ERROR" }); }
      catch { /* Fail closed: the original reservation stays held in the DB. */ }
      if (settled?.status === "completed") return cachedResponse(settled, req, res);
      if (settled?.status === "failed" && settled.failure_code === "STALE_ESTIMATED_COST") return cachedResponse(settled, req, res);
      if (!settled || settlement == null) throw error(409, "REQUEST_UNKNOWN", "処理結果を確認中です。同じ送信の再確認は重複請求されません。");
      if (generationStarted) throw error(502, "GENERATION_FAILED", "応答を保存できませんでした。灯火は消費していません。もう一度問いかけてください。");
      if (!err.status) throw error(503, "TOKEN_COUNT_UNAVAILABLE", "対話の準備ができませんでした。灯火は消費していません。");
      throw err;
    }
  }
  app.use((_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "この機能は利用できません。" }));
  app.use((err, _req, res, _next) => {
    const status = err.type === "entity.too.large" ? 413 : err.status || 500;
    res.status(status).json({ code: err.code || "SERVER_ERROR", message: err.publicMessage || "処理を完了できませんでした。しばらく待ってから再確認してください。" });
  });
  return app;
}

function positiveUSD(value) {
  if (!/^\d+(\.\d{1,6})?$/.test(String(value))) return null;
  const micro = Math.round(Number(value) * 1000000);
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}
function validAppUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
