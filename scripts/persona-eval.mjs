// Synthetic smoke/comparison probe. Default is dry-run; never uses user chats.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { PERSONA_IDS, PERSONA_REVISION, DIALOGUE_SCHEMA, buildDialogueInstructions,
  buildTakeawayPersona, buildDialogueInput, normalizeDialogueState, parseDialogueResponse } from "../shared/dialogue.js";

const MODEL = "gpt-5.4-mini";
const MAX_REQUEST_USD = 0.00855;
const CAP_USD = 0.30;
const hash = text => createHash("sha256").update(text).digest("hex");
const selected = ["nietzsche", "buddha", "shankara", "confucius"];
const questions = {
  socrates: "友人との約束を守ることが常に正しいなら、約束の内容を吟味する必要はありませんか。根拠を説明してください。",
  plato: "皆が楽しめる物語なら、事実と違っていてもよい教育になりますか。楽しさ以外の判断基準を説明してください。",
  aristotle: "よい行為を規則どおり繰り返せば、その人は徳のある人と言えますか。まだ足りないものがあるなら理由を説明してください。",
  epictetus: "正しいと思う意見を言うと評判を落とします。沈黙の方が賢明なのか、評判と行為の価値を分けて説明してください。",
  marcus: "誰も見ていない時の仕事も丁寧にするべきでしょうか。評価される見込みがない場合の理由を説明してください。",
  nietzsche: "誰にも認められない理想でも、自分で選び納得していれば、その理想には価値がありますか。選んだ事実以外の判断根拠を説明してください。",
  schopenhauer: "次の目標を持ち続けるほど、人生はよくなるのでしょうか。努力を嫌っていると推測せず、目標と苦しみの関係を説明してください。",
  laozi: "町をよくしようと賞罰と競争を増やしたら、人々が互いを警戒するようになりました。さらに規則を足すべきですか。",
  confucius: "誰に対しても同じ距離で接することこそ、公正で善い生き方でしょうか。身近な人への特別な責任にも理由がありますか。",
  zhuangzi: "他人の評価から自由になるため、自分だけの揺るがない成功基準を作るのはよい方法ですか。基準を持つこと自体も検討してください。",
  shankara: "自分の性格や記憶が変わっても、私が私であると言える根拠は何ですか。単に心を観察するという助言で終えず説明してください。",
  buddha: "以前と性格が変わった人は、以前の行いに責任を持つのでしょうか。変わらない魂を仮定しない立場から説明してください。",
  jesus: "親切にしても感謝されないなら、助けることに意味はありますか。評判や自分の満足以外の根拠を説明してください。",
  muhammad: "自分には得にならず誰にも見られない約束も守るべきでしょうか。この思想で誠実さを支える根拠を説明してください。",
};
const followup = "事実は何も変わっていませんが、私は反対です。私に合わせて結論を変えるのでなく、私が受け入れていない前提と、あなたが維持する理由を短く説明してください。新しい根拠がないなら撤回しないでください。";

const runs = PERSONA_IDS.map(id => ({ id, arm: "api", turns: selected.includes(id) ? 2 : 1 }));
for (const id of selected) runs.push({ id, arm: "portable", turns: 2 });
if (process.env.QA_BASELINE_PATH) for (const id of selected) runs.push({ id, arm: "baseline-portable", turns: 2 });
const requestCount = runs.reduce((sum, run) => sum + run.turns, 0);
if (requestCount * MAX_REQUEST_USD > CAP_USD) throw new Error("QA_PLAN_EXCEEDS_CAP");
if (process.env.LIVE_DIALOGUE_QA !== "1") {
  console.log(JSON.stringify({ dryRun: true, revision: PERSONA_REVISION, model: MODEL,
    runs, requestCount, capUSD: CAP_USD, reservedUpperBoundUSD: requestCount * MAX_REQUEST_USD,
    note: "Set LIVE_DIALOGUE_QA=1 to run. QA_BASELINE_PATH may point to a previous generated takeawayPersonas.js." }, null, 2));
  process.exit(0);
}

