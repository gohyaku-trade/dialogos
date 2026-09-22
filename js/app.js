import { philosophers, getPhilosopherById } from "./data/philosophers.js";
import { apiService } from "./services/apiService.js";
import { initAuth, signInWithGoogle, signOut, onAuthStateChange } from "./auth.js";
import { openTakeawayDialog } from "./ui/takeawayDialog.js";
import { requestTurnstileToken, cancelTurnstile } from "./services/turnstileService.js";
import { buildShareUrl, buildXIntent, parseSharedSage } from "./services/shareService.js";

// ── 状態 ──────────────────────────────────────────────────────────────────────
const app        = document.querySelector("#app");
const usageMeter = document.querySelector("#usageMeter");

// LINEなどのアプリ内ブラウザはChrome/SafariとlocalStorageを共有しないためGoogleログイン不可
const IN_APP_BROWSER = isInAppBrowser();
const MAX_MESSAGE_CHARS = 1000;
const PENDING_CHAT_KEY = "dialogos.v3.pendingChat";
const PUBLIC_ROUTES = ["list", "chat", "profile", "history"];

const state = {
  route: "list",
  philosopherId: "socrates",
  conversationId: null,
  user: null,
  history: [],
  loading: false,
  activeRequestId: null,
  trial: { enabled: false },
  configLoaded: false,
  anonymousEnabled: false,
  turnstileSiteKey: "",
  guestStarting: false,
  identityEpoch: 0,
  identityRefresh: 0,
  visibleMessages: [],
  trialRefreshTimer: null,
  pendingChat: null,
  messagesLoading: false,
};

boot();

// ── アプリ内ブラウザ検知 ──────────────────────────────────────────────────────
function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /Line\//i.test(ua)           // LINE
    || /Instagram/i.test(ua)          // Instagram
    || /FBAN|FBAV/i.test(ua)          // Facebook
    || /TwitterAndroid/i.test(ua)     // X(Twitter)
    || /MicroMessenger/i.test(ua);    // WeChat
}

function showInAppWarning() {
  const overlay = document.getElementById("inAppOverlay");
  if (overlay) overlay.style.display = "flex";

  document.getElementById("inappCopyBtn")?.addEventListener("click", () => {
    const url = buildShareUrl({ canonicalUrl: publicCanonical(), philosopherId: state.philosopherId }) || window.location.origin + "/";
    const result = document.getElementById("inappCopyResult");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        if (result) { result.textContent = "コピーしました！ SafariまたはChromeに貼り付けてください。"; }
      }).catch(() => {
        if (result) { result.textContent = url; }
      });
    } else {
      if (result) { result.textContent = url; }
    }
  });

  // 「閉じる」ボタンで警告を閉じてアプリを表示できるようにする
  document.getElementById("inappCloseBtn")?.addEventListener("click", () => {
    if (overlay) overlay.style.display = "none";
  });
}

// ── ブート ─────────────────────────────────────────────────────────────────────
async function boot() {
  // Copying a persona needs no login, including inside social-app browsers.
  const entryParams = new URLSearchParams(window.location.search);
  const sharedSage = parseSharedSage(window.location.search);
  if (sharedSage && !entryParams.has("checkout") && !entryParams.has("payment") &&
    !["purchase", "subscription", "cancel"].includes(entryParams.get("route"))) {
    state.philosopherId = sharedSage;
    state.route = "chat";
  }
  bindEvents();
  renderAuthNav();
  render();
  const configPromise = loadConfig().then(() => {
    updateUsageMeter();
    if (state.route !== "chat" || !hasReplyIdentity()) render();
    else updateChatAccess();
  });
  await initAuth();
  await refreshUser();
  renderAuthNav();
  // Auth callbacks must return before requesting another session from the SDK.
  onAuthStateChange((event) => {
    if (!["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION", "SIGNED_OUT"].includes(event)) return;
    setTimeout(async () => {
      const previousUserId = state.user?.id;
      await refreshUser({ account: true });
      renderAuthNav();
      if (event === "SIGNED_OUT" || previousUserId !== state.user?.id || state.route !== "chat") render();
    }, 0);
  }).catch(() => {});
  await configPromise;

  const params = new URLSearchParams(window.location.search);
  // Old payment links no longer enter a sales screen or synchronize a purchase.
  try { sessionStorage.removeItem("dialogos.pendingSession"); } catch {}
  const legacyEntry = params.has("checkout") || params.has("payment") ||
    ["purchase", "subscription", "cancel"].includes(params.get("route"));
  if (legacyEntry) {
    state.route = "list";
    state.conversationId = null;
    history.replaceState({}, "", window.location.pathname);
  } else if (sharedSage) {
    state.route = "chat";
    state.philosopherId = sharedSage;
    state.conversationId = null;
    history.replaceState({}, "", window.location.pathname + "?sage=" + encodeURIComponent(sharedSage));
  } else if (params.has("route")) {
    state.route = PUBLIC_ROUTES.includes(params.get("route")) ? params.get("route") : "list";
    history.replaceState({}, "", window.location.pathname);
  } else if (state.user?.logged_in) {
    try {
      const returnTo = JSON.parse(sessionStorage.getItem("dialogos.v3.returnTo") || "null");
      sessionStorage.removeItem("dialogos.v3.returnTo");
      if (returnTo && PUBLIC_ROUTES.includes(returnTo.route)) {
        state.route = returnTo.route;
        if (philosophers.some(sage => sage.id === returnTo.philosopherId)) state.philosopherId = returnTo.philosopherId;
        state.conversationId = returnTo.conversationId || null;
      }
    } catch {}
  }

  render();
}

async function loadConfig() {
  try {
    const { trial, anonymousEnabled, turnstileSiteKey } = await apiService.getConfig();
    state.trial = { enabled: trial?.enabled === true && trial.allPhilosophers === true &&
      trial.dailyReplies === 3 && trial.resetTimezone === "Asia/Tokyo" && trial.requiresGoogle === false };
    state.turnstileSiteKey = typeof turnstileSiteKey === "string" ? turnstileSiteKey.trim() : "";
    state.anonymousEnabled = anonymousEnabled === true && !!state.turnstileSiteKey && state.trial.enabled;
  } catch {
    state.trial = { enabled: false };
    state.anonymousEnabled = false;
  } finally {
    state.configLoaded = true;
  }
}

function trialRemaining() {
  if (!hasReplyIdentity() || state.user.trial_eligible !== true) return 0;
  return Math.max(0, Math.min(3, Math.floor(Number(state.user.trial_remaining) || 0)));
}

function canUseTrial(philosopherId = state.philosopherId) {
  return state.trial.enabled && (!state.user?.is_guest || state.anonymousEnabled) && philosophers.some(sage => sage.id === philosopherId) && trialRemaining() > 0;
}

function hasReplyIdentity() { return !!(state.user?.logged_in || state.user?.is_guest); }
function identityKey(user = state.user) { return user?.id ? `${user.is_guest ? "guest" : "account"}:${user.id}` : ""; }

function canStartReply(philosopherId = state.philosopherId) {
  return canUseTrial(philosopherId);
}

