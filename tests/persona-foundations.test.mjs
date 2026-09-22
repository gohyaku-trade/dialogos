import test from "node:test";
import assert from "node:assert/strict";
import { PERSONA_IDS, PERSONA_REVISION, buildDialogueInstructions, buildTakeawayPersona } from "../shared/dialogue.js";
import { PERSONA_FOUNDATIONS, buildPersonaFoundationInstructions } from "../shared/persona-foundations.js";
import { TAKEAWAY_REVISION } from "../js/data/takeawayPersonas.js";
import { buildTakeawayPrompt, TAKEAWAY_LIMITS } from "../js/services/takeawayService.js";

// Distribution/contract tests. Historical fidelity still requires human review.
test("every portable copy retains its source scope and inspectable references without a server dependency", () => {
  assert.deepEqual(Object.keys(PERSONA_FOUNDATIONS), PERSONA_IDS);
  assert.equal(TAKEAWAY_REVISION, PERSONA_REVISION);
  for (const id of PERSONA_IDS) {
    const foundation = PERSONA_FOUNDATIONS[id];
    const copy = buildTakeawayPrompt({ philosopherId: id });
    assert.equal(copy.prompt, buildTakeawayPersona(id).prompt);
    for (const value of [foundation.scope, foundation.commitments, foundation.revision, foundation.distinction]) {
      assert.ok(copy.prompt.includes(value), `${id}: lost part of the portable judgement contract`);
      assert.ok(buildDialogueInstructions(id).includes(value), `${id}: API/copy drift`);
    }
    for (const { label, url } of foundation.sources) {
      assert.equal(new URL(url).protocol, "https:");
      assert.ok(copy.prompt.includes(label) && copy.prompt.includes(url), `${id}: source must travel with the copy`);
    }
    // Worst possible serialized history plus continuation framing fits the
    // existing export cap; prompt growth must not silently break copying.
    assert.ok([...copy.prompt].length + TAKEAWAY_LIMITS.maxConversationChars + 1500 <= TAKEAWAY_LIMITS.maxPromptChars);
    assert.doesNotMatch(copy.prompt, /recentMoves|dialogue_state|OPENAI_API_KEY|DIALOGUE_SCHEMA/);
  }
});

test("foundation lookup rejects inherited names and its nested source data cannot be mutated", () => {
  for (const id of [undefined, null, "constructor", "__proto__", "unknown"]) {
    assert.throws(() => buildPersonaFoundationInstructions(id), /UNKNOWN_PHILOSOPHER/);
  }
  assert.throws(() => { PERSONA_FOUNDATIONS.buddha.sources[0].label = "changed"; }, TypeError);
  assert.throws(() => { PERSONA_FOUNDATIONS.nietzsche.commitments = "changed"; }, TypeError);
});
