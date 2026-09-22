import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("Socrates trial lifetime accounting and nested budget invariants", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for (const file of ["schema.sql", "003_paid_v3.sql"]) await db.exec(await readFile(new URL(`../supabase/${file}`, import.meta.url), "utf8"));
  const legacyId = randomUUID();
  await db.query("insert into users(id,guest_id,auth_user_id,credits,free_count) values($1,'preserved',$2,50,99)", [legacyId, randomUUID()]);
  const migration = await readFile(new URL("../supabase/004_socrates_trial.sql", import.meta.url), "utf8");
  await db.exec(migration); await db.exec(migration);
  const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args)).rows[0].value;
  const user = async (id) => (await db.query("select * from users where id=$1", [id])).rows[0];
  let n = 0;
  const google = async (credits = 0, subject = (++n).toString(16).padStart(64, "0")) => {
    const created = await rpc("dialogos_v4_user", [randomUUID(), `test${n}@example.test`, null, subject]);
    if (credits) await db.query("update users set credits=$2 where id=$1", [created.id, credits]);
    return created;
  };
  const reserve = async (u, id = randomUUID(), philosopher = "socrates", trialDay = 500000, trialMonth = 5000000, totalDay = 3000000, totalMonth = 30000000, expected) => {
    const current = await user(u.id);
    const source = expected === undefined ? (philosopher === "socrates" && current.trial_eligible && current.trial_remaining - current.trial_reserved > 0 ? "trial" : "paid") : expected;
    return rpc("dialogos_v4_reserve", [u.id, id, "a".repeat(64), null, philosopher, "徳とは何か", 8550, totalDay, totalMonth, true, true, trialDay, trialMonth, source]);
  };
  const finish = (u, id) => rpc("dialogos_v3_finalize", [u.id, id, "徳の意味を一つ確かめよう。", { turn: 1 }, { input_tokens: 1000, output_tokens: 100 }, 1200, "resp_trial"]);
  const fail = (u, id, cost = 0) => rpc("dialogos_v3_fail", [u.id, id, cost, null, "TEST"]);
  const total = async table => (await db.query(`select coalesce(sum(spent_micro),0)::text as spent,coalesce(sum(reserved_micro),0)::text as reserved from ${table}`)).rows[0];

  await t.test("additive repeatable migration gives three independent trials without changing balances or legacy counts", async () => {
    const u = await user(legacyId);
    assert.equal(u.credits, 50); assert.equal(u.free_count, 99); assert.equal(u.trial_remaining, 3); assert.equal(u.trial_reserved, 0);
    assert.equal((await db.query("select count(*)::int n from dialogos_v3_schema where version in(3,4)")).rows[0].n, 2);
  });
  await t.test("only verified Google subject claims a lifetime grant; same provider cannot claim another account", async () => {
    const a = await google();
    const b = await rpc("dialogos_v4_user", [randomUUID(), a.email, null, a.trial_google_subject]);
    assert.equal(a.trial_eligible, true); assert.equal(b.trial_eligible, false);
    const nongoogle = await rpc("dialogos_v4_user", [randomUUID(), "not-google@example.test", null, null]);
    assert.equal(nongoogle.trial_eligible, false);
    await assert.rejects(reserve(nongoogle), /LOCKED/);
  });
  await t.test("three successful Socrates replies, concurrent reservation protection, no fourth and no other free sage", async () => {
    const u = await google();
    await assert.rejects(reserve(u, randomUUID(), "nietzsche"), /LOCKED/);
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const rows = await Promise.all([reserve(u, id), reserve(u, id)]);
      assert.equal(rows.filter(r => r.new_reservation).length, 1); assert.equal(rows[0].usage_source, "trial");
      await assert.rejects(reserve(u), /IN_FLIGHT/);
      await assert.rejects(db.query("update dialogos_requests set usage_source='paid' where id=$1", [id]), /IMMUTABLE_USAGE_SOURCE/);
      assert.equal((await finish(u, id)).usageSource, "trial");
      await finish(u, id);
      assert.equal((await user(u.id)).trial_remaining, 2 - i);
      assert.equal((await user(u.id)).credits, 0);
    }
    await assert.rejects(reserve(u), /LOCKED/);
    await db.query("update users set created_at=now()-interval '2 days' where id=$1", [u.id]);
    const again = await rpc("dialogos_v4_user", [u.auth_user_id, u.email, null, u.trial_google_subject]);
    assert.equal(again.trial_remaining, 0);
  });
  await t.test("paid account uses trial first only for Socrates and then resumes paid billing", async () => {
    const u = await google(10);
    const other = randomUUID(); assert.equal((await reserve(u, other, "nietzsche")).usage_source, "paid"); await finish(u, other);
    assert.equal((await user(u.id)).credits, 9); assert.equal((await user(u.id)).trial_remaining, 3);
    for (let i = 0; i < 3; i++) { const id = randomUUID(); await reserve(u, id); await finish(u, id); }
    assert.equal((await user(u.id)).credits, 9);
    const fourth = randomUUID(); assert.equal((await reserve(u, fourth)).usage_source, "paid"); await finish(u, fourth);
    assert.equal((await user(u.id)).credits, 8);
  });
  await t.test("known failure refunds trial bucket; unknown stale release expenses full cost in both pools", async () => {
    const u = await google(7); const failed = randomUUID(); await reserve(u, failed); await fail(u, failed, 200);
    assert.equal((await user(u.id)).trial_remaining, 3); assert.equal((await user(u.id)).trial_reserved, 0); assert.equal((await user(u.id)).credits, 7);
    const id = randomUUID(); await reserve(u, id); await fail(u, id, null);
    assert.equal((await user(u.id)).trial_reserved, 1); assert.equal((await user(u.id)).reserved_credits, 0);
    await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [id]);
    const beforeTrial = await total("dialogos_trial_budgets"), beforeTotal = await total("dialogos_budgets");
    assert.equal((await rpc("dialogos_v3_release_stale", [u.id])).released, 1);
    assert.equal(Number((await total("dialogos_trial_budgets")).spent) - Number(beforeTrial.spent), 17100);
    assert.equal(Number((await total("dialogos_budgets")).spent) - Number(beforeTotal.spent), 17100);
    assert.equal((await user(u.id)).trial_remaining, 3); assert.equal((await user(u.id)).trial_reserved, 0);
    assert.equal((await reserve(u, id)).status, "failed");
    await assert.rejects(finish(u, id), /REQUEST_CLOSED/);
  });
  await t.test("trial has nested daily and monthly caps, never falls back to paid when pool is full", async () => {
    const u = await google(50);
    await assert.rejects(reserve(u, randomUUID(), "socrates", 8550), /TRIAL_BUDGET_EXHAUSTED/);
    await assert.rejects(reserve(u, randomUUID(), "socrates", 500000, 8550), /TRIAL_BUDGET_EXHAUSTED/);
    await assert.rejects(reserve(u, randomUUID(), "socrates", 500000, 5000000, 8550), /BUDGET_EXHAUSTED/);
    assert.equal((await user(u.id)).credits, 50); assert.equal((await user(u.id)).trial_reserved, 0);
  });
  await t.test("trial disabled remains closed, paid RPCs and protected helper permissions retained", async () => {
    const u = await google();
    const args = [u.id, randomUUID(), "a".repeat(64), null, "socrates", "問い", 8550, 3000000, 30000000, false, true, 500000, 5000000, "trial"];
    await assert.rejects(rpc("dialogos_v4_reserve", args), /TRIAL_NOT_READY/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`); await assert.rejects(reserve(u), /permission denied/);
      await assert.rejects(db.query("select * from dialogos_trial_budgets"), /permission denied/); await db.exec("reset role");
    }
    const perms = await db.query("select has_function_privilege('service_role','dialogos_v4_settle_bucket(uuid,text,boolean)','EXECUTE') as allowed");
    assert.equal(perms.rows[0].allowed, false);
  });
  await t.test("under-lock charge intent rejects a stale last-trial tab and missing intent without consuming paid credit", async () => {
    const u = await google(20);
    await db.query("update users set trial_remaining=1 where id=$1", [u.id]);
    const a = randomUUID(); await reserve(u, a); await finish(u, a);
    await assert.rejects(reserve(u, randomUUID(), "socrates", 500000, 5000000, 3000000, 30000000, "trial"), /BALANCE_CHANGED/);
    await assert.rejects(reserve(u, randomUUID(), "socrates", 500000, 5000000, 3000000, 30000000, null), /CHARGE_SOURCE_REQUIRED/);
    assert.equal((await user(u.id)).credits, 20); assert.equal((await user(u.id)).reserved_credits, 0);
    const stillFree = await google(20);
    await assert.rejects(reserve(stillFree, randomUUID(), "socrates", 500000, 5000000, 3000000, 30000000, "paid"), /BALANCE_CHANGED/);
    assert.equal((await user(stillFree.id)).trial_reserved, 0);
  });
  await db.close();
});