function renderTrialOffer() {
  if (!state.trial.enabled || (!state.user?.logged_in && !state.anonymousEnabled)) return `<p class="composer-note">${state.configLoaded ? "サイト内のお試し対話は現在休止中です。" : "サイト内のお試し対話の受付状況を確認中です。"}人格の持ち帰りは、いつでも無料で利用できます。</p>`;
  const identified = hasReplyIdentity();
  if (identified && state.user.trial_eligible !== true) {
    return `<div class="trial-offer"><p>このアカウントでは無料対話を利用できません。人格はログイン状態にかかわらず無料で持ち帰れます。</p></div>`;
  }
  if (identified && trialRemaining() === 0) {
    return `<div class="trial-offer trial-offer--complete"><p>${Number(state.user.trial_reserved) > 0 ? "無料対話の返答を確認中です。" : "今日の無料対話3往復は終了しました。日本時間0時に更新されます。"}</p><p>続きは人格を持ち帰り、ご自身のChatGPTでどうぞ。</p></div>`;
  }
  return `<div class="trial-offer"><p class="trial-title">好きな賢者と、${identified ? `今日は残り${trialRemaining()}往復` : "1日3往復"}を無料で。</p>
    <p>全14人で合計3往復。あなたの問いと返答で1往復です。Googleログイン不要。このブラウザの無料枠は日本時間0時に更新。人格は試す前でも持ち帰れます。</p>
    <p class="trial-note">対話の開始・生成時に不正利用対策の確認があります。同じ回線の利用状況や全体の予算上限で、3往復より前に受付を止める場合があります。厳密な「1人」の判定ではありません。</p></div>`;
}

// ── イベントバインド ──────────────────────────────────────────────────────────
function bindEvents() {
  document.body.addEventListener("click", (e) => {
    const takeaway = e.target.closest("[data-takeaway]");
    if (takeaway) {
      const philosopherId = takeaway.dataset.takeaway || state.philosopherId;
      openTakeawayDialog({ philosopherId, source: takeaway.dataset.source || "card",
        messages: state.route === "chat" && philosopherId === state.philosopherId ? state.visibleMessages : [] });
      return;
    }
    if (e.target.closest("[data-login]")) { handleGoogleLogin(); return; }
    const share = e.target.closest("[data-copy-share]");
    if (share) { copyPublicLink(share); return; }
    if (e.target.closest("[data-guest-start]")) { handleGuestStart(); return; }
    const route = e.target.closest("[data-route]");
    if (route) { navigate(route.dataset.route); return; }

    const profile = e.target.closest("[data-profile]");
    if (profile) { navigate("profile", { philosopherId: profile.dataset.profile }); return; }

    const chat = e.target.closest("[data-chat]");
    if (chat) {
      // サイドバーが開いていれば閉じる
      document.getElementById("chatSidebar")?.classList.remove("open");
      document.getElementById("sidebarBackdrop")?.classList.remove("visible");
      navigate("chat", { philosopherId: chat.dataset.chat, conversationId: chat.dataset.conversation || null });
      return;
    }
    const topic = e.target.closest("[data-topic]");
    if (topic) {
      if (state.loading || state.pendingChat) return;
      const input = document.querySelector("#messageInput");
      if (input) { input.value = topic.dataset.topic; input.focus(); }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hasReplyIdentity() && !state.loading) refreshVisibleUsage();
  });
}

