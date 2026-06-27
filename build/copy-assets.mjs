import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const files = ["index.html", "styles.css", "app.js", "data.js"];

// Copy each asset into public/, overwriting in place. We don't remove the directory
// first: the file list is fixed (no stale files to clean), and on Windows a file
// watcher / sync agent can hold a handle on public/ that makes rmdir fail with EBUSY,
// which would break `wrangler dev`.
mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  copyFileSync(resolve(root, file), resolve(publicDir, file));
}
