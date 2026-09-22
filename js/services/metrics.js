import { philosophers } from "../data/philosophers.js";

// Local diagnostics only. No network request, persistent identifier or storage.
// A future consent-reviewed collector can listen to this fixed-schema event.
const events = new Set([
  "takeaway_open", "takeaway_copy_success", "takeaway_manual_copy", "takeaway_chatgpt_open"
]);
const sources = new Set(["hero", "card", "chat", "limit", "budget", "account"]);
const personaIds = new Set(philosophers.map(({ id }) => id));
const counts = new Map();

export function normalizeEvent(eventName, attributes = {}) {
  if (!events.has(eventName) || !attributes || typeof attributes !== "object") return null;
  const { philosopherId, source } = attributes;
  if (!personaIds.has(philosopherId) || !sources.has(source)) return null;
  // Deliberately never spread caller data: text, user IDs, URLs and emails are forbidden.
  return Object.freeze({ eventName, philosopherId, source });
}

export function trackEvent(eventName, attributes) {
  const event = normalizeEvent(eventName, attributes);
  if (!event) return;
  const key = `${event.eventName}:${event.philosopherId}:${event.source}`;
  const previous = counts.get(key);
  counts.set(key, { ...event, count: Math.min((previous?.count ?? 0) + 1, 1_000_000) });
  try {
    if (typeof window !== "undefined" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("dialogos:takeaway", { detail: event }));
    }
  } catch { /* Diagnostics must never prevent copying a persona. */ }
}

export function getTakeawayMetrics() {
  return [...counts.values()].map((entry) => ({ ...entry }));
}