// ── ナビゲーション ─────────────────────────────────────────────────────────────
function navigate(route, params = {}) {
  if (state.loading || state.guestStarting) return;
  if (route === "chat" && state.pendingChat) {
    params = { philosopherId: state.pendingChat.philosopherId, conversationId: state.pendingChat.conversationId };
  }
  state.route = PUBLIC_ROUTES.includes(route) ? route : "list";
  if (params.philosopherId) state.philosopherId = params.philosopherId;
  state.conversationId = params.conversationId || null;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── ユーザー更新 ──────────────────────────────────────────────────────────────
async function refreshUser({ account = false } = {}) {
  const previousUserId = identityKey();
  const refreshId = ++state.identityRefresh;
  try {
    const nextUser = !account && state.user?.is_guest ? await apiService.getGuestMe() : await apiService.getMe();
    if (refreshId !== state.identityRefresh) return;
    if (previousUserId !== identityKey(nextUser)) invalidatePrivateView();
    state.user = nextUser;
    scheduleTrialRefresh();
    restorePendingChat();
    usageMeter.hidden = false;
    updateUsageMeter();
    if (state.route === "chat") updateChatAccess();
    if (previousUserId !== identityKey()) { renderAuthNav(); render(); }
  } catch {
    if (refreshId !== state.identityRefresh) return;
    clearTimeout(state.trialRefreshTimer);
    if (previousUserId) invalidatePrivateView();
    state.user = null;
    state.pendingChat = null;
    usageMeter.hidden = true;
    if (previousUserId) { renderAuthNav(); render(); }
  }
}

function invalidatePrivateView() {
  state.identityEpoch++;
  state.identityRefresh++;
  cancelTurnstile();
  const dialog = document.getElementById("takeawayDialog");
  if (dialog?.open) dialog.close();
  dialog?.remove();
  state.visibleMessages = [];
  state.history = [];
  state.messagesLoading = false;
  state.conversationId = null;
  state.pendingChat = null;
  state.activeRequestId = null;
  state.loading = false;
  state.guestStarting = false;
}

function scheduleTrialRefresh() {
  clearTimeout(state.trialRefreshTimer);
  const resetAt = Date.parse(state.user?.trial_resets_at || state.user?.trial_resetsAt || "");
  if (!Number.isFinite(resetAt)) return;
  // The clock schedules a server refresh; it never grants local free credits.
  state.trialRefreshTimer = setTimeout(() => { if (hasReplyIdentity()) refreshVisibleUsage(); },
    trialRefreshDelay(resetAt));
}

function trialRefreshDelay(resetAt, now = Date.now()) {
  // A fast client clock or stale response must not create a one-second poll loop.
  return resetAt <= now ? 300000 : Math.max(1000, Math.min(86401000, resetAt - now + 1000));
}

async function refreshVisibleUsage() {
  await refreshUser();
  if (state.route !== "chat") render();
}

// ── 認証ナビゲーション ────────────────────────────────────────────────────────
function renderAuthNav() {
  const el = document.getElementById("authNav");
  if (!el) return;
  const u = state.user;
  if (u?.logged_in) {
    const initial = (u.display_name || u.email || "?").slice(0, 1).toUpperCase();
    el.innerHTML = `
      <div class="auth-user" id="authUserBtn" role="button" tabindex="0" aria-label="アカウントメニュー">
        ${u.avatar_url
          ? `<img class="auth-avatar" src="${escapeHtml(u.avatar_url)}" alt="" referrerpolicy="no-referrer">`
          : `<span class="auth-avatar auth-avatar-initial">${initial}</span>`
        }
        <span class="auth-email">${escapeHtml(u.email || u.display_name || "ログイン中")}</span>
        <div class="auth-menu" id="authMenu" hidden>
          <button id="switchAccountBtn" class="auth-menu-item">別のアカウントでログイン</button>
          <button id="logoutBtn" class="auth-menu-item">ログアウト</button>
        </div>
      </div>
    `;
    const userBtn = document.getElementById("authUserBtn");
    const menu    = document.getElementById("authMenu");
    userBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", () => { if (menu) menu.hidden = true; }, { once: true });
    document.getElementById("switchAccountBtn")?.addEventListener("click", handleGoogleLogin);
    document.getElementById("logoutBtn")?.addEventListener("click", handleLogout);
  } else if (IN_APP_BROWSER) {
    el.innerHTML = `<button class="auth-login-btn auth-login-btn--inapp" id="inappOpenBtn">ブラウザで開くとログイン可</button>`;
    document.getElementById("inappOpenBtn")?.addEventListener("click", () => {
      const overlay = document.getElementById("inAppOverlay");
      if (overlay) overlay.style.display = "flex";
    });
  } else {
    el.innerHTML = `<button class="auth-login-btn" id="googleLoginBtn">履歴にログイン</button>`;
    document.getElementById("googleLoginBtn")?.addEventListener("click", handleGoogleLogin);
  }
}

async function handleGoogleLogin() {
  if (state.loading) return;
  if (IN_APP_BROWSER) { showInAppWarning(); return; }
  const returnTo = { route: state.route, philosopherId: state.philosopherId, conversationId: state.user?.is_guest ? null : state.conversationId };
  invalidatePrivateView();
  const btn = document.getElementById("googleLoginBtn");
  if (btn) { btn.textContent = "移動中…"; btn.disabled = true; }
  try {
    try { sessionStorage.setItem("dialogos.v3.returnTo", JSON.stringify(returnTo)); } catch {}
    await signInWithGoogle();
    // OAuthリダイレクト後はページが再ロードされるので、ここには戻らない
  } catch (err) {
    if (btn) { btn.textContent = "Googleでログイン"; btn.disabled = false; }
    console.error("[auth] Google login failed:", err.message);
    alert("ログインに失敗しました。しばらく待ってから再試行してください。");
  }
}

async function handleLogout() {
  if (state.loading) return;
  try {
    await signOut();
    invalidatePrivateView();
    state.user = null;
    state.pendingChat = null;
      state.conversationId = null;
    state.route = "list";
    updateUsageMeter();
    renderAuthNav();
    render();
  } catch (err) {
    console.error("[auth] logout failed:", err.message);
  }
}

function updateUsageMeter() {
  const u = state.user;
  usageMeter.hidden = !hasReplyIdentity() || !state.trial.enabled || u.trial_eligible !== true;
  if (!hasReplyIdentity()) return;
  const inner = usageMeter.querySelector(".meter-inner");
  inner.innerHTML = state.trial.enabled && u.trial_eligible === true ? `<span class="meter-trial">今日の無料 <b>${trialRemaining()}</b>/3</span>` : "";
  const summary = document.querySelector(".usage-box");
  if (summary) summary.textContent = usageSummaryText();
  const note = document.getElementById("composerNote");
  if (note) note.textContent = composerNoteText();
}

// ── メインレンダラー ──────────────────────────────────────────────────────────
function render() {
  if (state.route !== "chat") state.visibleMessages = [];
  const sage = getPhilosopherById(state.philosopherId);
  app.className = `view-root theme-${sage.theme} motif-${sage.motif}`;
  ({
    list:         renderList,
    profile:      renderProfile,
    chat:         renderChat,
    history:      renderHistory,
  }[state.route] || renderList)();
}

// ── 賢者一覧 ──────────────────────────────────────────────────────────────────
function renderList() {
  app.innerHTML = `
    <section class="hero-list">
      <p class="eyebrow">14人の哲学者・宗教家</p>
      <h1 class="takeaway-hero-title"><span>賢者を、あなたの</span><span>ChatGPTへ。</span></h1>
      <p>人格を選んでコピー。新しいチャットに貼り付けるだけ。<br>全14人、ログイン不要・何度でも無料で持ち帰れます。</p>
      <div class="hero-actions"><button class="primary-button" data-takeaway="socrates" data-source="hero">人格を無料で持ち帰る</button><a class="secondary-button" href="#sageGrid">賢者を選んで試す ↓</a></div>
      ${renderShareActions()}
      <p class="composer-note">歴史上の思想に着想を得た創作人格です。ChatGPT側の利用条件・回数制限が適用され、当サイトと同じ返答を保証するものではありません。</p>
      ${renderTrialOffer()}
      ${state.pendingChat ? `<p class="pending-notice">前の問いの返答を確認できます。<button class="secondary-button" data-chat="${escapeHtml(state.pendingChat.philosopherId)}">対話に戻る</button></p>` : ""}
      <details class="dialogue-example"><summary>対話の雰囲気を読む</summary>
        <p class="example-caption">AIによる思想シミュレーションの作例です。歴史上の本人の発言ではありません。</p>
        <p><b>あなた</b>　人に認められないと、自分に価値がない気がします。</p>
        <p><b>ソクラテス</b>　あなたをよく知らない人が褒めたときと、よく知る人が批判したとき。自分の価値を確かめる手がかりになるのは、どちらだろう。認められることと、正しく理解されることは、同じだろうか。</p>
      </details>
    </section>
    <section class="sage-grid" id="sageGrid" aria-label="持ち帰る賢者を選ぶ">
      ${philosophers.map((sage, i) => renderSageCard(sage, i)).join("")}
    </section>
  `;
}

function renderSageCard(sage, index = 0) {
  const statusLabel = "人格コピー無料";
  const actionBtn = `<button class="secondary-button" data-chat="${sage.id}">サイトで試す</button>`;

  return `
    <article class="sage-card theme-${sage.theme} motif-${sage.motif}"
             style="animation-delay:${(index * 0.06).toFixed(2)}s">
      <div class="portrait ${sage.allowPortrait ? "" : "symbolic"}"
           data-profile="${sage.id}" role="button" tabindex="0"
           aria-label="${escapeHtml(sage.name)}のプロフィールへ">
        ${renderAvatar(sage, "card", index === 0)}
        <div class="portrait-overlay" aria-hidden="true">
          <span class="portrait-overlay-label">詳しく見る</span>
        </div>
      </div>
      <div class="sage-card-body">
        <div class="card-meta">
          <b>${sage.category}</b>
          <em class="card-status card-status--open">${statusLabel}</em>
        </div>
        <h2>${sage.name}</h2>
        <p class="card-catch">${sage.catch}</p>
        <p class="title">${sage.title}</p>
        <button class="card-chat-btn takeaway-card-button" data-takeaway="${sage.id}" data-source="card">人格を無料で持ち帰る</button>
        <div class="card-actions">
          <button class="secondary-button" data-profile="${sage.id}">詳しく見る</button>
          ${actionBtn}
        </div>
      </div>
    </article>
  `;
}

// ── プロフィール ──────────────────────────────────────────────────────────────
function renderProfile() {
  const sage = getPhilosopherById(state.philosopherId);
  const forChips = sage.suitableFor.replace(/。$/, "").split("、").map(s => s.trim()).filter(Boolean);
  app.innerHTML = `
    <nav class="view-nav" aria-label="パンくずナビ">
      <button class="back-btn" data-route="list">← 賢者一覧</button>
    </nav>
    <section class="profile-view sage-stage">
      <div class="profile-portrait ${sage.allowPortrait ? "" : "symbolic"}">
        ${renderAvatar(sage, "profile")}
      </div>
      <div class="scroll-panel">
        <p class="eyebrow">${sage.category} · ${sage.era}</p>
        <h1>${sage.name}</h1>
        <div class="profile-quick-action">
          <button class="card-chat-btn profile-chat-btn" data-takeaway="${sage.id}" data-source="card">人格を無料で持ち帰る</button>
        </div>
        <p class="lead">${sage.description}</p>
        ${renderTrialOffer()}

        <div class="worry-section">
          <p class="worry-heading">こんな悩みを抱えている人へ</p>
          <div class="worry-chips">
            ${forChips.map(c => `<span class="worry-chip">${escapeHtml(c)}</span>`).join("")}
          </div>
        </div>

        <dl class="profile-list">
          <div><dt>思想の特徴</dt><dd>${sage.thought}</dd></div>
          <div><dt>この対話で起きること</dt><dd>${sage.catch}</dd></div>
        </dl>
        <button class="secondary-button" data-chat="${sage.id}">サイトでこの賢者を試す</button>
        ${renderShareActions(sage.id)}
      </div>
    </section>
  `;
}

function publicCanonical() { return document.querySelector('link[rel="canonical"]')?.getAttribute?.("href") || ""; }

function renderShareActions(philosopherId = null) {
  const options = { canonicalUrl: publicCanonical(), philosopherId };
  if (!buildShareUrl(options)) return "";
  return `<div class="public-share"><div class="public-share-actions">
    <button type="button" class="secondary-button" data-copy-share="${philosopherId || ""}">${philosopherId ? "この賢者の" : "サイトの"}リンクをコピー</button>
    <a class="secondary-button" href="${escapeHtml(buildXIntent(options))}" target="_blank" rel="noopener noreferrer">Xで紹介する ↗</a>
    </div><p class="composer-note">会話は共有されません。Xでは投稿内容を確認してから、ご自身で投稿できます。</p>
    <input class="public-share-url" type="text" readonly hidden aria-label="共有用リンク"><p class="public-share-status" role="status"></p></div>`;
}

async function copyPublicLink(button) {
  const url = buildShareUrl({ canonicalUrl: publicCanonical(), philosopherId: button.dataset.copyShare || null });
  if (!url) return;
  const block = button.closest(".public-share");
  const status = block.querySelector(".public-share-status");
  const field = block.querySelector(".public-share-url");
  try {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) throw new Error("MANUAL_COPY");
    await navigator.clipboard.writeText(url);
    status.textContent = "共有用リンクをコピーしました。会話やログイン情報は含みません。";
  } catch {
    field.value = url;
    field.hidden = false;
    field.focus();
    field.select();
    status.textContent = "自動コピーできませんでした。選択したリンクを手動でコピーしてください。";
  }
}

