import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const files = ["index.html", "styles.css", "app.js", "data.js"];

// Self-hosted third-party bundles (Editor.js + DOMPurify), lazy-loaded by app.js when
// a rich-text editor opens. Pinned copies live in vendor/ so the site has no runtime
// CDN dependency; served as static assets they don't count against Worker request limits.
const vendorFiles = [
  "editorjs.umd.js", "editorjs-header.umd.js", "editorjs-list.umd.js",
  "editorjs-quote.umd.js", "editorjs-delimiter.umd.js", "dompurify.min.js",
  "editorjs.LICENSE.txt"
];

// Copy each asset into public/, overwriting in place. We don't remove the directory
// first: the file list is fixed (no stale files to clean), and on Windows a file
// watcher / sync agent can hold a handle on public/ that makes rmdir fail with EBUSY,
// which would break `wrangler dev`.
mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  copyFileSync(resolve(root, file), resolve(publicDir, file));
}
mkdirSync(resolve(publicDir, "vendor"), { recursive: true });
for (const file of vendorFiles) {
  copyFileSync(resolve(root, "vendor", file), resolve(publicDir, "vendor", file));
}

// Cache-busting: stamp a short content hash onto the linked asset URLs in the built
// index.html (styles.css / data.js / app.js). The hash only changes when a file's bytes
// change, so browsers and the Cloudflare CDN always fetch the current asset after an
// edit/deploy — no more "I shipped new JS but the old one still runs". The source
// index.html stays clean; only public/index.html gets stamped.
function hashOf(file) {
  return createHash("sha1").update(readFileSync(resolve(root, file))).digest("hex").slice(0, 10);
}
const versioned = ["styles.css", "data.js", "app.js"];
let html = readFileSync(resolve(root, "index.html"), "utf8");
for (const file of versioned) {
  const v = hashOf(file);
  // Match href="file" or src="file" (the local asset references only — the jspdf CDN
  // <script> uses an absolute https:// URL and is left untouched).
  const re = new RegExp('((?:href|src)=")' + file.replace(/[.]/g, "\\.") + '(")', "g");
  html = html.replace(re, '$1' + file + "?v=" + v + '$2');
}
writeFileSync(resolve(publicDir, "index.html"), html);
