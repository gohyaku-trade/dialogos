import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("daily shared trial, Japan midnight and legacy in-flight settlement", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create role anon;create role authenticated;create role service_role;");
  for (const file of ["schema.sql", "003_paid_v3.sql", "004_socrates_trial.sql"]) await db.exec(await readFile(new URL(`../supabase/${file}`, import.meta.url), "utf8"));
  const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0].value;
  let identity = 100;
  const google = async (paid = 0) => {
    const u = await rpc("dialogos_v4_user", [randomUUID(), "owner@example.test", null, (++identity).toString(16).padStart(64, "0")]);
    if (paid) await db.query("update users set credits=$2 where id=$1", [u.id, paid]);
    return u;
  };
  const state = u => rpc("dialogos_v5_user_state", [u.id]);
  const reserveArgs = (u, id, sage, expected = "trial") => [u.id, id, "a".repeat(64), null, sage, "人生の問い", 8550, 3000000, 30000000, true, true, 500000, 5000000, expected];
  const oldUser = await google(20), oldId = randomUUID();
  await rpc("dialogos_v4_reserve", reserveArgs(oldUser, oldId, "socrates"));
  const oldUnknown = await google(), oldUnknownId = randomUUID();
  await rpc("dialogos_v4_reserve", reserveArgs(oldUnknown, oldUnknownId, "socrates"));
  await rpc("dialogos_v3_fail", [oldUnknown.id, oldUnknownId, null, null, "UNKNOWN"]);
  await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [oldUnknownId]);
  const migration = await readFile(new URL("../supabase/005_daily_trial.sql", import.meta.url), "utf8");
  await db.exec(migration); await db.exec(migration);
  const reserve = (u, id = randomUUID(), sage = "socrates", expected = "trial") => rpc("dialogos_v5_reserve", reserveArgs(u, id, sage, expected));
  const finish = (u, id) => rpc("dialogos_v3_finalize", [u.id, id, "問いの前提を一つ確かめよう。", { turn: 1 }, {}, 1200, "resp_daily"]);
  const fail = (u, id, amount = 0) => rpc("dialogos_v3_fail", [u.id, id, amount, {}, "TEST"]);
  const day = (await db.query("select dialogos_jst_day(now())::text today, (dialogos_jst_day(now())-1)::text yesterday")).rows[0];

  await t.test("Japan boundary is 15:00 UTC regardless of session timezone", async () => {
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      await db.query("select set_config('TimeZone',$1,false)", [zone]);
      const rows = await db.query("select dialogos_jst_day('2026-09-21 14:59:59+00')::text before_midnight,dialogos_jst_day('2026-09-21 15:00:00+00')::text after_midnight");
      assert.deepEqual(rows.rows[0], { before_midnight: "2026-09-21", after_midnight: "2026-09-22" });
    }
    await db.exec("set timezone='UTC'");
    const u = await google(); const s = await state(u);
    assert.equal(new Date(s.trial_resets_at).getUTCHours(), 15); assert.equal(s.trial_remaining, 3);
  });
  await t.test("three completed replies are shared across philosophers and replay never double-consumes", async () => {
    const u = await google();
    for (const sage of ["socrates", "nietzsche", "buddha"]) {
      const id = randomUUID(); const rows = await Promise.all([reserve(u, id, sage), reserve(u, id, sage)]);
      assert.equal(rows.filter(row => row.new_reservation).length, 1); assert.equal(rows[0].trial_day, day.today);
      await assert.rejects(reserve(u), /IN_FLIGHT/);
      await assert.rejects(db.query("update dialogos_requests set trial_day=trial_day-1 where id=$1", [id]), /IMMUTABLE_TRIAL_DAY/);
      await finish(u, id); await finish(u, id);
    }
    const s = await state(u); assert.equal(s.trial_remaining, 0); assert.equal(s.trial_used_today, 3); assert.equal(s.credits, 0);
    await assert.rejects(reserve(u), /BALANCE_CHANGED/);
    await assert.rejects(reserve(u, randomUUID(), "nietzsche", "paid"), /LOCKED/);
  });
  await t.test("yesterday's completed quota cannot suppress today's three replies", async () => {
    const u = await google();
    await db.query("insert into dialogos_daily_trials(user_id,trial_day,used) values($1,$2,3)", [u.id, day.yesterday]);
    assert.equal((await state(u)).trial_remaining, 3);
    const id = randomUUID(); await reserve(u, id, "nietzsche"); await finish(u, id);
    assert.equal((await state(u)).trial_remaining, 2);
    assert.equal((await db.query("select used from dialogos_daily_trials where user_id=$1 and trial_day=$2", [u.id, day.yesterday])).rows[0].used, 3);
  });
  // Seed the exact state of a previous-day admission without adding a client-
  // controllable clock to production RPCs. Budget period keys remain admission-fixed.
  async function previousDayPending(u) {
    const current = await reserve(u);
    await fail(u, current.id);
    const id = randomUUID();
    await db.query("insert into dialogos_daily_trials(user_id,trial_day,used,reserved) values($1,$2,2,1)", [u.id, day.yesterday]);
    await db.query("update dialogos_budgets set reserved_micro=reserved_micro+8550 where(period='day' and starts_on=$1)or(period='month' and starts_on=$2)", [current.budget_day, current.budget_month]);
    await db.query("update dialogos_trial_budgets set reserved_micro=reserved_micro+8550 where(period='day' and starts_on=$1)or(period='month' and starts_on=$2)", [current.budget_day, current.budget_month]);
    await db.query("insert into dialogos_requests(id,user_id,fingerprint,conversation_id,philosopher_id,user_message,status,reserve_micro,budget_day,budget_month,usage_source,trial_day,created_at) values($1,$2,$3,$4,'nietzsche','前日の問い','reserved',8550,$5,$6,'trial',$7,now()-interval '11 minutes')", [id, u.id, "b".repeat(64), current.conversation_id, current.budget_day, current.budget_month, day.yesterday]);
    return id;
  }
  await t.test("a reply finishing after midnight debits its fixed old day, never the new day", async () => {
    const u = await google(); const id = await previousDayPending(u);
    assert.equal((await state(u)).trial_remaining, 3);
    await assert.rejects(reserve(u), /IN_FLIGHT/);
    const result = await finish(u, id); assert.equal(result.trialDay, day.yesterday);
    assert.equal((await state(u)).trial_remaining, 3);
    assert.equal((await db.query("select used,reserved from dialogos_daily_trials where user_id=$1 and trial_day=$2", [u.id, day.yesterday])).rows[0].used, 3);
  });
  await t.test("unknown across midnight releases only yesterday's quota, expensing full maximum in both budgets", async () => {
    const u = await google(10); const id = await previousDayPending(u); await fail(u, id, null);
    const before = (await db.query("select (select sum(spent_micro) from dialogos_budgets)::text total,(select sum(spent_micro) from dialogos_trial_budgets)::text trial")).rows[0];
    assert.equal((await rpc("dialogos_v3_release_stale", [u.id])).released, 1);
    const after = (await db.query("select (select sum(spent_micro) from dialogos_budgets)::text total,(select sum(spent_micro) from dialogos_trial_budgets)::text trial")).rows[0];
    assert.equal(Number(after.total)-Number(before.total), 17100); assert.equal(Number(after.trial)-Number(before.trial), 17100);
    assert.equal((await state(u)).trial_remaining, 3); assert.equal((await state(u)).credits, 10);
    const oldQuota = (await db.query("select used,reserved from dialogos_daily_trials where user_id=$1 and trial_day=$2", [u.id, day.yesterday])).rows[0];
    assert.deepEqual(oldQuota, { used: 2, reserved: 0 });
    await assert.rejects(finish(u, id), /REQUEST_CLOSED/);
  });
  await t.test("pre-005 lifetime trial requests settle/refund only their old bucket", async () => {
    assert.equal((await finish(oldUser, oldId)).trialDay, null);
    assert.equal((await db.query("select trial_remaining from users where id=$1", [oldUser.id])).rows[0].trial_remaining, 2);
    assert.equal((await state(oldUser)).trial_remaining, 3); assert.equal((await state(oldUser)).credits, 20);
    assert.equal((await rpc("dialogos_v3_release_stale", [oldUnknown.id])).released, 1);
    assert.equal((await db.query("select trial_reserved from users where id=$1", [oldUnknown.id])).rows[0].trial_reserved, 0);
    assert.equal((await state(oldUnknown)).trial_remaining, 3);
  });
  await t.test("paid balances and total/trial budget caps remain unchanged under daily trials", async () => {
    const u = await google(10);
    for (const sage of ["buddha", "nietzsche", "socrates"]) { const id = randomUUID(); await reserve(u, id, sage); await finish(u, id); }
    const paid = randomUUID(); assert.equal((await reserve(u, paid, "nietzsche", "paid")).usage_source, "paid"); await finish(u, paid);
    assert.equal((await state(u)).credits, 9);
    const other = await google(50); const args = reserveArgs(other, randomUUID(), "nietzsche"); args[11] = 8550;
    await assert.rejects(rpc("dialogos_v5_reserve", args), /TRIAL_BUDGET_EXHAUSTED/); assert.equal((await state(other)).credits, 50);
  });
  await t.test("daily ledger and obsolete reserve entry points are closed to clients", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`); await assert.rejects(db.query("select * from dialogos_daily_trials"), /permission denied/); await db.exec("reset role");
    }
    const checks = await db.query("select has_function_privilege('service_role','dialogos_v4_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text)','execute') old_allowed,has_function_privilege('service_role','dialogos_v5_reserve(uuid,uuid,text,uuid,text,text,bigint,bigint,bigint,boolean,boolean,bigint,bigint,text)','execute') current_allowed");
    assert.deepEqual(checks.rows[0], { old_allowed: false, current_allowed: true });
  });
  await db.close();
});
