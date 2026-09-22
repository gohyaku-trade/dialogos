import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("atomic anonymous admission, daily allowance, network abuse gates and existing-account isolation", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for (const file of ["schema.sql", "003_paid_v3.sql", "004_socrates_trial.sql", "005_daily_trial.sql", "006_anonymous_trial.sql", "006_anonymous_trial.sql"]) await db.exec(await readFile(new URL(`../supabase/${file}`, import.meta.url), "utf8"));
  const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0].value;
  let nonce = 0;
  const proof = () => (++nonce).toString(16).padStart(64, "0");
  const network = () => (++nonce).toString(16).padStart(43, "A");
  const args = (id, overrides = {}) => {
    const values = { requestId: randomUUID(), network: network(), proof: proof(), sage: "socrates", daily: 3000000, monthly: 30000000, trialDaily: 500000, trialMonthly: 5000000, conversation: null, fingerprint: "a".repeat(64), ...overrides };
    return [id, values.requestId, values.fingerprint, values.conversation, values.sage, "人生の問い", 8550, values.daily, values.monthly, values.trialDaily, values.trialMonthly, values.network, values.proof];
  };
  const reserve = (id, overrides) => rpc("dialogos_v6_guest_reserve", args(id, overrides));
  const finish = (id, requestId) => rpc("dialogos_v3_finalize", [id, requestId, "問いの前提を確かめよう。", { turn: 1 }, {}, 100, "resp_guest"]);
  const fail = (id, requestId, amount = 0) => rpc("dialogos_v3_fail", [id, requestId, amount, {}, "TEST"]);
  const state = id => rpc("dialogos_v5_user_state", [id]);
  const count = async table => Number((await db.query(`select count(*) n from ${table}`)).rows[0].n);

  await t.test("new guest + network + proof + quota + budget is one transaction; denied budget creates nothing", async () => {
    const before = await Promise.all(["users", "conversations", "dialogos_requests", "dialogos_guest_attempts"].map(count));
    for (const override of [{ daily: 1 }, { monthly: 1 }, { trialDaily: 1 }, { trialMonthly: 1 }]) {
      const id = randomUUID();
      await assert.rejects(reserve(id, override), /BUDGET_EXHAUSTED/);
      assert.equal((await db.query("select id from users where id=$1", [id])).rows.length, 0);
    }
    assert.deepEqual(await Promise.all(["users", "conversations", "dialogos_requests", "dialogos_guest_attempts"].map(count)), before);
  });
  await t.test("three successful replies across sages, no paid fallback; replay never adds a fourth", async () => {
    const id = randomUUID(); let last;
    for (const sage of ["socrates", "buddha", "nietzsche"]) {
      last = args(id, { sage }); const r = await rpc("dialogos_v6_guest_reserve", last);
      assert.equal(r.usage_source, "trial"); assert.equal(r.new_reservation, true);
      const result = await finish(id, r.id); assert.equal(result.usageSource, "trial");
    }
    const u = await state(id); assert.equal(u.trial_remaining, 0); assert.equal(u.credits, 0);
    assert.equal(u.is_guest, true); assert.equal(u.auth_user_id, `guest:v6:${id}`); assert.equal(u.trial_google_subject, null);
    await assert.rejects(reserve(id), /LOCKED/);
    last[11] = null; last[12] = null;
    const replay = await rpc("dialogos_v6_guest_reserve", last); assert.equal(replay.status, "completed");
    assert.equal((await finish(id, replay.id)).reply, replay.response_body.reply);
    assert.equal((await state(id)).trial_remaining, 0);
  });
  await t.test("simultaneous submissions and unknown outcomes keep one guest in-flight", async () => {
    const id = randomUUID(); const outcomes = await Promise.allSettled([reserve(id), reserve(id)]);
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.match(outcomes.find(value => value.status === "rejected").reason.message, /IN_FLIGHT/);
    const row = outcomes.find(value => value.status === "fulfilled").value;
    await fail(id, row.id, null); await assert.rejects(reserve(id), /IN_FLIGHT/);
    assert.equal((await state(id)).trial_reserved, 1);
    await fail(id, row.id, 0); assert.equal((await state(id)).trial_remaining, 3);
  });
  await t.test("known failure refunds daily quota, but retains network attempt and unique proof", async () => {
    const id = randomUUID(), hash = proof(), net = network();
    const row = await reserve(id, { proof: hash, network: net }); await fail(id, row.id);
    assert.equal((await state(id)).trial_reserved, 0); assert.equal((await state(id)).trial_remaining, 3);
    const attempts = (await db.query("select * from dialogos_guest_attempts where request_id=$1", [row.id])).rows;
    assert.equal(attempts.length, 1);
    const other = randomUUID(); await assert.rejects(reserve(other, { proof: hash }), /TURNSTILE_FAILED/);
    assert.equal((await db.query("select id from users where id=$1", [other])).rows.length, 0);
    const bad = args(id, { requestId: row.id, fingerprint: "b".repeat(64) });
    await assert.rejects(rpc("dialogos_v6_guest_reserve", bad), /REQUEST_CONFLICT/);
  });
  await t.test("cross-network proof races and invalid conversation roll back every losing admission", async () => {
    const before = await count("users"), hash = proof();
    const outcomes = await Promise.allSettled([randomUUID(), randomUUID()].map(id => reserve(id, { proof: hash }).then(row => ({ id, row }))));
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(await count("users"), before + 1);
    const winner = outcomes.find(value => value.status === "fulfilled").value; await fail(winner.id, winner.row.id);
    const counts = await Promise.all(["users", "conversations", "dialogos_requests", "dialogos_guest_attempts"].map(count));
    await assert.rejects(reserve(randomUUID(), { conversation: randomUUID() }), /CONVERSATION_NOT_FOUND/);
    assert.deepEqual(await Promise.all(["users", "conversations", "dialogos_requests", "dialogos_guest_attempts"].map(count)), counts);
  });
  await t.test("cookie rotation cannot exceed six network admissions per minute; replay remains allowed", async () => {
    const net = network(); const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => {
      const id = randomUUID(); return reserve(id, { network: net }).then(row => ({ id, row }));
    }));
    const successes = outcomes.filter(value => value.status === "fulfilled").map(value => value.value);
    assert.equal(successes.length, 6);
    for (const rejected of outcomes.filter(value => value.status === "rejected")) assert.match(rejected.reason.message, /NETWORK_RATE_LIMITED/);
    for (const { id, row } of successes) await fail(id, row.id);
    const { id, row } = successes[0];
    assert.equal((await rpc("dialogos_v6_guest_reserve", args(id, { requestId: row.id, network: null, proof: null }))).status, "failed");
    await assert.rejects(reserve(randomUUID(), { network: net }), /NETWORK_RATE_LIMITED/);
  });
  await t.test("network permits shared-IP users beyond three but stops the 31st daily admission", async () => {
    const net = network();
    for (let i = 0; i < 30; i++) {
      await db.query("update dialogos_guest_attempts set admitted_at=clock_timestamp()-interval '2 minutes' where network_hash=$1", [net]);
      const id = randomUUID(), row = await reserve(id, { network: net }); await fail(id, row.id);
    }
    await db.query("update dialogos_guest_attempts set admitted_at=clock_timestamp()-interval '2 minutes' where network_hash=$1", [net]);
    const deniedId = randomUUID(); await assert.rejects(reserve(deniedId, { network: net }), /NETWORK_RATE_LIMITED/);
    assert.equal((await db.query("select id from users where id=$1", [deniedId])).rows.length, 0);
    await db.query("update dialogos_guest_attempts set quota_day=quota_day-1 where network_hash=$1", [net]);
    const next = await reserve(deniedId, { network: net }); await fail(deniedId, next.id);
  });
  await t.test("unknown across Japan midnight expenses full reserve, refunds only old day, and cannot complete later", async () => {
    const id = randomUUID(), row = await reserve(id);
    await fail(id, row.id, null);
    await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [row.id]);
    const totals = async () => (await db.query("select (select sum(spent_micro) from dialogos_budgets)::text total,(select sum(spent_micro) from dialogos_trial_budgets)::text trial")).rows[0];
    const before = await totals();
    // Move only the quota clock in this isolated DB; the request's admission day stays fixed.
    await db.exec("create or replace function public.dialogos_jst_day(p_at timestamptz) returns date language sql immutable strict set search_path=public,pg_temp as $$select (p_at at time zone 'Asia/Tokyo')::date+1$$;");
    assert.equal((await state(id)).trial_remaining, 3);
    assert.equal((await rpc("dialogos_v3_release_stale", [id])).released, 1);
    const after = await totals(); assert.equal(Number(after.total) - Number(before.total), 17100); assert.equal(Number(after.trial) - Number(before.trial), 17100);
    assert.equal((await state(id)).trial_remaining, 3); assert.equal((await state(id)).trial_reserved, 0);
    const old = (await db.query("select used,reserved from dialogos_daily_trials where user_id=$1 and trial_day=$2", [id, row.trial_day])).rows[0];
    assert.deepEqual(old, { used: 0, reserved: 0 });
    await assert.rejects(finish(id, row.id), /REQUEST_CLOSED/);
    assert.equal((await rpc("dialogos_v6_guest_reserve", args(id, { requestId: row.id, network: null, proof: null }))).status, "failed");
    await db.exec("create or replace function public.dialogos_jst_day(p_at timestamptz) returns date language sql immutable strict set search_path=public,pg_temp as $$select (p_at at time zone 'Asia/Tokyo')::date$$;");
  });
  await t.test("existing Google paid/trial accounts are retained and guest cannot use account RPC admission", async () => {
    const account = await rpc("dialogos_v5_user", [randomUUID(), "kept@example.test", null, "f".repeat(64)]);
    await db.query("update users set credits=40 where id=$1", [account.id]);
    await assert.rejects(reserve(account.id), /AUTH_REQUIRED/);
    const accountArgs = [account.id, randomUUID(), "a".repeat(64), null, "socrates", "以前の対話", 8550, 3000000, 30000000, true, true, 500000, 5000000, "trial"];
    const row = await rpc("dialogos_v5_reserve", accountArgs); await finish(account.id, row.id);
    assert.equal((await state(account.id)).credits, 40); assert.equal((await state(account.id)).email, "kept@example.test");
    const id = randomUUID(), guestRow = await reserve(id); await fail(id, guestRow.id);
    accountArgs[0] = id; accountArgs[1] = randomUUID();
    await assert.rejects(rpc("dialogos_v5_reserve", accountArgs), /AUTH_REQUIRED/);
    await assert.rejects(db.query("update users set credits=1 where id=$1", [id]), /dialogos_guest_identity/);
  });
  await t.test("only service role can enter guest RPC; internal bypass and public table privileges are closed", async () => {
    const rows = (await db.query("select proname,has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname in ('dialogos_v6_guest_reserve','dialogos_v5_reserve_core')")).rows;
    for (const row of rows) { assert.equal(row.a, false); assert.equal(row.u, false); assert.equal(row.s, row.proname === "dialogos_v6_guest_reserve"); }
    assert.equal(rows.length, 2);
    const table = (await db.query("select relrowsecurity r,has_table_privilege('anon',oid,'select') a,has_table_privilege('authenticated',oid,'select') u from pg_class where relname='dialogos_guest_attempts'")).rows[0];
    assert.deepEqual(table, { r: true, a: false, u: false });
  });
});
