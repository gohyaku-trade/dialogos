import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("paid v3 migration and financial RPC invariants (isolated PostgreSQL)", async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create role anon; create role authenticated; create role service_role;");
  const base = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/003_paid_v3.sql", import.meta.url), "utf8");
  await db.exec(base);
  const user = randomUUID();
  const auth = randomUUID();
  await db.query("insert into users(id,guest_id,auth_user_id,credits,free_count) values($1,'legacy-user',$2,20,10)", [user, auth]);
  await db.exec(migration);
  await db.exec(migration);
  const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args)).rows[0].value;
  const reserve = (id = randomUUID(), fingerprint = "a".repeat(64), day = 3000000, month = 30000000, userId = user) => rpc("dialogos_v3_reserve", [userId, id, fingerprint, null, "socrates", "正義とは何か", 8550, day, month]);
  const balance = async () => (await db.query("select credits,reserved_credits,free_count from users where id=$1", [user])).rows[0];
  const fail = (id, cost = 0) => rpc("dialogos_v3_fail", [user, id, cost, null, "TEST"]);

  await t.test("migration is repeatable and preserves existing balance and historical free_count", async () => {
    assert.deepEqual(await balance(), { credits: 20, reserved_credits: 0, free_count: 10 });
    assert.equal((await db.query("select count(*)::int as n from dialogos_v3_schema")).rows[0].n, 1);
    const created = await rpc("dialogos_v3_user", [randomUUID(), "new@example.test", null]);
    assert.equal(created.credits, 0); assert.equal(created.free_count, 0);
  });
  await t.test("anonymous and authenticated browser roles cannot call financial RPCs or read budgets", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(reserve(), /permission denied/);
      await assert.rejects(rpc("dialogos_v3_release_stale", [user]), /permission denied/);
      await assert.rejects(db.query("select * from dialogos_budgets"), /permission denied/);
      await db.exec("reset role");
    }
  });
  await t.test("same UUID replay and parallel submissions reserve just one credit", async () => {
    const id = randomUUID();
    const results = await Promise.all([reserve(id), reserve(id)]);
    assert.equal(results.filter(r => r.new_reservation).length, 1);
    assert.deepEqual(await balance(), { credits: 20, reserved_credits: 1, free_count: 10 });
    await assert.rejects(reserve(id, "b".repeat(64)), /REQUEST_CONFLICT/);
    await assert.rejects(reserve(), /IN_FLIGHT/);
    await fail(id);
  });
  await t.test("a completed reply saves two messages, state and one debit in one transaction; replay is free", async () => {
    const id = randomUUID();
    const request = await reserve(id);
    await assert.rejects(rpc("dialogos_v3_finalize", [user, id, "返答", null, {}, 100, "resp_null_state"]), /INVALID_FINALIZATION/);
    const args = [user, id, "君のいう正義には、誰の利益が含まれるだろう。", { turn: 1, claims: ["正義の定義を問う"] }, { input_tokens: 1000, output_tokens: 200 }, 1650, "resp_test"];
    const result = await rpc("dialogos_v3_finalize", args);
    assert.deepEqual(await rpc("dialogos_v3_finalize", args), result);
    assert.equal((await balance()).credits, 19);
    assert.equal((await balance()).reserved_credits, 0);
    assert.equal((await db.query("select count(*)::int as n from messages where conversation_id=$1", [request.conversation_id])).rows[0].n, 2);
    assert.equal((await db.query("select dialogue_state from conversations where id=$1", [request.conversation_id])).rows[0].dialogue_state.turn, 1);
    assert.equal((await fail(id)).status, "completed");
  });
  await t.test("a save failure rolls back cost, messages and debit", async () => {
    const id = randomUUID();
    const request = await reserve(id);
    // Force the final credit invariant to fail AFTER the insert statements.
    await db.query("update users set credits=0 where id=$1", [user]);
    await assert.rejects(rpc("dialogos_v3_finalize", [user, id, "返答", {}, {}, 100, "resp_failure"]), /CREDIT_INVARIANT/);
    assert.equal((await db.query("select count(*)::int as n from messages where conversation_id=$1", [request.conversation_id])).rows[0].n, 0);
    assert.equal((await db.query("select status from dialogos_requests where id=$1", [id])).rows[0].status, "reserved");
    await db.query("update users set credits=19 where id=$1", [user]);
    await fail(id, 100);
    assert.equal((await balance()).credits, 19);
  });
  await t.test("unknown provider charge holds both reservations and blocks new generation", async () => {
    const id = randomUUID();
    await reserve(id);
    const row = await fail(id, null);
    assert.equal(row.status, "unknown");
    assert.equal((await balance()).reserved_credits, 1);
    await assert.rejects(reserve(), /IN_FLIGHT/);
    assert.equal((await reserve(id)).status, "unknown");
    // Simulate proven operator reconciliation; no time-based automatic refund.
    await fail(id, 200);
  });
  await t.test("daily and monthly maximum costs are checked before generation", async () => {
    await assert.rejects(reserve(randomUUID(), "a".repeat(64), 8550, 30000000), /BUDGET_EXHAUSTED/);
    await assert.rejects(reserve(randomUUID(), "a".repeat(64), 3000000, 8550), /BUDGET_EXHAUSTED/);
    assert.equal((await balance()).reserved_credits, 0);
    const other = randomUUID();
    await db.query("insert into users(id,guest_id,auth_user_id,credits) values($1,$2,$3,1)", [other, `test_${other}`, randomUUID()]);
    const id = randomUUID();
    await reserve(id);
    await assert.rejects(reserve(randomUUID(), "a".repeat(64), 15000, 30000000, other), /BUDGET_EXHAUSTED/);
    await fail(id);
  });
  await t.test("atomic Stripe grant credits once even for duplicate deliveries", async () => {
    const args = [user, "cs_test_payment", "cus_owned", "v3_40", 100, 40, "credits"];
    const results = await Promise.all([rpc("dialogos_v3_grant", args), rpc("dialogos_v3_grant", args)]);
    assert.equal(results.filter(r => !r.already_applied).length, 1);
    assert.equal((await balance()).credits, 59);
    await assert.rejects(rpc("dialogos_v3_grant", [user, "cs_bad_amount", "cus_owned", "v3_40", 1, 40, "credits"]), /INVALID_PAYMENT/);
    await assert.rejects(rpc("dialogos_v3_grant", [user, "cs_bad_customer", "cus_other", "v3_40", 100, 40, "credits"]), /CUSTOMER_MISMATCH/);
    assert.equal((await balance()).credits, 59);
  });
  await t.test("stale unknown recovery restores credit but expenses full maximum; old ID is terminal", async () => {
    const id = randomUUID();
    await reserve(id);
    await fail(id, null);
    assert.equal((await rpc("dialogos_v3_release_stale", [user])).released, 0);
    await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [id]);
    const before = (await db.query("select sum(spent_micro)::text as spent,sum(reserved_micro)::text as reserved from dialogos_budgets")).rows[0];
    const settled = await Promise.all([rpc("dialogos_v3_release_stale", [user]), rpc("dialogos_v3_release_stale", [user])]);
    assert.equal(settled.reduce((sum, row) => sum + row.released, 0), 1);
    const after = (await db.query("select sum(spent_micro)::text as spent,sum(reserved_micro)::text as reserved from dialogos_budgets")).rows[0];
    // Two period ledgers: daily and monthly each retain the full reserved cost.
    assert.equal(Number(after.spent) - Number(before.spent), 8550 * 2);
    assert.equal(Number(before.reserved) - Number(after.reserved), 8550 * 2);
    assert.equal((await balance()).credits, 59); assert.equal((await balance()).reserved_credits, 0);
    const row = (await db.query("select * from dialogos_requests where id=$1", [id])).rows[0];
    assert.equal(row.status, "failed"); assert.equal(row.failure_code, "STALE_ESTIMATED_COST");
    assert.equal(row.actual_micro, null); assert.equal(Number(row.estimated_micro), 8550); assert.equal(row.token_usage.cost_estimated, true);
    assert.equal((await reserve(id)).status, "failed");
    await assert.rejects(rpc("dialogos_v3_finalize", [user, id, "遅れた返答", {}, {}, 100, "resp_late"]), /REQUEST_CLOSED/);
    assert.equal((await fail(id, 0)).status, "failed");
  });
  await t.test("completion before stale recovery wins and remains charged exactly once", async () => {
    const id = randomUUID(); await reserve(id);
    await db.query("update dialogos_requests set created_at=now()-interval '11 minutes' where id=$1", [id]);
    const results = await Promise.all([
      rpc("dialogos_v3_finalize", [user, id, "保存済みの返答", { turn: 1 }, {}, 100, "resp_complete_first"]),
      rpc("dialogos_v3_release_stale", [user]),
    ]);
    assert.equal(results[1].released, 0); assert.equal((await balance()).credits, 58);
    assert.equal((await reserve(id)).status, "completed");
  });
  await t.test("six new requests per minute include failures; seventh is blocked while ID replay remains free", async () => {
    const limitedUser = randomUUID();
    await db.query("insert into users(id,guest_id,auth_user_id,credits) values($1,$2,$3,10)", [limitedUser, `limited_${limitedUser}`, randomUUID()]);
    let firstId;
    for (let n = 0; n < 6; n++) {
      const id = randomUUID(); firstId ||= id;
      await reserve(id, "a".repeat(64), 3000000, 30000000, limitedUser);
      await rpc("dialogos_v3_fail", [limitedUser, id, 0, null, "COUNT_REJECTED"]);
    }
    await assert.rejects(reserve(randomUUID(), "a".repeat(64), 3000000, 30000000, limitedUser), /RATE_LIMIT/);
    assert.equal((await reserve(firstId, "a".repeat(64), 3000000, 30000000, limitedUser)).status, "failed");
    const row = (await db.query("select credits,reserved_credits from users where id=$1", [limitedUser])).rows[0];
    assert.deepEqual(row, { credits: 10, reserved_credits: 0 });
    assert.equal((await db.query("select count(*)::int as n from dialogos_requests where user_id=$1", [limitedUser])).rows[0].n, 6);
  });
  await db.close();
});
