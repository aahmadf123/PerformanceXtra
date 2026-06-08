import { mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const files = ["index.html", "styles.css", "app.js", "data.js"];

rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  copyFileSync(resolve(root, file), resolve(publicDir, file));
}