// ── チャット ──────────────────────────────────────────────────────────────────
function renderLoginGate(title = "ログインして対話を始める") {
  state.visibleMessages = [];
  app.innerHTML = `<section class="purchase-view scroll-panel login-gate">
    <p class="eyebrow">Dialogos</p><h1>${escapeHtml(title)}</h1>
    <p class="lead">人格の持ち帰りと匿名のお試しにGoogleログインはいりません。<br>Googleアカウントに保存した対話の履歴を見る場合だけ、ログインが必要です。</p>
    <button class="primary-button" data-takeaway="${state.philosopherId}" data-source="account">人格を無料で持ち帰る</button>
    ${renderTrialOffer()}
    <button class="secondary-button" data-login>Googleでログインして履歴を見る</button>
    <p class="composer-note">お試しと人格の持ち帰りは無料です。</p>
  </section>`;
}

function renderGuestGate(message = "") {
  state.visibleMessages = [];
  const sage = getPhilosopherById(state.philosopherId);
  app.innerHTML = `<section class="purchase-view scroll-panel login-gate">
    <p class="eyebrow">Free dialogue</p><h1>${escapeHtml(sage.name)}と、少し話してみる</h1>
    <button class="primary-button" data-takeaway="${sage.id}" data-source="account">人格を無料で持ち帰る</button>
    ${renderTrialOffer()}
    <button class="secondary-button" data-guest-start ${state.anonymousEnabled ? "" : "disabled"}>ログインせずに試す</button>
    <p id="guestStartStatus" role="status">${escapeHtml(message)}</p>
    <p class="composer-note">匿名の無料枠にはCookieを使います。匿名の会話をGoogleアカウントの履歴に移すことはありません。持ち帰りのコピーには利用確認はいりません。</p>
  </section>`;
}

async function handleGuestStart() {
  if (state.loading || state.guestStarting || !state.anonymousEnabled || state.user?.logged_in) return;
  state.guestStarting = true;
  const epoch = state.identityEpoch;
  const status = document.getElementById("guestStartStatus");
  if (status) status.textContent = "このブラウザの無料枠を確認しています…";
  app.querySelectorAll("[data-guest-start]").forEach(button => { button.disabled = true; });
  try {
    let guest;
    try { guest = await apiService.getGuestMe(); }
    catch (error) {
      if (error.code !== "GUEST_SESSION_REQUIRED" || error.status !== 401) throw error;
      if (epoch !== state.identityEpoch) return;
      const token = await requestTurnstileToken({ siteKey: state.turnstileSiteKey, action: "guest_session" });
      if (epoch !== state.identityEpoch) return;
      guest = await apiService.startGuestSession(token);
    }
    if (epoch !== state.identityEpoch) return;
    if (!guest?.is_guest || guest.logged_in || typeof guest.id !== "string") throw new Error("INVALID_GUEST");
    invalidatePrivateView();
    state.user = guest;
    restorePendingChat();
    scheduleTrialRefresh();
    updateUsageMeter();
    renderAuthNav();
    renderChat();
  } catch (error) {
    if (epoch !== state.identityEpoch) return;
    if (status) status.textContent = error.code === "TURNSTILE_CANCELLED"
      ? "利用確認を取りやめました。返答は生成していません。人格は無料で持ち帰れます。"
      : "今はお試し対話を始められません。利用確認・Cookieの許可を確認し、時間をおいてお試しください。人格の持ち帰りは利用できます。";
  } finally {
    if (epoch === state.identityEpoch) {
      state.guestStarting = false;
      app.querySelectorAll("[data-guest-start]").forEach(button => { button.disabled = !state.anonymousEnabled; });
    }
  }
}

function restorePendingChat() {
  if (discardUnsupportedPendingChat()) return;
  if (state.pendingChat && state.pendingChat.ownerId === state.user?.id && (state.pendingChat.ownerKind === "guest") === !!state.user?.is_guest) return;
  state.pendingChat = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_CHAT_KEY) || "null");
    if (saved && saved.expectChargeSource !== "trial") {
      sessionStorage.removeItem(PENDING_CHAT_KEY);
      return;
    }
    if (saved?.ownerId === state.user?.id && (saved.ownerKind === "guest") === !!state.user?.is_guest && typeof saved.requestId === "string" &&
      typeof saved.message === "string" && philosophers.some(sage => sage.id === saved.philosopherId)) {
      state.pendingChat = saved;
    }
  } catch {}
}

function discardUnsupportedPendingChat() {
  // Do not replay old paid/ambiguous requests, or relabel them as free.
  if (!state.pendingChat || state.pendingChat.expectChargeSource === "trial") return false;
  state.pendingChat = null;
  savePendingChat();
  return true;
}

function savePendingChat() {
  try {
    if (state.pendingChat) sessionStorage.setItem(PENDING_CHAT_KEY, JSON.stringify(state.pendingChat));
    else sessionStorage.removeItem(PENDING_CHAT_KEY);
  } catch {}
}

function showChatStatus(message, { retry = false, login = false, takeaway = false } = {}) {
  const status = document.getElementById("chatStatus");
  if (!status) return;
  status.hidden = !message;
  status.innerHTML = `<p>${escapeHtml(message)}</p>${retry ? `<button type="button" id="retryChatBtn" class="secondary-button">同じ問いの返答を確認</button>` : ""}${login ? `<button type="button" data-login class="secondary-button">Googleでログイン</button>` : ""}${takeaway ? `<button type="button" class="primary-button" data-takeaway="${state.philosopherId}" data-source="budget">人格を無料で持ち帰る</button>` : ""}`;
  document.getElementById("retryChatBtn")?.addEventListener("click", handleSend);
}

