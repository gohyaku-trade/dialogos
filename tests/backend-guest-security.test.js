import test from "node:test";
import assert from "node:assert/strict";
import { guestSecurity, networkPrefix, virtualGuest, GUEST_SESSION_SECONDS } from "../lib/guest-security.js";

const env = { APP_URL: "https://dialogos.example", GUEST_SESSION_SECRET: "test-only-secret-32-bytes-123456789", TURNSTILE_SITE_KEY: "public_test", TURNSTILE_SECRET_KEY: "secret_test" };
const req = (headers = {}) => ({ headers: { host: "dialogos.example", origin: "https://dialogos.example", ...headers }, socket: { remoteAddress: "::ffff:192.0.2.1" } });

test("guest signature is scoped, expiring, HttpOnly, Secure, strict, duplicate/tampered cookies rejected", () => {
  const security = guestSecurity(env); const now = Date.now();
  const issued = security.issueCookie(undefined, now);
  assert.match(issued.header, /^__Host-dialogos_guest=/);
  for (const value of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${GUEST_SESSION_SECONDS}`]) assert.ok(issued.header.includes(value));
  const cookie = issued.header.split(";")[0];
  assert.equal(security.readCookie(req({ cookie }), now).id, issued.id);
  assert.equal(security.readCookie(req({ cookie }), now + GUEST_SESSION_SECONDS * 1000), null);
  assert.equal(security.readCookie(req({ cookie: cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A") })), null);
  assert.equal(security.readCookie(req({ cookie: `${cookie}; ${cookie}` })), null);
  assert.equal(guestSecurity({ ...env, APP_URL: "https://other.example" }).readCookie(req({ cookie })), null);
  assert.equal(guestSecurity({ ...env, GUEST_SESSION_SECRET: "short" }).ready, false);
  assert.throws(() => guestSecurity({ ...env, GUEST_SESSION_SECRET: "short" }).issueCookie(), { code: "GUEST_NOT_READY" });
  const local = guestSecurity({ ...env, APP_URL: "http://localhost:3000" }).issueCookie().header;
  assert.match(local, /^dialogos_guest_dev=/); assert.doesNotMatch(local, /; Secure/);
  assert.equal(guestSecurity({ ...env, APP_URL: "http://public.example" }).ready, false);
});

test("same-origin enforcement does not trust forwarded host or arbitrary proxy IP headers", () => {
  const security = guestSecurity(env);
  const trusted = security.checkRequest(req(), true);
  assert.deepEqual(security.checkRequest(req({ "x-forwarded-for": "203.0.113.2", "x-vercel-forwarded-for": "203.0.113.9" }), true), trusted);
  for (const headers of [{ origin: undefined }, { origin: "null" }, { origin: "https://evil.example" }, { host: "evil.example", "x-forwarded-host": "dialogos.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.throws(() => security.checkRequest(req(headers), true), { code: "GUEST_ORIGIN_REJECTED" });
  }
  const vercel = guestSecurity({ ...env, VERCEL: "1" });
  assert.equal(vercel.checkRequest(req({ "x-vercel-forwarded-for": "192.0.2.1" }), true).networkHash, trusted.networkHash);
  for (const address of [undefined, "192.0.2.1, 203.0.113.1", " 192.0.2.1", "192.0.2.1:8000", "::1%lo"]) {
    assert.throws(() => vercel.checkRequest(req({ "x-vercel-forwarded-for": address }), true), { code: "GUEST_NETWORK_UNAVAILABLE" });
  }
});

test("network identity normalizes IPv6 representations, groups /64 and distinguishes IPv4", () => {
  assert.equal(networkPrefix("2001:db8:1:2::99"), networkPrefix("2001:0db8:0001:0002:ffff:0:ab:cd"));
  assert.notEqual(networkPrefix("2001:db8:1:2::1"), networkPrefix("2001:db8:1:3::1"));
  assert.equal(networkPrefix("::ffff:192.0.2.1"), networkPrefix("192.0.2.1"));
  assert.equal(networkPrefix("::ffff:c000:201"), networkPrefix("192.0.2.1"));
  assert.notEqual(networkPrefix("192.0.2.1"), networkPrefix("192.0.2.2"));
  assert.throws(() => networkPrefix("not_an_ip"));
});

test("Turnstile verifies server-side single-use endpoint plus age, hostname, action and request binding", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const good = { success: true, hostname: "dialogos.example", action: "guest_chat", cdata: id, challenge_ts: new Date().toISOString() };
  let body = good, calls = [];
  const security = guestSecurity(env, async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return new Response(JSON.stringify(body));
  });
  const network = security.checkRequest(req(), true);
  assert.match(await security.verify("valid-token", network, "guest_chat", id), /^[a-f0-9]{64}$/);
  assert.equal(calls[0][0], "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(calls[0][1].secret, env.TURNSTILE_SECRET_KEY);
  assert.equal(calls[0][1].remoteip, "::ffff:192.0.2.1");
  for (const invalid of [null, 12, {}, "", "x".repeat(2049)]) await assert.rejects(security.verify(invalid, network, "guest_chat", id), { code: "TURNSTILE_REQUIRED" });
  assert.equal(calls.length, 1);
  for (const patch of [{ success: false, "error-codes": ["timeout-or-duplicate"] }, { hostname: "evil.example" }, { action: "guest_session" }, { cdata: "another-request" }, { challenge_ts: "bad" }, { challenge_ts: new Date(Date.now() - 301000).toISOString() }, { challenge_ts: new Date(Date.now() + 61000).toISOString() }]) {
    body = { ...good, ...patch };
    await assert.rejects(security.verify("token", network, "guest_chat", id), { code: "TURNSTILE_FAILED" });
  }
  await assert.rejects(guestSecurity(env, async () => { throw new Error("private network detail"); }).verify("token", network, "guest_chat", id), { code: "TURNSTILE_UNAVAILABLE" });
  await assert.rejects(guestSecurity(env, async () => new Response("{}", { status: 500 })).verify("token", network, "guest_chat", id), { code: "TURNSTILE_UNAVAILABLE" });
});

test("virtual guest day and reset are Japan time, contain no Google or paid identity", () => {
  const before = virtualGuest("id", new Date("2026-09-21T14:59:59Z"));
  const after = virtualGuest("id", new Date("2026-09-21T15:00:00Z"));
  assert.equal(before.trial_day, "2026-09-21"); assert.equal(after.trial_day, "2026-09-22");
  assert.equal(before.trial_resets_at, "2026-09-21T15:00:00.000Z"); assert.equal(after.trial_remaining, 3);
  assert.equal(after.auth_user_id, "guest:v6:id"); assert.equal(after.credits, 0); assert.equal(after.is_guest, true);
});
