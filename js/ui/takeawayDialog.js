import { CHATGPT_URL, buildTakeawayPrompt } from "../services/takeawayService.js";
import { philosophers } from "../data/philosophers.js";
import { trackEvent } from "../services/metrics.js";

// Failure never masquerades as a successful copy. Manual selection is an aid,
// not evidence that the user's clipboard changed.
export async function copyTakeawayText(text, { clipboard, secureContext, select } = {}) {
  try {
    if (secureContext !== true || typeof clipboard?.writeText !== "function") throw new Error("manual copy required");
    await clipboard.writeText(text);
    return true;
  } catch {
    select?.();
    return false;
  }
}

export function openTakeawayDialog({ philosopherId, messages = [], source = "card" }) {
  if (!philosophers.some(sage => sage.id === philosopherId)) return;
  document.getElementById("takeawayDialog")?.remove();
  const previousFocus = document.activeElement;
  const sage = philosophers.find(item => item.id === philosopherId);
  const snapshot = messages.filter(item => ["user", "assistant"].includes(item?.role) && typeof item.content === "string")
    .map(({ role, content }) => ({ role, content }));
  const dialog = document.createElement("dialog");
  dialog.id = "takeawayDialog";
  dialog.className = "takeaway-dialog";
  dialog.setAttribute("aria-labelledby", "takeawayTitle");
  dialog.innerHTML = `
    <div class="takeaway-heading"><p class="eyebrow">Take a philosopher with you</p><button type="button" class="secondary-button" id="takeawayClose" aria-label="持ち帰り画面を閉じる">閉じる ×</button></div>
    <h2 id="takeawayTitle"></h2>
    <p>人格のコピーはログイン不要・何度でも無料。対話を試す前でも持ち帰れます。</p>
    <label class="takeaway-conversation"><input id="takeawayIncludeConversation" type="checkbox">現在の画面の会話も含める（任意）</label>
    <p class="takeaway-privacy" id="takeawayPrivacy">既定では人格だけをコピーします。会話を含める場合、現在表示中のあなたと賢者の発言だけが対象です（履歴全体ではありません）。個人情報や相談内容が含まれないか、ChatGPTへ持ち出す前に下の内容を確認してください。</p>
    <label class="takeaway-preview-label" for="takeawayPrompt">コピーする内容</label>
    <textarea id="takeawayPrompt" class="takeaway-preview" readonly rows="10" spellcheck="false" aria-describedby="takeawayPrivacy takeawayWarning"></textarea>
    <p id="takeawayWarning" class="takeaway-warning" hidden></p>
    <div class="takeaway-actions"><button type="button" class="primary-button" id="takeawayCopy">人格をコピーする</button><button type="button" class="secondary-button" id="takeawaySelect">選択して手動コピー</button></div>
    <p id="takeawayStatus" class="takeaway-status" role="status" aria-live="polite"></p>
    <ol class="takeaway-steps"><li>上の内容をコピーする</li><li>ChatGPTを開く</li><li>新しいチャットに貼り付けて送信する</li></ol>
    <a id="takeawayOpenChatGPT" class="secondary-button takeaway-open-link" target="_blank" rel="noopener noreferrer">ChatGPTを開く ↗</a>
    <p class="composer-note">このボタンはChatGPTを開くだけです。本文をURLに載せたり、自動送信したりしません。ChatGPT側のログイン・利用条件・回数制限が適用され、同じ返答や継続的な人格の保存を保証するものではありません。</p>
  `;
  document.body.appendChild(dialog);
  const query = selector => dialog.querySelector(selector);
  const checkbox = query("#takeawayIncludeConversation");
  const textarea = query("#takeawayPrompt");
  const status = query("#takeawayStatus");
  const copyButton = query("#takeawayCopy");
  const warning = query("#takeawayWarning");
  query("#takeawayTitle").textContent = `${sage.name}を、あなたのChatGPTへ`;
  checkbox.checked = false;
  checkbox.disabled = snapshot.length === 0;
  const updatePreview = () => {
    const result = buildTakeawayPrompt({ philosopherId, includeConversation: checkbox.checked === true, messages: snapshot });
    textarea.value = result.prompt;
    warning.textContent = result.warning || "";
    warning.hidden = !result.warning;
    status.textContent = "";
    copyButton.textContent = checkbox.checked ? "人格と会話をコピーする" : "人格をコピーする";
  };
  const selectText = () => { textarea.focus(); textarea.select(); textarea.setSelectionRange(0, textarea.value.length); };
  const manualMessage = "自動コピーはできていません。選択された本文を、右クリック・長押しの「コピー」、または Ctrl+C / ⌘C でコピーしてください。";
  checkbox.addEventListener("change", updatePreview);
  query("#takeawaySelect").addEventListener("click", () => {
    selectText();
    status.textContent = manualMessage;
    trackEvent("takeaway_manual_copy", { philosopherId, source });
  });
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    checkbox.disabled = true;
    status.textContent = "コピーを確認中…";
    const copied = await copyTakeawayText(textarea.value, {
      clipboard: navigator.clipboard, secureContext: window.isSecureContext, select: selectText,
    });
    status.textContent = copied ? "コピーしました。ChatGPTを開き、新しいチャットに貼り付けて送信してください。" : manualMessage;
    trackEvent(copied ? "takeaway_copy_success" : "takeaway_manual_copy", { philosopherId, source });
    copyButton.disabled = false;
    checkbox.disabled = snapshot.length === 0;
  });
  const openLink = query("#takeawayOpenChatGPT");
  openLink.href = CHATGPT_URL;
  openLink.addEventListener("click", () => trackEvent("takeaway_chatgpt_open", { philosopherId, source }));
  query("#takeawayClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { dialog.remove(); previousFocus?.focus?.(); }, { once: true });
  updatePreview();
  dialog.showModal();
  query("#takeawayClose").focus();
  trackEvent("takeaway_open", { philosopherId, source });
}