function renderChat() {
  state.visibleMessages = [];
  if (!hasReplyIdentity()) { renderGuestGate(); return; }
  if (state.pendingChat) {
    state.philosopherId = state.pendingChat.philosopherId;
    state.conversationId = state.pendingChat.conversationId;
  }
  const sage = getPhilosopherById(state.philosopherId);
  const isContinuing = !!state.conversationId && !state.user?.is_guest;

  app.innerHTML = `
    <div class="chat-wrapper sage-stage">
      <header class="solo-header">
        <div class="bust-container ${sage.allowPortrait ? "" : "symbolic"}">
          ${renderAvatar(sage, "bust")}
        </div>
        <h1>${sage.displayName || sage.name}</h1>
        <div class="subtitle">${sage.subtitle}</div>
        <div class="divider"><span></span><i></i><span></span></div>
        <div class="usage-box">${usageSummaryText()}</div>
        <button class="primary-button chat-takeaway-button" data-takeaway="${sage.id}" data-source="chat">人格を無料で持ち帰る</button>
        <p class="composer-note">ご自身のChatGPTで続きを。会話を含めるかは、コピー前に選べます。</p>
      </header>

      <div class="chat-body">
        <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
        <aside class="chat-sidebar" id="chatSidebar">
          <div class="sidebar-inner">
            <div class="sidebar-header-row">
              <button class="sidebar-new-btn" id="sidebarNewBtn">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>
                新しい対話
              </button>
              <button class="sidebar-close-btn" id="sidebarCloseBtn" aria-label="サイドバーを閉じる">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 5L5 15M5 5l10 10"/></svg>
              </button>
            </div>
            <div class="sidebar-section-label">履歴</div>
            <div class="sidebar-history-list" id="sidebarHistoryList">
              <div class="sidebar-loading-text">読み込み中…</div>
            </div>
          </div>
        </aside>

        <div class="chat-main">
          <button class="sidebar-toggle-btn" id="sidebarToggleBtn" aria-label="履歴を開く">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 5h14M3 10h14M3 15h14"/>
            </svg>
          </button>

          <div class="scroll-container">
            <div class="scroll-cap"></div>
            <div id="chatArea" class="chat-area">
              ${isContinuing
                ? `<div class="welcome"><div class="welcome-quote" style="font-size:15px;opacity:0.7">問いの続き——</div></div>`
                : `<div class="welcome"><div class="welcome-quote">${sage.welcomeQuote}</div><div class="welcome-attr">— ${sage.welcomeAttr} —</div></div>`
              }
            </div>
            <div class="scroll-cap bottom"></div>
          </div>

          <form id="composer" class="input-section">
            <div class="input-row">
              <label class="input-wrapper">
                <span>あなたの問い — Your Question</span>
                <textarea id="messageInput" rows="2" placeholder="${sage.name}に問いかけてください" aria-describedby="composerNote"></textarea>
              </label>
              <button class="send-button" type="submit" aria-label="送信">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
            <p class="composer-note" id="composerNote">${composerNoteText()}</p>
            <div id="chatAccessNotice" class="chat-access-notice" role="status" hidden></div>
            <div id="chatStatus" class="chat-status" role="status" hidden></div>
            <div class="suggestions">
              <span>テーマを選ぶ — Choose a Theme</span>
              ${sage.themes.map((t) => `<button type="button" data-topic="${escapeHtml(t)}">${t}</button>`).join("")}
            </div>
          </form>
          <section id="dialogueReflection" class="dialogue-reflection" hidden aria-label="対話の整理"></section>
          <footer class="solo-footer">${sage.footer}</footer>
        </div>
      </div>
    </div>
  `;

  document.querySelector("#composer").addEventListener("submit", handleSend);

  const input = document.querySelector("#messageInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.querySelector("#composer").requestSubmit(); }
  });
  input.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 160) + "px";
  });

  const sidebarEl = document.getElementById("chatSidebar");
  const backdropEl = document.getElementById("sidebarBackdrop");

  function openSidebar() {
    sidebarEl.classList.add("open");
    backdropEl.classList.add("visible");
  }
  function closeSidebar() {
    sidebarEl.classList.remove("open");
    backdropEl.classList.remove("visible");
  }

  document.getElementById("sidebarToggleBtn").addEventListener("click", () => {
    sidebarEl.classList.contains("open") ? closeSidebar() : openSidebar();
  });

  document.getElementById("sidebarCloseBtn").addEventListener("click", closeSidebar);
  backdropEl.addEventListener("click", closeSidebar);

  document.getElementById("sidebarNewBtn").addEventListener("click", () => {
    if (state.loading || state.pendingChat) {
      showChatStatus("前の問いの返答を確認してから、新しい対話を始められます。", { retry: !!state.pendingChat && !state.loading });
      return;
    }
    state.conversationId = null;
    closeSidebar();
    renderChat();
  });

  loadSidebarHistory();

  if (isContinuing) {
    loadExistingMessages(sage);
  }
  if (state.pendingChat) {
    input.value = state.pendingChat.message;
    input.readOnly = true;
    if (!isContinuing) appendMessage("user", "あなた", state.pendingChat.message, null, state.pendingChat.requestId);
    showChatStatus("前の問いの返答を確認できます。確認のために新しい問いを送信する必要はありません。", { retry: true });
  }
  updateChatAccess();
}

function composerNoteText() {
  const cost = canUseTrial() ? `今日の無料対話：全賢者で残り${trialRemaining()}往復。日本時間0時更新。`
    : !state.trial.enabled
      ? "無料対話は受付を休止しています。人格の持ち帰りは利用できます。"
      : "サイト内の対話は受付終了です。人格を無料で持ち帰って続けられます。";
  return `${cost}1回の入力は${MAX_MESSAGE_CHARS.toLocaleString()}文字まで。Enterで送信／Shift + Enterで改行。`;
}

function updateChatAccess() {
  const input = document.getElementById("messageInput");
  const button = document.querySelector(".send-button");
  const notice = document.getElementById("chatAccessNotice");
  const blocked = !state.pendingChat && !canStartReply();
  if (input) input.disabled = state.loading || blocked;
  if (button) button.disabled = state.loading || blocked;
  if (!notice) return;
  notice.hidden = !blocked;
  if (!blocked) { notice.innerHTML = ""; return; }
  const exhausted = state.trial.enabled && state.user?.trial_eligible === true && trialRemaining() === 0;
  const trialPaused = !state.trial.enabled;
  const message = trialPaused
    ? "サイト内の無料対話は現在休止中です。人格の持ち帰りはいつでも利用できます。"
    : exhausted
    ? Number(state.user.trial_reserved) > 0 ? "無料対話の返答を確認中です。同じ問いの確認が終わるまでお待ちください。" : "今日の無料対話3往復が終わりました。全賢者で共通の回数です。日本時間0時に更新されます。続きは人格を持ち帰り、ご自身のChatGPTでどうぞ。"
    : "サイト内のお試し対話は今は利用できません。人格はログインせずに無料で持ち帰れます。";
  notice.innerHTML = `<p>${message}</p><button class="primary-button" type="button" data-takeaway="${state.philosopherId}" data-source="limit">人格を無料で持ち帰る</button>`;
}

function sidebarDateLabel(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;
  if (d.getTime() >= todayStart) return "今日";
  if (d.getTime() >= yesterdayStart) return "昨日";
  if (d.getTime() >= weekStart) return "過去7日";
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric" });
}

function formatSidebarTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return d.getTime() >= todayStart
    ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

async function loadSidebarHistory() {
  const list = document.getElementById("sidebarHistoryList");
  if (!list) return;
  if (state.user?.is_guest) { list.innerHTML = '<p class="sidebar-empty">匿名の会話はこの画面で確認できます。再読み込み前に必要な内容をコピーしてください。</p>'; return; }
  const owner = identityKey(), epoch = state.identityEpoch, philosopherId = state.philosopherId;
  const current = () => epoch === state.identityEpoch && owner === identityKey() && philosopherId === state.philosopherId && document.getElementById("sidebarHistoryList") === list;
  try {
    const all = await apiService.getHistory();
    if (!current()) return;
    state.history = all;
    const filtered = all.filter((h) => h.philosopher_id === state.philosopherId);

    if (!filtered.length) {
      list.innerHTML = `<p class="sidebar-empty">まだ記録はありません</p>`;
      return;
    }

    // 日付グループに分類
    const groups = {};
    filtered.forEach((item) => {
      const label = sidebarDateLabel(item.updated_at);
      if (!groups[label]) groups[label] = [];
      groups[label].push(item);
    });

    list.innerHTML = Object.entries(groups).map(([label, items]) => `
      <div class="sidebar-date-group">${label}</div>
      ${items.map((item) => {
        const isActive = item.id === state.conversationId;
        const excerpt  = escapeHtml((item.last_message || "新しい対話").slice(0, 40));
        const time     = formatSidebarTime(item.updated_at);
        return `
          <button class="sidebar-conv-item${isActive ? " active" : ""}"
                  data-chat="${state.philosopherId}" data-conversation="${item.id}">
            <span class="sidebar-conv-excerpt">${excerpt}</span>
            <span class="sidebar-conv-date">${time}</span>
          </button>
        `;
      }).join("")}
    `).join("");
  } catch {
    if (!current()) return;
    list.innerHTML = `<p class="sidebar-empty">読み込みに失敗</p>`;
  }
}

async function loadExistingMessages(sage) {
  if (!state.conversationId || state.user?.is_guest) return;
  const conversationId = state.conversationId;
  const owner = identityKey(), epoch = state.identityEpoch;
  const target = document.querySelector("#chatArea");
  const current = () => epoch === state.identityEpoch && owner === identityKey() && document.querySelector("#chatArea") === target && state.conversationId === conversationId;
  state.messagesLoading = true;
  try {
    const data = await apiService.getConversationMessages(conversationId);
    if (!current()) return;
    const messages = Array.isArray(data) ? data : data.messages || [];
    const chatArea = document.querySelector("#chatArea");
    if (!chatArea || chatArea !== target || state.conversationId !== conversationId || !messages.length) return;
    chatArea.querySelector(".welcome")?.remove();
    messages.forEach(({ role, content, request_id }) => {
      if (role !== "user" && role !== "assistant") return;
      const msgRole = role === "assistant" ? "sage" : "user";
      const label   = role === "assistant" ? (sage.displayName || sage.name) : "あなた";
      const portrait = role === "assistant" ? (sage.portraitIcon || sage.portrait) : null;
      appendMessage(msgRole, label, String(content ?? ""), portrait, request_id);
    });
    renderReflection(data.conversation?.dialogue_state);
  } catch {
    if (current()) showChatStatus("対話の記録を読み込めませんでした。画面を開き直すと、もう一度確認できます。");
  } finally {
    if (!current()) return;
    state.messagesLoading = false;
    if (document.querySelector("#chatArea") === target && state.pendingChat?.conversationId === conversationId) {
      appendMessage("user", "あなた", state.pendingChat.message, null, state.pendingChat.requestId);
    }
  }
}

function usageSummaryText() {
  const u = state.user;
  if (!hasReplyIdentity()) return "ログイン不要のお試し対話";
  const trial = state.trial.enabled && u.trial_eligible === true ? `今日の無料 残り${trialRemaining()}/3往復 · 全賢者共通・日本時間0時更新${Number(u.trial_reserved) > 0 ? `（確認中${Number(u.trial_reserved)}往復）` : ""}` : "サイト内の無料対話は現在休止中";
  return trial;
}

