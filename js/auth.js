// Supabase Auth モジュール — すべての非同期処理にタイムアウトを設定
import { getPublicConfig } from "./services/configService.js";

let _client = null;
let _initFailed = false;

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}


async function getClient() {
  if (_client) return _client;
  if (_initFailed) return null;
  try {
    const config = await getPublicConfig();
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      _initFailed = true;
      return null;
    }
    const mod = await withTimeout(
      import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"),
      6000
    );
    if (!mod) { _initFailed = true; return null; }
    _client = mod.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
        storageKey: "dialogos.sb.auth",
      },
    });
    return _client;
  } catch (e) {
    console.warn("[auth] 初期化失敗:", e.message);
    _initFailed = true;
    return null;
  }
}

export async function initAuth() {
  // No account SDK/network is needed for a first-time public/guest visitor.
  let hasSession = false;
  try { hasSession = !!localStorage.getItem("dialogos.sb.auth"); } catch {}
  const authReturn = /(?:[?#&])(?:code|access_token|error_description)=/.test(window.location.search + window.location.hash);
  if (!hasSession && !authReturn) return null;
  return withTimeout(getClient(), 7000);
}

export async function getSession() {
  const client = await getClient();
  if (!client) return null;
  try {
    const result = await withTimeout(
      client.auth.getSession(),
      4000,
      { data: { session: null } }
    );
    return result?.data?.session ?? null;
  } catch {
    return null;
  }
}

export async function getAccessToken() {
  // クライアント未初期化なら即nullを返す（APIをブロックしない）
  if (!_client) return null;
  try {
    const session = await withTimeout(getSession(), 3000);
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function getAuthUser() {
  const session = await getSession();
  return session?.user ?? null;
}

export async function signInWithGoogle() {
  const client = await getClient();
  if (!client) throw new Error("Supabase が設定されていません。");
  return client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + "/" },
  });
}

export async function signOut() {
  const client = await getClient();
  if (!client) return;
  return client.auth.signOut();
}

export async function onAuthStateChange(callback) {
  const client = _client;
  if (!client) return;
  return client.auth.onAuthStateChange(callback);
}
