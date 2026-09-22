import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, trackEvent, getTakeawayMetrics } from "../js/services/metrics.js";

test("takeaway events exclude every field except fixed categorical values", () => {
  assert.deepEqual(normalizeEvent("takeaway_copy_success", {
    philosopherId: "socrates", source: "card", email: "private@example.test",
    text: "private conversation", userId: "secret", url: "https://example.test/#token"
  }), { eventName: "takeaway_copy_success", philosopherId: "socrates", source: "card" });
  for (const event of [null, "paste_complete", "purchase", "private conversation"]) {
    assert.equal(normalizeEvent(event, { philosopherId: "socrates", source: "card" }), null);
  }
  assert.equal(normalizeEvent("takeaway_open", null), null);
  assert.equal(normalizeEvent("takeaway_open", { philosopherId: "unknown", source: "card" }), null);
  assert.equal(normalizeEvent("takeaway_open", { philosopherId: "socrates", source: "https://private.test" }), null);
});

test("takeaway metrics are bounded in-memory diagnostics, not a claim of ChatGPT use", () => {
  trackEvent("takeaway_copy_success", { philosopherId: "socrates", source: "card" });
  trackEvent("takeaway_copy_success", { philosopherId: "socrates", source: "card" });
  const found = getTakeawayMetrics().find((row) => row.eventName === "takeaway_copy_success");
  assert.deepEqual(found, { eventName: "takeaway_copy_success", philosopherId: "socrates", source: "card", count: 2 });
  found.count = 99;
  assert.equal(getTakeawayMetrics()[0].count, 2);
  trackEvent("paste_complete", { philosopherId: "socrates", source: "card" });
  assert.equal(getTakeawayMetrics().length, 1);
});