// ── チャット送信 ──────────────────────────────────────────────────────────────
async function handleSend(e) {
  e.preventDefault();
  if (state.loading || state.messagesLoading || state.guestStarting) return;
  if (!hasReplyIdentity()) { renderGuestGate(); return; }
  const input = document.querySelector("#messageInput");
  const sendBtn = document.querySelector(".send-button");
  if (discardUnsupportedPendingChat()) {
    if (input) input.readOnly = false;
    showChatStatus("この画面では確認できない送信データです。自動で再送はしません。必要なら履歴をご確認ください。", { takeaway: true });
    updateChatAccess();
    return;
  }
  const text = state.pendingChat?.message || input.value.trim();
  if (!text) return;
  if ([...text].length > MAX_MESSAGE_CHARS) {
    showChatStatus(`問いを${MAX_MESSAGE_CHARS.toLocaleString()}文字以内にしてください。長いお話は分けて続けられます。`);
    return;
  }
  if (!state.pendingChat && !canStartReply()) { updateChatAccess(); return; }

  const sage = getPhilosopherById(state.philosopherId);
  const guest = state.user.is_guest === true;
  const request = state.pendingChat || { requestId: crypto.randomUUID(), ownerId: state.user.id,
    ownerKind: guest ? "guest" : "account", philosopherId: state.philosopherId,
    conversationId: state.conversationId, message: text, expectChargeSource: "trial" };
  const epoch = state.identityEpoch;
  const needsProof = guest && (!state.pendingChat || state.pendingChat.needsProof === true);
  state.activeRequestId = request.requestId;
  const isCurrentRequest = () => state.identityEpoch === epoch && state.user?.id === request.ownerId &&
    !!state.user?.is_guest === guest && state.activeRequestId === request.requestId;
  state.loading = true;
  input.value = text;
  input.readOnly = true;
  if (sendBtn) sendBtn.disabled = true;
  showChatStatus(needsProof ? "利用確認が完了するまで、返答は生成されません。" : "");

  try {
    let turnstileToken;
    if (needsProof) {
      if (!state.anonymousEnabled) throw Object.assign(new Error(), { code: "GUEST_NOT_READY" });
      turnstileToken = await requestTurnstileToken({ siteKey: state.turnstileSiteKey, action: "guest_chat", requestId: request.requestId });
      if (!isCurrentRequest()) return;
    }
    state.pendingChat = { ...request };
    delete state.pendingChat.needsProof;
    savePendingChat(); // Deliberately excludes the one-use proof.
    appendMessage("user", "あなた", text, null, request.requestId);
    showThinking(sage);
    const result = guest
      ? await apiService.sendGuestChat({ ...request, turnstileToken })
      : await apiService.sendChat(request);
    if (!isCurrentRequest()) return;
    if (!result.reply || typeof result.reply !== "string" || (result.user && identityKey(result.user) !== identityKey())) {
      throw Object.assign(new Error("応答を確認中です。"), { code: "REQUEST_PENDING" });
    }
    state.conversationId = result.conversationId;
    hideThinking();
    appendMessage("sage", sage.displayName || sage.name, result.reply, sage.portraitIcon || sage.portrait, request.requestId);
    state.pendingChat = null;
    savePendingChat();
    input.value = "";
    input.style.height = "auto";
    if (result.user) state.user = result.user;
    scheduleTrialRefresh();
    updateUsageMeter();
    renderReflection(result.state);
    loadSidebarHistory();
    showChatStatus("");
  } catch (err) {
    if (!isCurrentRequest()) return;
    hideThinking();
    const proofErrors = ["TURNSTILE_REQUIRED", "TURNSTILE_FAILED", "TURNSTILE_UNAVAILABLE", "TURNSTILE_LOAD_FAILED",
      "TURNSTILE_NOT_CONFIGURED", "TURNSTILE_CANCELLED", "TURNSTILE_EXPIRED", "TURNSTILE_TIMEOUT"];
    if (guest && proofErrors.includes(err.code)) {
      if (state.pendingChat) { state.pendingChat.needsProof = true; savePendingChat(); }
      showChatStatus(err.code === "TURNSTILE_CANCELLED"
        ? "利用確認を取りやめました。新しい返答は生成していません。"
        : "利用確認を完了できませんでした。この操作では新しい返答・回数の消費はありません。再操作で確認できます。",
        { retry: !!state.pendingChat, takeaway: true });
    } else if (guest && err.status === 401) {
      state.pendingChat = null;
      savePendingChat();
      invalidatePrivateView();
      state.user = null;
      updateUsageMeter();
      renderGuestGate("匿名の利用状態を確認できませんでした。Cookieを許可してお試しを開始してください。前の問い合わせを別の利用状態へ自動送信することはありません。");
    } else {
      const refused = ["LOCKED", "BALANCE_CHANGED", "BUDGET_EXHAUSTED", "TRIAL_BUDGET_EXHAUSTED", "TRIAL_NOT_READY",
        "IN_FLIGHT", "RATE_LIMIT", "RATE_LIMITED", "NETWORK_RATE_LIMITED", "INVALID_MESSAGE", "MESSAGE_TOO_LONG",
        "GENERATION_FAILED", "TOKEN_COUNT_UNAVAILABLE", "AI_NOT_CONFIGURED", "AUTH_NOT_CONFIGURED", "BILLING_NOT_READY",
        "MIGRATION_REQUIRED", "DB_NOT_CONFIGURED", "CONVERSATION_NOT_FOUND", "GUEST_NOT_READY", "GUEST_ORIGIN_REJECTED", "GUEST_NETWORK_UNAVAILABLE"];
      if (refused.includes(err.code) || (err.status === 400 && err.code !== "REQUEST_CONFLICT")) {
        state.pendingChat = null;
        savePendingChat();
        showChatStatus(err.code === "BALANCE_CHANGED"
          ? "無料対話の残り回数が変わりました。この問いの回数は消費していません。残り回数を確認してから、改めて送信してください。"
          : err.code === "GENERATION_FAILED"
            ? "返答を作成できませんでした。この問いの無料回数は消費されていません。内容を確認して、もう一度送信できます。"
          : err.code === "TRIAL_BUDGET_EXHAUSTED"
            ? "無料体験の受付上限に達しています。無料回数は消費されていません。時間をおいてお試しください。"
          : err.code === "NETWORK_RATE_LIMITED"
            ? "この回線からの利用上限に達しています。無料回数は消費されていません。時間をおいてお試しください。人格のコピーは利用できます。"
          : ["BUDGET_EXHAUSTED", "TRIAL_NOT_READY", "AI_NOT_CONFIGURED", "AUTH_NOT_CONFIGURED", "BILLING_NOT_READY",
            "MIGRATION_REQUIRED", "DB_NOT_CONFIGURED", "GUEST_NOT_READY", "GUEST_NETWORK_UNAVAILABLE"].includes(err.code)
            ? "ただいま対話の受付を休止しています。無料回数は消費されていません。人格の持ち帰りは利用できます。"
            : "この問いは受け付けられませんでした。無料回数は消費されていません。残り回数と入力内容を確認し、時間をおいてお試しください。", { takeaway: true });
        await refreshUser();
      } else if (err.status === 401) {
        showChatStatus("ログイン状態を確認してください。再ログイン後、同じ問いの返答を確認できます。", { login: true });
      } else {
        showChatStatus(err.code === "REQUEST_UNKNOWN"
          ? "返答の結果を確認できていません。この問いの利用回数は確認のため保留されています。同じ問いの状況を確認できます。"
          : "返答を確認中です。少し待ってから同じ問いの返答を確認してください。新しい問いとしては送信しません。", { retry: true });
      }
    }
  } finally {
    if (!isCurrentRequest()) return;
    state.activeRequestId = null;
    state.loading = false;
    input.readOnly = !!state.pendingChat;
    input.focus();
    updateChatAccess();
  }
}

function renderReflection(dialogueState) {
  const panel = document.getElementById("dialogueReflection");
  if (!panel || !dialogueState || typeof dialogueState !== "object") return;
  const textList = value => Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 3).join("／") : "";
  const revisions = Array.isArray(dialogueState.revisions) ? dialogueState.revisions
    .filter(item => typeof item?.from === "string" && typeof item?.to === "string")
    .slice(0, 2).map(item => `${item.from} → ${item.to}`).join("／") : "";
  const fields = [["確かめた言葉", textList(dialogueState.definitions)], ["いまの考え", textList(dialogueState.claims)],
    ["考え直した点", revisions], ["残っている問い", textList(dialogueState.openQuestions)]].filter(([, value]) => value);
  if (!fields.length) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = `<h2>対話のメモ</h2><p class="composer-note">AIによる整理です。違うと感じたところは、次の問いで伝えてください。</p><dl>${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

// ── メッセージ追加 ─────────────────────────────────────────────────────────────
function appendMessage(role, label, text, portrait, requestId) {
  const chatArea = document.querySelector("#chatArea");
  if (!chatArea) return;
  if (requestId && [...chatArea.children].some(child => child.dataset?.requestId === requestId && child.dataset?.messageRole === role)) return;
  chatArea.querySelector(".welcome")?.remove();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (requestId) {
    div.dataset.requestId = requestId;
    div.dataset.messageRole = role;
  }
  const icon = (role === "sage" && portrait)
    ? `<img class="msg-sage-icon" src="${portrait}" alt="" width="32" height="32" loading="lazy" decoding="async" onerror="this.style.display='none'">`
    : "";
  div.innerHTML = `<div class="message-label">${icon}${escapeHtml(label)}</div><div class="message-bubble">${escapeHtml(text)}</div>`;
  div.style.animation = "fadeIn 0.45s ease forwards";
  chatArea.appendChild(div);
  if (role === "user" || role === "sage") state.visibleMessages.push({ role: role === "sage" ? "assistant" : "user", content: String(text) });
  chatArea.scrollTop = chatArea.scrollHeight;
}

function showThinking(sage) {
  const chatArea = document.querySelector("#chatArea");
  if (!chatArea) return;
  const div      = document.createElement("div");
  div.id         = "thinking";
  div.className  = "thinking";
  div.innerHTML  = `
    <img class="msg-sage-icon" src="${sage.portraitIcon || sage.portrait}" alt="" width="32" height="32" decoding="async" onerror="this.style.display='none'">
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <em>${escapeHtml(sage.thinkingText)}</em>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function hideThinking() {
  document.querySelector("#thinking")?.remove();
}

// ── ロックオーバーレイ ─────────────────────────────────────────────────────────


