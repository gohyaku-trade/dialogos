import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const GUEST_SESSION_SECONDS = 30 * 86400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status, code, message) => Object.assign(new Error(code), { status, code, publicMessage: message });
const unavailable = () => fail(503, "GUEST_NOT_READY", "サイト内の無料対話は準備中です。人格の持ち帰りは利用できます。");

export function guestSecurity(env, fetchImpl = globalThis.fetch) {
  let app;
  try {
    app = new URL(env.APP_URL);
    if (app.username || app.password || app.search || app.hash || app.pathname !== "/"
      || (app.protocol !== "https:" && !(app.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname)))) app = null;
  } catch { app = null; }
  const secret = typeof env.GUEST_SESSION_SECRET === "string" && Buffer.byteLength(env.GUEST_SESSION_SECRET, "utf8") >= 32 ? env.GUEST_SESSION_SECRET : null;
  const secure = app?.protocol === "https:";
  const cookieName = secure ? "__Host-dialogos_guest" : "dialogos_guest_dev";
  const ready = Boolean(app && secret && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
  const mac = (domain, value) => createHmac("sha256", secret).update(`${domain}\n${app.origin}\n${value}`).digest("base64url");

  function checkRequest(req, mutation = false) {
    if (!app || !secret) throw unavailable();
    // Never derive the canonical origin from client-controlled forwarded headers.
    if (req.headers.host !== app.host || (mutation && req.headers.origin !== app.origin)
      || (req.headers.origin && req.headers.origin !== app.origin)
      || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin" && req.headers["sec-fetch-site"] !== "none")) {
      throw fail(403, "GUEST_ORIGIN_REJECTED", "元のサイトから操作をやり直してください。");
    }
    // Only Vercel's overwritten header is trusted on Vercel. Other deployments
    // use the socket directly; raw X-Forwarded-For is never authoritative.
    const address = env.VERCEL === "1" ? req.headers["x-vercel-forwarded-for"] : req.socket?.remoteAddress;
    if (typeof address !== "string" || address !== address.trim() || !isIP(address) || address.includes("%")) {
      throw fail(503, "GUEST_NETWORK_UNAVAILABLE", "接続元を確認できません。時間をおいてお試しください。");
    }
    return { address, networkHash: mac("dialogos-network-v6", networkPrefix(address)) };
  }

  function readCookie(req, now = Date.now()) {
    if (!app || !secret) return null;
    const cookies = String(req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return null;
    const value = cookies[0].slice(cookieName.length + 1);
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v6" || !UUID.test(parts[1]) || !/^\d{10}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return null;
    const payload = parts.slice(0, 3).join(".");
    const expected = mac("dialogos-cookie-v6", payload);
    if (!timingSafeEqual(Buffer.from(parts[3]), Buffer.from(expected))) return null;
    const expires = Number(parts[2]);
    if (expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + GUEST_SESSION_SECONDS + 60) return null;
    return { id: parts[1], expires };
  }

  function issueCookie(id = randomUUID(), now = Date.now()) {
    if (!ready || !UUID.test(id)) throw unavailable();
    const expires = Math.floor(now / 1000) + GUEST_SESSION_SECONDS;
    const payload = `v6.${id}.${expires}`;
    return { id, header: `${cookieName}=${payload}.${mac("dialogos-cookie-v6", payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${GUEST_SESSION_SECONDS}${secure ? "; Secure" : ""}` };
  }

  async function verify(token, network, action, requestId = null) {
    if (!ready) throw unavailable();
    if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
      throw fail(403, "TURNSTILE_REQUIRED", "不正利用防止の確認を行ってから送信してください。無料回数は消費していません。");
    }
    let response, data;
    try {
      response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: network.address }),
        signal: AbortSignal.timeout(10000),
      });
      data = await response.json();
    } catch { throw fail(503, "TURNSTILE_UNAVAILABLE", "不正利用防止の確認に接続できません。無料回数は消費していません。"); }
    if (!response.ok) throw fail(503, "TURNSTILE_UNAVAILABLE", "不正利用防止の確認を完了できません。無料回数は消費していません。");
    const age = Date.now() - Date.parse(data?.challenge_ts);
    if (data?.success !== true || data.hostname !== app.hostname || data.action !== action
      || (requestId && data.cdata !== requestId) || !Number.isFinite(age) || age < -60000 || age > 300000) {
      throw fail(403, "TURNSTILE_FAILED", "不正利用防止の確認が切れました。もう一度確認してください。無料回数は消費していません。");
    }
    // Cloudflare tokens are single-use. Also bind a one-time proof digest to the
    // atomic DB reservation, without storing the raw token or IP address.
    return createHmac("sha256", secret).update(`dialogos-proof-v6\n${token}`).digest("hex");
  }
  return { ready, checkRequest, readCookie, issueCookie, verify };
}

// Equivalent IPv6 spellings and temporary addresses within one /64 share quota.
// IPv4-mapped IPv6 is normalized to IPv4, rather than grouping all IPv4 in /64.
export function networkPrefix(address) {
  if (isIP(address) === 4) return `v4:${address}`;
  if (isIP(address) !== 6 || address.includes("%")) throw new Error("INVALID_IP");
  let expanded = address.toLowerCase();
  if (expanded.includes(".")) {
    const end = expanded.lastIndexOf(":");
    const octets = expanded.slice(end + 1).split(".").map(Number);
    expanded = `${expanded.slice(0, end)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right] = expanded.split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const words = expanded.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  const numbers = words.map(word => parseInt(word, 16));
  if (numbers.slice(0, 5).every(number => number === 0) && numbers[5] === 0xffff) {
    return `v4:${numbers[6] >> 8}.${numbers[6] & 255}.${numbers[7] >> 8}.${numbers[7] & 255}`;
  }
  return `v6:${numbers.slice(0, 4).map(number => number.toString(16).padStart(4, "0")).join(":")}/64`;
}

export function virtualGuest(id, now = new Date()) {
  const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  return { id, is_guest: true, auth_user_id: `guest:v6:${id}`, credits: 0, trial_eligible: true,
    trial_remaining: 3, trial_reserved: 0, trial_day: day,
    trial_resets_at: new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString() };
}
