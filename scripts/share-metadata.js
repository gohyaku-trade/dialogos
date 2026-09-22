import { normalizePublicAppUrl, SHARE_TITLE, SHARE_DESCRIPTION, SHARE_IMAGE_PATH, SHARE_IMAGE_ALT } from "../js/services/shareService.js";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
export function buildCanonicalUrl(value = "") {
  if (!String(value).trim()) return "";
  try {
    const url = new URL(String(value).trim());
    // Local development has no public card and must not advertise localhost.
    if (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") return "";
  } catch {}
  const canonical = normalizePublicAppUrl(value);
  if (!canonical) throw new Error("APP_URL must be an HTTPS public site origin without a path, query, fragment or credentials.");
  return canonical;
}

export function renderShareMetadata(appUrl = "") {
  const canonical = buildCanonicalUrl(appUrl);
  const image = canonical ? new URL(SHARE_IMAGE_PATH, canonical).href : "";
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:locale" content="ja_JP">',
    '<meta property="og:site_name" content="Dialogos">',
    `<meta property="og:title" content="${escape(SHARE_TITLE)}">`,
    `<meta property="og:description" content="${escape(SHARE_DESCRIPTION)}">`,
    `<meta name="twitter:card" content="${canonical ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escape(SHARE_TITLE)}">`,
    `<meta name="twitter:description" content="${escape(SHARE_DESCRIPTION)}">`,
    ...(canonical ? [
      `<link rel="canonical" href="${escape(canonical)}">`,
      `<meta property="og:url" content="${escape(canonical)}">`,
      `<meta property="og:image" content="${escape(image)}">`,
      '<meta property="og:image:type" content="image/jpeg">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${escape(SHARE_IMAGE_ALT)}">`,
      `<meta name="twitter:image" content="${escape(image)}">`,
      `<meta name="twitter:image:alt" content="${escape(SHARE_IMAGE_ALT)}">`,
    ] : []),
  ].map(line => "    " + line).join("\n");
}

export function applyShareMetadata(html, appUrl = "") {
  if (!/<!-- share:begin -->[\s\S]*?<!-- share:end -->/.test(html)) throw new Error("Static share metadata markers are missing.");
  return html.replace(/<!-- share:begin -->[\s\S]*?<!-- share:end -->/, `<!-- share:begin -->\n${renderShareMetadata(appUrl)}\n    <!-- share:end -->`);
}