// ── 履歴（賢者ごとの最新対話） ────────────────────────────────────────────────
async function renderHistory() {
  if (!state.user?.logged_in) { renderLoginGate("ログインして対話の記録を見る"); return; }
  app.innerHTML = `
    <section class="hero-list">
      <p class="eyebrow">Recent Dialogues</p>
      <h1>賢者との記録</h1>
      <p>それぞれの賢者との、直近の対話。</p>
    </section>
    <section id="historyList" class="history-list"></section>
  `;
  const list = document.querySelector("#historyList");
  const owner = identityKey(), epoch = state.identityEpoch;
  const current = () => epoch === state.identityEpoch && owner === identityKey() && document.querySelector("#historyList") === list;
  try {
    const all = await apiService.getHistory();
    if (!current()) return;
    state.history = all;

    // 賢者ごとに最新1件を抽出
    const latestMap = {};
    all.forEach((item) => {
      if (!latestMap[item.philosopher_id] ||
          item.updated_at > latestMap[item.philosopher_id].updated_at) {
        latestMap[item.philosopher_id] = item;
      }
    });
    const latest = Object.values(latestMap)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    list.innerHTML = latest.length
      ? latest.map(renderHistoryItem).join("")
      : `<div class="empty">まだ対話の記録はありません。</div>`;
  } catch {
    if (!current()) return;
    list.innerHTML = `<div class="empty">記録を読み込めませんでした。</div>`;
  }
}

function renderHistoryItem(item) {
  const sage    = getPhilosopherById(item.philosopher_id);
  const excerpt = (item.last_message || "").slice(0, 90);
  const dateStr = new Date(item.updated_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `
    <article class="history-item theme-${sage.theme}">
      <div class="history-item-inner">
        <img class="history-sage-icon" src="${sage.portraitIcon || sage.portrait}" alt="${escapeHtml(sage.name)}" width="${sage.portraitIconWidth || 128}" height="${sage.portraitIconHeight || 128}" loading="lazy" decoding="async" onerror="this.style.display='none'">
        <div>
          <p class="eyebrow">${dateStr}</p>
          <h2>${sage.name}</h2>
          <p>${escapeHtml(excerpt)}${excerpt.length < (item.last_message || "").length ? "…" : ""}</p>
        </div>
      </div>
      <button class="secondary-button" data-chat="${sage.id}" data-conversation="${item.id}">続きを読む</button>
    </article>
  `;
}

// ── アバターレンダリング ──────────────────────────────────────────────────────
function renderAvatar(sage, size, eager = false) {
  const symbol = sage.allowPortrait ? (sage.displayName || sage.name).slice(0, 2) : "☾";
  const isBust = size === "bust";
  const sizes = size === "profile" ? "(max-width: 700px) 85vw, 420px" : "(max-width: 600px) 94vw, (max-width: 1000px) 45vw, 320px";
  return `
    <img src="${isBust ? (sage.portraitIcon || sage.portrait) : sage.portrait}" ${!isBust && sage.portraitSrcSet ? `srcset="${sage.portraitSrcSet}" sizes="${sizes}"` : ""}
      width="${isBust ? (sage.portraitIconWidth || 128) : (sage.portraitWidth || 320)}" height="${isBust ? (sage.portraitIconHeight || 128) : (sage.portraitHeight || 320)}"
      loading="${eager || size !== "card" ? "eager" : "lazy"}" ${eager ? 'fetchpriority="high"' : ""} decoding="async"
      alt="${sage.allowPortrait ? sage.name : `${sage.name}の象徴表現`}" onerror="this.classList.add('missing')">
    <div class="avatar-symbol avatar-${size}">${symbol}</div>
    <div class="avatar-motif" aria-hidden="true">${motifSvg(sage.motif)}</div>
  `;
}

function motifSvg(motif) {
  const motifs = {
    greek:         `<svg viewBox="0 0 90 90"><rect x="28" y="76" width="34" height="7" rx="1"/><ellipse cx="45" cy="42" rx="18" ry="20"/><path d="M30 52q3 15 15 15t15-15q-7 8-15 8t-15-8z"/><path d="M27 40q-2-12 6-18t24 0q8 6 6 18" fill="none"/></svg>`,
    cave:          `<svg viewBox="0 0 90 90"><path d="M16 72V38q8-22 29-22t29 22v34"/><circle cx="45" cy="36" r="9"/><path d="M22 72h46M35 52h20" fill="none"/></svg>`,
    columns:       `<svg viewBox="0 0 90 90"><path d="M18 24h54M23 32h44M28 32v36M45 32v36M62 32v36M20 70h50" fill="none"/></svg>`,
    stoic:         `<svg viewBox="0 0 90 90"><path d="M45 15l25 12v18c0 17-10 27-25 33-15-6-25-16-25-33V27z" fill="none"/><path d="M32 45h26M45 28v36" fill="none"/></svg>`,
    laurel:        `<svg viewBox="0 0 90 90"><path d="M30 70C16 52 20 28 40 18M60 70c14-18 10-42-10-52" fill="none"/><path d="M34 30l-10-5M32 43l-12-2M36 56l-10 5M56 30l10-5M58 43l12-2M54 56l10 5" fill="none"/></svg>`,
    lightning:     `<svg viewBox="0 0 90 90"><path d="M52 8L24 50h19l-6 32 29-43H48z"/></svg>`,
    "black-sun":   `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="18"/><path d="M45 8v18M45 64v18M8 45h18M64 45h18M19 19l13 13M58 58l13 13M71 19L58 32M32 58L19 71" fill="none"/></svg>`,
    water:         `<svg viewBox="0 0 90 90"><path d="M18 52c12-16 24 16 36 0s24 16 36 0M10 68c12-16 24 16 36 0s24 16 36 0" fill="none"/><path d="M46 10c-10 14-16 24-16 36a16 16 0 0 0 32 0c0-12-6-22-16-36z"/></svg>`,
    jade:          `<svg viewBox="0 0 90 90"><rect x="26" y="18" width="38" height="54" rx="8" fill="none"/><circle cx="45" cy="45" r="12" fill="none"/><path d="M30 30h30M30 60h30" fill="none"/></svg>`,
    butterfly:     `<svg viewBox="0 0 90 90"><path d="M44 44C32 18 12 22 18 44c4 14 16 14 26 0zM46 44c12-26 32-22 26 0-4 14-16 14-26 0zM44 47C32 72 16 68 22 52c4-10 14-9 22-5zM46 47c12 25 28 21 22 5-4-10-14-9-22-5z" fill="none"/></svg>`,
    cosmos:        `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="8"/><ellipse cx="45" cy="45" rx="34" ry="12" fill="none"/><ellipse cx="45" cy="45" rx="12" ry="34" fill="none" transform="rotate(45 45 45)"/></svg>`,
    lotus:         `<svg viewBox="0 0 90 90"><path d="M45 20c14 16 14 30 0 46-14-16-14-30 0-46z"/><path d="M28 35c16 6 23 17 17 31-16-6-23-17-17-31zM62 35c-16 6-23 17-17 31 16-6 23-17 17-31z" fill="none"/></svg>`,
    "desert-light":`<svg viewBox="0 0 90 90"><circle cx="45" cy="32" r="14"/><path d="M10 68c18-14 34-14 52 0 8-7 14-9 24-6" fill="none"/></svg>`,
    geometry:      `<svg viewBox="0 0 90 90"><path d="M45 10l30 18v34L45 80 15 62V28z" fill="none"/><path d="M45 10v70M15 28l60 34M75 28L15 62M30 19l30 52M60 19L30 71" fill="none"/></svg>`,
  };
  return motifs[motif] || motifs.greek;
}

// ── ユーティリティ ─────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
