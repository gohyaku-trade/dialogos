import test from "node:test";
import assert from "node:assert/strict";
import { PERSONA_IDS, DIALOGUE_SCHEMA, buildDialogueInstructions, buildTakeawayPersona } from "../shared/dialogue.js";
import { buildPersonaVoiceInstructions } from "../shared/persona-voices.js";
import { buildPersonaFoundationInstructions } from "../shared/persona-foundations.js";

// These are authored-prompt regression checks, NOT scores for generated answers.
const signatures = {
  socrates: ["論点が曖昧な時だけ", "具体的な反例", "暫定的な説明"],
  plato: ["魂および共同体の秩序", "比喩は証明ではない", "現代科学の確定事実にしない"],
  aristotle: ["何をどんな理由で選ぶか", "結果がよいだけで徳とはしない", "一生を通じた徳に即した活動"],
  epictetus: ["自分の判断・選択", "自分次第ではない外的な結果", "成功は所有できない"],
  marcus: ["共同の利益にかなう務め", "理性ある仲間", "自分だけの平静で閉じず"],
  nietzsche: ["価値がどこから来て", "反対するだけを価値創造とせず", "同意を群れの弱さと決めつけない"],
  schopenhauer: ["意志を意志の強さに", "表象を単なる嘘にせず", "観照や同情"],
  laozi: ["足るを知る", "無為を望み通りに操る万能技法にしない", "必要な手入れ"],
  confucius: ["仁・礼・義", "上に立つ側の責任も問う", "不正に対する諫め"],
  zhuangzi: ["その場で役立つ区別や熟練", "どの見方も同じ正しさとせず", "物差しの用途と限界"],
  shankara: ["身体・心の性質を自己そのものへ重ねる誤認", "自己を心の中の別の観察対象にはせず", "無我と同じ結論に混ぜず"],
  buddha: ["自己嫌悪や行為の責任の消滅でなく", "固定した私・私のもの", "恒常的な観察者を究極の自己として断言しない"],
  jesus: ["神への愛と隣人への愛の結びつき", "信仰の前提は相手との合意と決めない", "赦し・責任追及・再び近づくことを分け"],
  muhammad: ["唯一神への信仰", "身内への忠誠も公正に照らし", "本人として一人称で語らず"],
};

test("the complete fourteen-persona review is reflected in API and take-home prompts", () => {
  assert.deepEqual(Object.keys(signatures), PERSONA_IDS);
  for (const [id, markers] of Object.entries(signatures)) {
    for (const prompt of [buildDialogueInstructions(id), buildTakeawayPersona(id).prompt]) {
      for (const marker of markers) assert.ok(prompt.includes(marker), `${id}: missing reviewed distinction ${marker}`);
    }
  }
});

test("personas retain unique values, evidence, methods, responses to objections and lenses", () => {
  for (const field of ["価値:", "何を根拠とするか:", "考え方:", "反論された時:", "この人格を他と区別する軸:"]) {
    const lines = PERSONA_IDS.map(id => buildDialogueInstructions(id).split("\n").find(line => line.startsWith(field)));
    assert.ok(lines.every(Boolean), field);
    assert.equal(new Set(lines).size, 14, `${field}: generic replacement erased a persona`);
  }
});

test("similar traditions keep opposing explanations instead of merging into one counselor", () => {
  const lens = id => buildDialogueInstructions(id).split("\n").find(line => line.startsWith("この人格を他と区別する軸:"));
  assert.match(lens("socrates"), /十分条件を試す/);
  assert.match(lens("plato"), /魂の各働きの秩序/);
  assert.match(lens("aristotle"), /外的条件/);
  assert.match(lens("epictetus"), /結果の所有でなく選択/);
  assert.match(lens("marcus"), /共同体の中/);
  assert.match(lens("nietzsche"), /生の肯定/);
  assert.match(lens("schopenhauer"), /意志への奉仕から離れる/);
  assert.match(lens("laozi"), /過剰な作為を減らす/);
  assert.match(lens("zhuangzi"), /物差しは誰の立場/);
  assert.match(lens("shankara"), /不二一元の前提/);
  assert.match(lens("buddha"), /恒常的な真の自己へ飛ばない/);
});

test("every persona offers substance promptly without a compulsory question or unearned agreement", () => {
  for (const id of PERSONA_IDS) {
    const api = buildDialogueInstructions(id);
    const takeaway = buildTakeawayPersona(id).prompt;
    for (const prompt of [api, takeaway]) {
      assert.match(prompt, /全手順を詰め込まず/);
      assert.match(prompt, /深い話を次の往復へ先延ばしにしない/);
      assert.match(prompt, /理由なしに迎合して立場を反転させない/);
      assert.match(prompt, /説明や暫定的な整理だけで終えて/);
      assert.match(prompt, /問い返しだけで逃げ/);
    }
    assert.match(api, /質問は最大一つ/);
    assert.match(takeaway, /質問は一度に最大一つ/);
  }
});

test("distinct voices keep output/state contracts and bounded prompt growth", () => {
  assert.equal(DIALOGUE_SCHEMA.schema.properties.reply.maxLength, 400);
  assert.deepEqual(DIALOGUE_SCHEMA.schema.required, ["reply", "state"]);
  for (const id of PERSONA_IDS) {
    const api = buildDialogueInstructions(id);
    const takeaway = buildTakeawayPersona(id).prompt;
    const voice = buildPersonaVoiceInstructions(id);
    // Source-bounded commitments and a coherent objection/response exchange.
    // Character ceilings are regression guards, NOT provider token counts;
    // runtime and the live probe retain the authoritative 6000-token limit.
    assert.ok([...voice].length <= 780, `${id}: keep the voice block compact`);
    assert.ok([...buildPersonaFoundationInstructions(id)].length <= 650, `${id}: compact API source guide`);
    assert.ok([...buildPersonaFoundationInstructions(id, { portable: true })].length <= 1000, `${id}: portable sources`);
    assert.ok([...api].length <= 4200, `${id}: review total prompt growth`);
    assert.ok([...takeaway].length <= 4300, `${id}: keep take-home instructions compact`);
    assert.match(api, /最大220字/);
    assert.match(api, /各項目は64字以内/);
    assert.doesNotMatch(takeaway, /replyとstate|最大400字|recentMoves/);
  }
});
