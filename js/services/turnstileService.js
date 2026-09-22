const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise;
let cancelCurrent;
const failure = code => Object.assign(new Error(code), { code });

function loadTurnstile() {
  if (window.turnstile?.render) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      const timer = setTimeout(() => { script.remove(); reject(failure("TURNSTILE_LOAD_FAILED")); }, 12000);
      script.onload = () => { clearTimeout(timer); window.turnstile?.render ? resolve(window.turnstile) : reject(failure("TURNSTILE_LOAD_FAILED")); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(failure("TURNSTILE_LOAD_FAILED")); };
      document.head.appendChild(script);
    }).catch(error => { scriptPromise = null; throw error; });
  }
  return scriptPromise;
}

export function cancelTurnstile() { cancelCurrent?.(); }

// Called only from an explicit start/send gesture, never from render or boot.
export function requestTurnstileToken({ siteKey, action, requestId } = {}) {
  if (typeof siteKey !== "string" || !siteKey.trim() || !["guest_session", "guest_chat"].includes(action)) return Promise.reject(failure("TURNSTILE_NOT_CONFIGURED"));
  cancelTurnstile();
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "takeaway-dialog";
    dialog.id = "trialChallengeDialog";
    dialog.setAttribute("aria-labelledby", "trialChallengeTitle");
    dialog.innerHTML = `<h2 id="trialChallengeTitle">無料対話の利用確認</h2><p>自動プログラムによる利用を防ぐための確認です。Googleログインは不要です。</p><p role="status" id="trialChallengeStatus">確認を読み込んでいます…</p><div id="trialChallengeWidget"></div><button type="button" class="secondary-button" id="trialChallengeCancel">やめて戻る</button>`;
    document.body.appendChild(dialog);
    let finished = false;
    let provider;
    let widgetId;
    let timeout;
    const finish = (error, token) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (widgetId !== undefined) { try { provider?.remove(widgetId); } catch {} }
      dialog.remove();
      cancelCurrent = null;
      error ? reject(error) : resolve(token);
    };
    cancelCurrent = () => finish(failure("TURNSTILE_CANCELLED"));
    dialog.querySelector("#trialChallengeCancel").addEventListener("click", cancelCurrent);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(failure("TURNSTILE_CANCELLED")); });
    dialog.showModal();
    timeout = setTimeout(() => finish(failure("TURNSTILE_TIMEOUT")), 120000);
    loadTurnstile().then(turnstile => {
      if (finished) return;
      provider = turnstile;
      dialog.querySelector("#trialChallengeStatus").textContent = "確認を完了してください。完了するまで返答は生成されません。";
      widgetId = turnstile.render(dialog.querySelector("#trialChallengeWidget"), {
        sitekey: siteKey, action, ...(requestId ? { cData: requestId } : {}),
        theme: "dark", size: "flexible", retry: "never", "response-field": false,
        callback: token => typeof token === "string" && token ? finish(null, token) : finish(failure("TURNSTILE_FAILED")),
        "error-callback": () => { finish(failure("TURNSTILE_FAILED")); return true; },
        "expired-callback": () => finish(failure("TURNSTILE_EXPIRED")),
        "timeout-callback": () => finish(failure("TURNSTILE_TIMEOUT")),
      });
    }).catch(error => finish(error));
  });
}
