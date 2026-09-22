let configPromise;

// Auth and public UI share one request. A public visit does not create a guest.
export function getPublicConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch("/api/config", { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
        return await response.json();
      } catch {
        return { anonymousEnabled: false, turnstileSiteKey: "", salesEnabled: false, trial: { enabled: false }, supabaseUrl: "", supabaseAnonKey: "" };
      } finally { clearTimeout(timer); }
    })();
  }
  return configPromise;
}
