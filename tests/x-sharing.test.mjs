import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { philosophers } from "../js/data/philosophers.js";
import { normalizePublicAppUrl, buildShareUrl, parseSharedSage, buildXIntent, SHARE_IMAGE_PATH } from "../js/services/shareService.js";
import { buildCanonicalUrl, renderShareMetadata, applyShareMetadata } from "../scripts/share-metadata.js";

const canonical = "https://dialogos.example.com/"; // Isolated fixture, never emitted by a normal build.

test("public URL accepts only explicit HTTPS site origins, no inferred or sensitive URLs", () => {
  assert.equal(normalizePublicAppUrl("https://DIALOGOS.example.com"), canonical);
  for (const invalid of [undefined, "", "not-url", "/", "//dialogos.example.com", "http://dialogos.example.com", "https://user:secret@dialogos.example.com", "https://dialogos.example.com/private", "https://dialogos.example.com/?access_token=secret", "https://dialogos.example.com/#private", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://example.internal", "https://site.test", "https://dialogos.example.com:8443", "https://dialogos.example.com\\@evil.com", "https://dialogos.example.com\n/?secret=1"]) {
    assert.equal(normalizePublicAppUrl(invalid), "", String(invalid));
  }
});

test("local/absent build URL omits public tags; invalid nonlocal URL fails closed", () => {
  for (const local of ["", undefined, "http://127.0.0.1:5177", "http://localhost:5177/", "http://[::1]:5177/"]) {
    assert.equal(buildCanonicalUrl(local), "");
    assert.doesNotMatch(renderShareMetadata(local), /rel="canonical"|property="og:url"|name="twitter:image"|property="og:image"|127\.0\.0\.1|localhost/);
  }
  for (const invalid of ["http://dialogos.example.com", "not-url", "https://dialogos.example.com/?secret=private", "https://u:p@localhost"]) {
    assert.throws(() => buildCanonicalUrl(invalid), /APP_URL must/);
  }
});

test("all fourteen sage links allow only the sage key and no conversation, auth or tracking data", () => {
  for (const sage of philosophers) {
    const url = new URL(buildShareUrl({ canonicalUrl: canonical, philosopherId: sage.id,
      conversationId: "private", message: "secret question", access_token: "secret", utm_source: "tracking" }));
    assert.equal(url.origin + url.pathname, canonical);
    assert.deepEqual([...url.searchParams.keys()], ["sage"]);
    assert.equal(url.searchParams.get("sage"), sage.id);
    assert.equal(parseSharedSage(url.search), sage.id);
  }
  assert.equal(buildShareUrl({ canonicalUrl: canonical }), canonical);
  assert.equal(buildShareUrl({ canonicalUrl: canonical, philosopherId: "unknown" }), "");
  assert.equal(buildShareUrl({ philosopherId: "socrates" }), "");
});

test("deep link parser rejects unknown, duplicated or injected sage identifiers", () => {
  for (const query of ["", "?sage=unknown", "?sage=socrates&sage=plato", "?sage=%3Cscript%3E", "?sage=../private", "?sage=https://evil.com"]) assert.equal(parseSharedSage(query), null);
  assert.equal(parseSharedSage("?sage=buddha&utm_source=x&conversation=private&access_token=secret"), "buddha");
});

test("X intent is an explicit compose link with fixed public text, not an automatic post or conversation export", () => {
  const url = new URL(buildXIntent({ canonicalUrl: canonical, philosopherId: "socrates", message: "private question" }));
  assert.equal(url.origin, "https://x.com");
  assert.equal(url.pathname, "/intent/tweet");
  assert.deepEqual([...url.searchParams.keys()], ["text", "url"]);
  assert.match(url.searchParams.get("text"), /ソクラテス/);
  assert.equal(url.searchParams.get("url"), canonical + "?sage=socrates");
  assert.doesNotMatch(url.href, /private|access_token|conversation|utm_/);
  assert.equal(buildXIntent({ canonicalUrl: "http://localhost:5177" }), "");
});

test("crawler receives canonical and absolute raster image metadata in static HTML, not client JavaScript", async () => {
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const html = applyShareMetadata(source, canonical);
  assert.match(html, /<link rel="canonical" href="https:\/\/dialogos\.example\.com\/">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/dialogos\.example\.com\/assets\/share\/dialogos-card\.jpg">/);
  assert.match(html, /<meta name="twitter:image:alt"/);
  assert.match(html, /og:image:width" content="1200"/);
  assert.match(html, /og:image:height" content="630"/);
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal(applyShareMetadata(html, canonical), html);
  assert.doesNotMatch(source, /dialogos\.example\.com|rel="canonical"|twitter:image"/);
  assert.throws(() => applyShareMetadata("<html></html>", canonical), /markers/);
});

test("static share image is a compact 1200x630 JPEG without private metadata", async () => {
  const file = new URL("../" + SHARE_IMAGE_PATH, import.meta.url);
  const image = await sharp(fileURLToPath(file)).metadata();
  assert.equal(image.format, "jpeg");
  assert.equal(image.width, 1200);
  assert.equal(image.height, 630);
  assert.equal(image.exif, undefined);
  assert.equal(image.xmp, undefined);
  assert.ok((await stat(file)).size < 300000);
});
