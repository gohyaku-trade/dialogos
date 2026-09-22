// Opt-in, bounded synthetic QA. No customer conversations or payments are used.
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { PERSONA_IDS, DIALOGUE_SCHEMA, buildDialogueInstructions, buildDialogueInput, normalizeDialogueState, parseDialogueResponse } from "../shared/dialogue.js";
if (process.env.LIVE_DIALOGUE_QA !== "1") throw new Error("Set LIVE_DIALOGUE_QA=1 to authorize this paid model smoke test.");
config({ path: process.env.DIALOGOS_QA_ENV_PATH || ".env" });
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
const cap = 0.25;
const effort = process.env.QA_REASONING === "low" ? "low" : "none";
const report = { model: "gpt-5.4-mini", effort, startedAt: new Date().toISOString(), capUSD: cap, usedUSD: 0, results: [] };
const histories = new Map();
const cases = PERSONA_IDS.map(id => ({ id, message: "善い人生とは、本人が満足していれば十分ですか。私自身の悩みではなく、判断の根拠を知りたいです。" }));
for (const id of ["socrates", "nietzsche", "buddha"]) {
  cases.push({ id, message: "でも、満足が他人への害の上に成り立つ場合もあります。『本人が選んだ』だけでは、なぜ十分ではないのでしょう。私を不安な人だとは推測しないでください。" });
  cases.push({ id, message: "私がここでいう満足は快楽でなく、自分の行為の理由を吟味して納得していることです。前の定義をこの意味に訂正します。あなたの前の答えのどこが変わり、どこは変わりませんか。問い返しではなく説明してください。" });
}
mkdirSync("qa-output", { recursive: true });
for (const item of cases) {
  if (process.env.QA_PERSONAS && !process.env.QA_PERSONAS.split(",").includes(item.id)) continue;
  if (report.usedUSD + 0.00855 > cap) throw new Error("QA_COST_CAP");
  const history = histories.get(item.id) || { messages: [], state: normalizeDialogueState({}) };
  const payload = { model: report.model, instructions: buildDialogueInstructions(item.id),
    input: buildDialogueInput({ ...history, message: item.message }), reasoning: { effort }, text: { format: DIALOGUE_SCHEMA }, service_tier: "default" };
  const headers = { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" };
  const start = Date.now();
  try {
    const { service_tier, ...countPayload } = payload;
    const counted = await fetch("https://api.openai.com/v1/responses/input_tokens", { method: "POST", headers, body: JSON.stringify(countPayload), signal: AbortSignal.timeout(20000) });
    const counts = await counted.json();
    if (!counted.ok || !Number.isSafeInteger(counts.input_tokens) || counts.input_tokens > 6000) throw new Error("COUNT_" + counted.status + ":" + JSON.stringify(counts));
    // Reserve the entire potential request cost, even if transport fails.
    report.usedUSD += 0.00855;
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers,
      body: JSON.stringify({ ...payload, max_output_tokens: 900, store: false }), signal: AbortSignal.timeout(65000) });
    const data = await response.json();
    if (!response.ok) throw new Error("MODEL_" + response.status + ":" + JSON.stringify(data));
    const parsed = parseDialogueResponse(data);
    history.messages.push({ role: "user", content: item.message }, { role: "assistant", content: parsed.reply });
    history.state = parsed.state; histories.set(item.id, history);
    const cost = (data.usage.input_tokens - (data.usage.input_tokens_details?.cached_tokens || 0)) * .75 / 1e6
      + (data.usage.input_tokens_details?.cached_tokens || 0) * .075 / 1e6 + data.usage.output_tokens * 4.5 / 1e6;
    report.usedUSD += cost - .00855;
    report.results.push({ ...item, ...parsed, ms: Date.now() - start, inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, costUSD: cost });
    console.log(JSON.stringify({ persona: item.id, status: "ok", input: data.usage.input_tokens, output: data.usage.output_tokens, costUSD: cost }));
  } catch (err) {
    // Error responses do not echo credentials; customer inputs never enter this script.
    report.results.push({ ...item, error: String(err.message), ms: Date.now() - start });
    console.error("Quality probe stopped:", err.message);
    process.exitCode = 1;
    break;
  } finally { writeFileSync("qa-output/live-quality-" + effort + ".json", JSON.stringify(report, null, 2)); }
}
console.log(JSON.stringify({ completed: report.results.filter(r => r.reply).length, costUpperBoundUSD: report.usedUSD }));
