// One-off helper: generate a PBKDF2 password hash in the exact format the Worker
// stores (see hashPassword in functions/api/[[route]].js). Used to seed the
// super-admin account in db/migrations/0004_seed_superadmin.sql.
//
// Usage:
//   node build/hash_password.mjs "your-password-here"
//
// Prints the hash string ("pbkdf2$100000$<salt>$<bits>") to stdout. Paste it into
// the seed migration's password_hash value. The plaintext is never stored.

const PBKDF2_ITER = 100000;
const enc = new TextEncoder();

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, key, 256
  ));
  return ["pbkdf2", PBKDF2_ITER, bytesToB64url(salt), bytesToB64url(bits)].join("$");
}

const password = process.argv[2];
if (!password) {
  console.error('Usage: node build/hash_password.mjs "<password>"');
  process.exit(1);
}
hashPassword(password).then(function (h) { process.stdout.write(h + "\n"); });
