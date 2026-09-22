import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createApi, createStore } from "../lib/api-v3.js";
import { normalizeDialogueState } from "../shared/dialogue.js";

test("anonymous API → actual SQL → mocked provider keeps all safety boundaries", async t => {
  const db = new PGlite({ extensions: { pgcrypto } }); t.after(() => db.close());
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for (const file of ["schema.sql", "003_paid_v3.sql", "004_socrates_trial.sql", "005_daily_trial.sql", "006_anonymous_trial.sql"]) await db.exec(await readFile(new URL(`../supabase/${file}`, import.meta.url), "utf8"));
  const env = { APP_URL: "https://dialogos.example", VERCEL: "1", ANONYMOUS_TRIAL_ENABLED: "true", TRIAL_ENABLED: "true",
    GUEST_SESSION_SECRET: "test-only-long-secret-32bytes-123456789", TURNSTILE_SITE_KEY: "public-test-key", TURNSTILE_SECRET_KEY: "private-test-key",
    SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "test-role", OPENAI_API_KEY: "test-no-network" };
  const calls = { db: [], proof: [], count: 0, generation: 0 }; const tokens = new Map(); let mode = "success", address = 10;
  const proof = (action, id, patch = {}) => {
    const token = randomUUID(); tokens.set(token, { success: true, challenge_ts: new Date().toISOString(), hostname: "dialogos.example", action, cdata: id, ...patch }); return token;
  };
  const store = createStore(env, async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname.replace("/rest/v1/", ""); calls.db.push(path);
    try {
      let result;
      if (path.startsWith("rpc/")) {
        const name = path.slice(4), values = JSON.parse(init.body);
        assert.match(name, /^dialogos_[a-z0-9_]+$/);
        result = (await db.query(`select public.${name}(${Object.keys(values).map((key, i) => `${key}=>$${i + 1}`).join(",")}) value`, Object.values(values))).rows[0].value;
      } else {
        assert.ok(["users", "dialogos_v3_schema", "dialogos_requests", "conversations", "messages"].includes(path));
        const clauses = [], values = [];
        for (const [key, value] of parsed.searchParams) {
          if (["select", "order", "limit"].includes(key)) continue;
          assert.match(key, /^[a-z_]+$/); assert.ok(value.startsWith("eq."));
          values.push(value.slice(3)); clauses.push(`${key}=$${values.length}`);
        }
        const order = parsed.searchParams.get("order");
        if (order) assert.match(order, /^(id|updated_at)\.(asc|desc)$/);
        const limit = Number(parsed.searchParams.get("limit") || 1000); assert.ok(Number.isInteger(limit));
        result = (await db.query(`select * from public.${path}${clauses.length ? ` where ${clauses.join(" and ")}` : ""}${order ? ` order by ${order.replace(".", " ")}` : ""} limit ${limit}`, values)).rows;
      }
      return new Response(JSON.stringify(result));
    } catch (err) { return new Response(JSON.stringify({ message: err.message }), { status: 400 }); }
  });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      calls.proof.push(body); const value = tokens.get(body.response); tokens.delete(body.response);
      return new Response(JSON.stringify(value || { success: false, "error-codes": ["timeout-or-duplicate"] }));
    }
    if (url === "https://api.openai.com/v1/responses/input_tokens") {
      calls.count++; return new Response(JSON.stringify({ input_tokens: mode === "tooLong" ? 9000 : 2000 }));
    }
    assert.equal(url, "https://api.openai.com/v1/responses"); calls.generation++;
    if (mode === "unknown") throw new TypeError("simulated network loss");
    if (mode === "reject") return new Response("{}", { status: 429 });
    return new Response(JSON.stringify({ id: "resp_fake", status: "completed", output_text: JSON.stringify({ reply: "その問いの前提を確かめよう。", state: normalizeDialogueState({ turn: 1 }) }), usage: { input_tokens: 2000, output_tokens: 300 } }));
  };
  async function client(overrides = {}) {
    const app = createApi({ env: { ...env, ...overrides }, store, fetchImpl, stripeClient: null, authenticate: async () => null });
    const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const ip = `192.0.2.${address++}`; let cookie = "";
    const request = async (path, body, headers = {}) => {
      const response = await new Promise((resolve, reject) => {
        const pending = httpRequest(`http://127.0.0.1:${server.address().port}${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { Host: "dialogos.example", Origin: env.APP_URL,
          "Content-Type": "application/json", "x-vercel-forwarded-for": ip, Cookie: cookie, ...headers },
        }, response => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString()) })); });
        pending.on("error", reject);
        pending.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
      });
      if (response.headers["set-cookie"]) cookie = response.headers["set-cookie"][0].split(";")[0];
      return { status: response.status, data: response.data, cookie };
    };
    return { request, session: () => request("/guest/session", { turnstileToken: proof("guest_session") }), get cookie() { return cookie; } };
  }
  const body = (sage = "socrates") => ({ requestId: randomUUID(), philosopherId: sage, message: "正義とは何か", conversationId: null, expectChargeSource: "trial" });
  const send = (c, b) => c.request("/guest/chat", { ...b, turnstileToken: proof("guest_chat", b.requestId) });

  await t.test("missing setup is closed; config leaks only public sitekey and missing cookie never creates a guest", async () => {
    for (const override of [{ GUEST_SESSION_SECRET: "short" }, { TURNSTILE_SECRET_KEY: "" }, { TURNSTILE_SITE_KEY: "" }, { SUPABASE_SERVICE_ROLE_KEY: "" }, { ANONYMOUS_TRIAL_ENABLED: "false" }, { OPENAI_API_KEY: "" }]) {
      const c = await client(override); const config = await c.request("/config");
      assert.equal(config.data.anonymousEnabled, false); assert.equal(config.data.turnstileSiteKey, "");
      assert.equal((await c.session()).status, 503);
    }
    const c = await client(); const before = calls.db.length;
    assert.equal((await c.request("/guest/me")).data.code, "GUEST_SESSION_REQUIRED");
    assert.equal(calls.db.length, before);
    const config = (await c.request("/config")).data;
    assert.equal(config.trial.requiresGoogle, false); assert.equal(config.anonymousEnabled, true); assert.equal(config.turnstileSiteKey, env.TURNSTILE_SITE_KEY);
    assert.doesNotMatch(JSON.stringify(config), /private-test-key|test-role|test-only-long-secret/);
  });
  await t.test("explicit session issuance is stateless; me reads virtual quota, and cookie has no account permissions", async () => {
    const c = await client(); const before = calls.db.length; const issued = await c.session();
    assert.equal(issued.status, 200); assert.equal(calls.db.length, before);
    assert.equal(issued.data.is_guest, true); assert.equal(issued.data.logged_in, false); assert.equal(issued.data.trial_remaining, 3);
    const me = await c.request("/guest/me"); assert.equal(me.data.id, issued.data.id); assert.equal(me.data.trial_remaining, 3);
    assert.equal((await db.query("select id from users where id=$1", [issued.data.id])).rows.length, 0);
    for (const path of ["/me", "/history", "/memories", "/subscription"]) assert.equal((await c.request(path)).status, 401);
    assert.equal((await c.request("/chat", body())).status, 401);
    assert.equal((await c.request("/stripe/checkout", { packageId: "v3_40", requestId: randomUUID() })).status, 401);
    const bad = await c.request("/guest/chat", body(), { Origin: "https://evil.example" }); assert.equal(bad.data.code, "GUEST_ORIGIN_REJECTED");
    const noOrigin = await c.request("/guest/session", { turnstileToken: proof("guest_session") }, { Origin: "" }); assert.equal(noOrigin.status, 403);
  });
  await t.test("new generation requires bound proof; token replay, paid intent and malformed requests cannot reach AI", async () => {
    const c = await client(); const session = await c.session(); const before = calls.generation; const b = body();
    assert.equal((await c.request("/guest/chat", b)).data.code, "TURNSTILE_REQUIRED");
    for (const patch of [{ action: "guest_session" }, { hostname: "evil.example" }, { cdata: randomUUID() }, { success: false }]) {
      const result = await c.request("/guest/chat", { ...b, turnstileToken: proof("guest_chat", b.requestId, patch) }); assert.equal(result.data.code, "TURNSTILE_FAILED");
    }
    assert.equal((await c.request("/guest/chat", { ...b, expectChargeSource: "paid" })).status, 400);
    for (const invalid of [{ ...b, message: {} }, { ...b, message: "a".repeat(1001) }, { ...b, requestId: "bad?request" }, { ...b, philosopherId: "not-real" }]) assert.equal((await c.request("/guest/chat", invalid)).status, 400);
    assert.equal((await c.request("/guest/chat", "{bad-json")).status, 400);
    assert.equal((await c.request("/guest/chat", { ...b, message: "a".repeat(40000) })).status, 413);
    assert.equal(calls.generation, before); assert.equal((await db.query("select id from users where id=$1", [session.data.id])).rows.length, 0);
  });
  await t.test("three saved all-sage replies only; idempotent retry uses no fresh proof or extra generation", async () => {
    const c = await client(); const session = await c.session(); let last;
    for (const [index, sage] of ["socrates", "buddha", "nietzsche"].entries()) {
      const b = body(sage); const result = await send(c, b);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.user.id, session.data.id);
      assert.equal(result.data.user.logged_in, false); assert.equal(result.data.user.trial_remaining, 2 - index); assert.equal(result.data.user.credits, 0);
      assert.equal(result.data.usageSource, "trial");
      const generated = calls.generation, verified = calls.proof.length;
      const replay = await c.request("/guest/chat", b); assert.equal(replay.data.reply, result.data.reply);
      assert.equal(calls.generation, generated); assert.equal(calls.proof.length, verified); last = b;
    }
    assert.equal((await send(c, body())).status, 402);
    assert.equal((await c.request("/guest/chat", { ...last, message: "changed" })).status, 409);
    const renewed = await c.session(); assert.equal(renewed.data.id, session.data.id); assert.equal(renewed.data.trial_remaining, 0);
  });
  await t.test("budget denial rolls back guest identity and produces no provider call", async () => {
    const c = await client({ API_TRIAL_DAILY_BUDGET_USD: "0.000001" }); const session = await c.session();
    const generated = calls.generation, counted = calls.count;
    const result = await send(c, body()); assert.equal(result.data.code, "TRIAL_BUDGET_EXHAUSTED");
    assert.equal(calls.generation, generated); assert.equal(calls.count, counted);
    assert.equal((await db.query("select id from users where id=$1", [session.data.id])).rows.length, 0);
  });
  await t.test("consumed proof cannot start a second request; completed proof-less replay survives disabled trial", async () => {
    const c = await client(); await c.session(); const b = body(); const token = proof("guest_chat", b.requestId);
    assert.equal((await c.request("/guest/chat", { ...b, turnstileToken: token })).status, 200);
    const generated = calls.generation;
    assert.equal((await c.request("/guest/chat", { ...body(), turnstileToken: token })).data.code, "TURNSTILE_FAILED");
    assert.equal(calls.generation, generated);
    const paused = await client({ ANONYMOUS_TRIAL_ENABLED: "false", TRIAL_ENABLED: "false", TURNSTILE_SECRET_KEY: "" });
    const verified = calls.proof.length;
    assert.equal((await paused.request("/guest/chat", b, { Cookie: c.cookie })).status, 200);
    assert.equal((await paused.request("/guest/chat", body(), { Cookie: c.cookie })).data.code, "GUEST_NOT_READY");
    assert.equal(calls.generation, generated); assert.equal(calls.proof.length, verified);
  });
  await t.test("known rejection releases free reservation; unknown preserves it, stale replay expenses maximum without regeneration", async () => {
    const c = await client(); const session = await c.session(); const rejected = body();
    mode = "reject"; assert.equal((await send(c, rejected)).data.code, "GENERATION_FAILED");
    assert.equal((await c.request("/guest/me")).data.trial_remaining, 3);
    mode = "unknown"; const b = body(); assert.equal((await send(c, b)).data.code, "REQUEST_UNKNOWN");
    assert.equal((await c.request("/guest/me")).data.trial_reserved, 1);
    const generated = calls.generation, verified = calls.proof.length;
    assert.equal((await c.request("/guest/chat", b)).data.code, "REQUEST_UNKNOWN");
    assert.equal(calls.generation, generated); assert.equal(calls.proof.length, verified);
    await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [b.requestId]);
    assert.equal((await c.request("/guest/chat", b)).data.code, "GENERATION_FAILED");
    assert.equal(calls.generation, generated); assert.equal((await c.request("/guest/me")).data.trial_remaining, 3);
    const row = (await db.query("select * from dialogos_requests where id=$1", [b.requestId])).rows[0];
    assert.equal(Number(row.estimated_micro), 8550); assert.equal(row.actual_micro, null); assert.equal(row.status, "failed");
    assert.equal((await db.query("select count(*) n from dialogos_guest_attempts where request_id in ($1,$2)", [b.requestId, rejected.requestId])).rows[0].n, 2);
    assert.equal(row.user_id, session.data.id); mode = "success";
  });
  await t.test("missing schema version refuses anonymous generation before proof or AI", async () => {
    const c = await client(); await c.session(); await db.exec("delete from dialogos_v3_schema where version=6");
    const generated = calls.generation, verified = calls.proof.length;
    assert.equal((await send(c, body())).data.code, "MIGRATION_REQUIRED");
    assert.equal(calls.generation, generated); assert.equal(calls.proof.length, verified);
    await db.exec("insert into dialogos_v3_schema(version) values(6)");
  });
});
