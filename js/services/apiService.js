import { getAccessToken } from "../auth.js";
import { getPublicConfig } from "./configService.js";

async function request(path, { anonymous = false, ...options } = {}) {
  const token = anonymous ? null : await getAccessToken();
  if (!anonymous && !token) {
    const error = new Error("Googleでログインしてください。");
    error.code = "AUTH_REQUIRED";
    error.status = 401;
    throw error;
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "REQUEST_FAILED");
    error.code = data.code;
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const apiService = {
  getConfig() {
    return getPublicConfig();
  },
  getGuestMe() {
    return request("/api/guest/me", { anonymous: true });
  },
  startGuestSession(turnstileToken) {
    return request("/api/guest/session", { anonymous: true, method: "POST", body: JSON.stringify({ turnstileToken }) });
  },
  sendGuestChat({ philosopherId, message, conversationId, requestId, expectChargeSource, turnstileToken }) {
    return request("/api/guest/chat", { anonymous: true, method: "POST",
      body: JSON.stringify({ philosopherId, message, conversationId, requestId, expectChargeSource, turnstileToken }) });
  },
  getMe() {
    return request("/api/me");
  },
  updateName(displayName) {
    return request("/api/me/name", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  },
  async getHistory() {
    const data = await request("/api/history");
    return Array.isArray(data) ? data : data.conversations || [];
  },
  getMemories() {
    return request("/api/memories");
  },
  getPackages() {
    return request("/api/packages", { anonymous: true });
  },
  sendChat({ philosopherId, message, conversationId, requestId, expectChargeSource }) {
    return request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ philosopherId, message, conversationId, requestId, expectChargeSource }),
    });
  },
  createCheckout(packageId, requestId) {
    return request("/api/stripe/checkout", {
      method: "POST",
      body: JSON.stringify({ packageId, requestId }),
    });
  },

  getConversationMessages(conversationId) {
    return request(`/api/history/${encodeURIComponent(conversationId)}/messages`);
  },

  async getSubscription() {
    const data = await request("/api/subscription");
    return { ...data, status: data.status ?? data.subscription_status,
      currentPeriodEnd: data.currentPeriodEnd ?? data.current_period_end,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? data.cancel_at_period_end };
  },

  createPortal() {
    return request("/api/stripe/portal", { method: "POST" });
  },

  cancelSubscription() {
    return request("/api/stripe/cancel", { method: "POST" });
  },

  syncSession(sessionId) {
    return request("/api/me/sync-session", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  },

};