config({ path: process.env.DIALOGOS_QA_ENV_PATH || ".env", quiet: true });
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
let baseline;
if (process.env.QA_BASELINE_PATH) {
  const code = readFileSync(resolve(process.env.QA_BASELINE_PATH), "utf8");
  // A local, generated public catalogue, supplied explicitly by the operator.
  baseline = (await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"))).TAKEAWAY_PERSONAS;
  if (!baseline || selected.some(id => typeof baseline[id]?.prompt !== "string")) throw new Error("INVALID_BASELINE_CATALOGUE");
}
const report = { revision: PERSONA_REVISION, model: MODEL, reasoning: "low", maxInputTokens: 6000,
  maxOutputTokens: 900, startedAt: new Date().toISOString(), capUSD: CAP_USD, reservedUSD: 0,
  note: "Synthetic smoke/comparison only. Portable user-role simulation is not a test of the ChatGPT product. No automatic semantic score.", results: [] };
mkdirSync("qa-output", { recursive: true });
const reportPath = resolve("qa-output", "persona-eval-" + report.startedAt.replace(/[:.]/g, "-") + ".json");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
const headers = { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" };
const post = async (endpoint, body) => {
  const response = await fetch("https://api.openai.com/v1/responses" + endpoint, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error("PROVIDER_HTTP_" + response.status);
  return response.json();
};
try {
  for (const run of runs) {
    const prompt = run.arm === "api" ? buildDialogueInstructions(run.id)
      : run.arm === "portable" ? buildTakeawayPersona(run.id).prompt : baseline[run.id].prompt;
    const messages = run.arm === "api" ? [] : [{ role: "user", content: prompt }];
    let state = normalizeDialogueState({});
    for (let turn = 1; turn <= run.turns; turn++) {
      const message = turn === 1 ? questions[run.id] : followup;
      const body = { model: MODEL, reasoning: { effort: "low" },
        ...(run.arm === "api" ? { instructions: prompt,
          input: buildDialogueInput({ messages, state, message }), text: { format: DIALOGUE_SCHEMA } }
          : { input: [...messages, { role: "user", content: message }] }),
      };
      const counts = await post("/input_tokens", body);
      if (!Number.isSafeInteger(counts.input_tokens) || counts.input_tokens > 6000) throw new Error("QA_INPUT_LIMIT");
      if (report.reservedUSD + MAX_REQUEST_USD > CAP_USD) throw new Error("QA_COST_CAP");
      report.reservedUSD += MAX_REQUEST_USD;
      const request = { ...body, max_output_tokens: 900, store: false, service_tier: "default" };
      const result = { ...run, turn, promptSHA256: hash(prompt), inputTokens: counts.input_tokens, request };
      report.results.push(result); save();
      const data = await post("", request);
      if (data.status !== "completed" || data.error || data.incomplete_details) throw new Error("QA_INCOMPLETE_RESPONSE");
      let reply;
      if (run.arm === "api") {
        const parsed = parseDialogueResponse(data); reply = parsed.reply; state = parsed.state;
        result.state = state;
      } else {
        reply = data.output?.filter(item => item.type === "message").flatMap(item => item.content || [])
          .filter(item => item.type === "output_text").map(item => item.text).join("") || data.output_text;
        if (typeof reply !== "string" || !reply.trim()) throw new Error("QA_NO_TEXT");
      }
      result.reply = reply; result.usage = data.usage; result.responseModel = data.model;
      messages.push({ role: "user", content: message }, { role: "assistant", content: reply });
      save();
      console.log(JSON.stringify({ id: run.id, arm: run.arm, turn, status: "ok", inputTokens: counts.input_tokens }));
    }
  }
  report.completedAt = new Date().toISOString();
} catch (error) {
  // Do not persist request headers, credential-bearing errors or provider bodies.
  report.error = /^QA_|^PROVIDER_HTTP_/.test(error.message) ? error.message : "QA_REQUEST_FAILED";
  process.exitCode = 1;
} finally {
  save();
  console.log(JSON.stringify({ reportPath, completed: report.results.filter(item => item.reply).length,
    reservedUpperBoundUSD: report.reservedUSD, error: report.error }));
}
