import { philosophers } from "../data/philosophers.js";

export const SHARE_TITLE = "Dialogos — 14人の賢者と、あなたの問いを。";
export const SHARE_DESCRIPTION = "Googleログイン不要で哲学対話を試せます。無料枠は全14人で1日合計3往復、日本時間0時更新。人格は試す前でも無料・無制限で持ち帰れます。受付には利用確認・予算上限があります。";
export const SHARE_IMAGE_PATH = "assets/share/dialogos-card.jpg";
export const SHARE_IMAGE_ALT = "Dialogos。14人の賢者と、あなたの問いを。ログイン不要で試せる哲学対話。人格を無料で持ち帰れます。";
const ids = new Set(philosophers.map(sage => sage.id));

// Public sharing never uses the address bar, auth return, conversation or user text.
// APP_URL is a site origin, not an arbitrary redirect URL or a route.
export function normalizePublicAppUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\u007f\\]/.test(value.trim())) return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") return "";
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(host)) return "";
    if (/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host)) return "";
    return url.origin + "/";
  } catch { return ""; }
}

export function parseSharedSage(search = "") {
  const values = new URLSearchParams(search).getAll("sage");
  return values.length === 1 && ids.has(values[0]) ? values[0] : null;
}

export function buildShareUrl({ canonicalUrl, philosopherId } = {}) {
  const canonical = normalizePublicAppUrl(canonicalUrl);
  if (!canonical || (philosopherId != null && !ids.has(philosopherId))) return "";
  const url = new URL(canonical);
  if (philosopherId) url.searchParams.set("sage", philosopherId);
  return url.href;
}

export function buildXIntent({ canonicalUrl, philosopherId } = {}) {
  const publicUrl = buildShareUrl({ canonicalUrl, philosopherId });
  if (!publicUrl) return "";
  const sage = philosophers.find(item => item.id === philosopherId);
  const text = sage ? `${sage.name}の思想に着想を得たAIと、少し話してみませんか。Dialogos。人格は無料で持ち帰れます。`
    : "14人の賢者の思想に着想を得たAIと、あなたの問いを。Dialogos。人格は無料で持ち帰れます。";
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  intent.searchParams.set("url", publicUrl);
  return intent.href;
}
