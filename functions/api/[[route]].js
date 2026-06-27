/* PerformanceXtra API — Cloudflare Pages Functions (same-origin as the site).
 *
 * One catch-all handler routes every /api/* request. Roles are trusted ONLY from
 * the signed session cookie, never from the request body. A coach may only touch
 * rows they own (coach_id = session.uid) or athletes whose coach_id = session.uid;
 * an athlete may only read their own assignments and write their own completions.
 *
 * Bindings (wrangler.toml + Pages env):
 *   env.DB             — D1 database
 *   env.SESSION_SECRET — long random string used to sign session JWTs (HS256)
 */

const COOKIE = "px_session";
const SESSION_TTL = 60 * 60 * 24 * 30;        // 30 days
const INVITE_TTL = 60 * 60 * 24 * 14;         // 14 days
const PBKDF2_ITER = 100000;
// Fallback used only when SESSION_SECRET isn't configured. Set SESSION_SECRET in
// the Worker's environment variables for production so sessions are signed with
// your own secret.
const FALLBACK_SESSION_SECRET = "performancextra-fallback-session-secret-change-me";

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ----------------------------- responses ----------------------------- */
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, headers || {})
  });
}
function err(status, message) { return json({ error: message }, status); }

/* ----------------------------- base64url ----------------------------- */
function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function strToB64url(str) { return bytesToB64url(enc.encode(str)); }
function b64urlToStr(s) { return dec.decode(b64urlToBytes(s)); }

/* ----------------------------- JWT (HS256) ----------------------------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signJWT(payload, secret) {
  const head = strToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = strToB64url(JSON.stringify(payload));
  const data = head + "." + body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
  return data + "." + bytesToB64url(sig);
}
async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlToBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64urlToStr(parts[1])); } catch (e) { return null; }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

/* ----------------------------- passwords (PBKDF2) ----------------------------- */
async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = new Uint8Array(await deriveBits(password, salt, PBKDF2_ITER));
  return ["pbkdf2", PBKDF2_ITER, bytesToB64url(salt), bytesToB64url(bits)].join("$");
}
async function verifyPassword(password, stored) {
  if (!stored) return false;
  const p = String(stored).split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") return false;
  const bits = new Uint8Array(await deriveBits(password, b64urlToBytes(p[2]), parseInt(p[1], 10)));
  const expected = b64urlToBytes(p[3]);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/* ----------------------------- cookies / session ----------------------------- */
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionCookie(token, maxAge, secure) {
  const parts = [COOKIE + "=" + encodeURIComponent(token), "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  parts.push("Max-Age=" + maxAge);
  return parts.join("; ");
}
function clearCookie(secure) {
  const parts = [COOKIE + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
async function getSession(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const secure = new URL(request.url).protocol === "https:";
  return verifyJWT(token, await sessionSecret(env, secure));
}
async function issueSessionHeader(user, env, secure) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ uid: user.id, role: user.role, name: user.name, iat: now, exp: now + SESSION_TTL }, await sessionSecret(env, secure));
  return { "Set-Cookie": sessionCookie(token, SESSION_TTL, secure) };
}

// Resolve the secret used to sign/verify session JWTs.
//   1. Prefer an explicit SESSION_SECRET from the environment (set this in production).
//   2. Otherwise provision a strong random secret once and persist it in D1, reusing it
//      on every later request. This keeps a deployment that forgot to set SESSION_SECRET
//      fully working AND secure — never signing sessions with the public, hard-coded
//      FALLBACK below, which anyone reading this repo could use to forge a coach cookie.
//   3. The hard-coded FALLBACK is used only as a last resort on insecure (http://) origins
//      — e.g. `wrangler dev` locally — where the D1 lookup is unavailable.
async function sessionSecret(env, secure) {
  const v = String(env.SESSION_SECRET || "").trim();
  if (v) return v;
  try {
    const auto = await getOrCreateAutoSecret(env);
    if (auto) return auto;
  } catch (e) {
    if (secure) throw new Error("SESSION_SECRET is not set and an auto-secret could not be provisioned: " + ((e && e.message) || e));
  }
  if (secure) throw new Error("SESSION_SECRET environment variable is not set — refusing to use the public fallback on HTTPS");
  return FALLBACK_SESSION_SECRET;
}

// Per-deployment session secret stored in D1. Generated once on first use; the
// INSERT OR IGNORE + re-read makes concurrent first requests converge on one value.
async function getOrCreateAutoSecret(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
  const existing = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'session_secret'").first();
  if (existing && existing.value) return existing.value;
  const secret = randToken(48);
  await env.DB.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('session_secret', ?)").bind(secret).run();
  const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'session_secret'").first();
  return (row && row.value) || secret;
}

/* ----------------------------- small utils ----------------------------- */
function nowSec() { return Math.floor(Date.now() / 1000); }
function epochToIso(sec) { return new Date((Number(sec) || 0) * 1000).toISOString(); }
function isoOrEpochToEpoch(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(v);
  return isNaN(t) ? null : Math.floor(t / 1000);
}
function randToken(nBytes) { return bytesToB64url(crypto.getRandomValues(new Uint8Array(nBytes || 24))); }
// Human-friendly passcode the coach emails to a student. Avoids ambiguous characters
// (0/O, 1/I/l) and is grouped for readability, e.g. "k7mNP-q3rtv".
function genPasscode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 5) + "-" + out.slice(5);
}
function custId() {
  const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  return "CUST-" + uuid;
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
function isMissingColumnError(err, column) {
  const msg = String((err && err.message) || "").toLowerCase();
  const col = String(column || "").toLowerCase();
  return !!(col && (
    msg.includes("no such column: " + col) ||
    msg.includes("has no column named " + col)
  ));
}
// Format check + rejects obviously-fake / reserved domains so production accounts use
// real emails. Reserved TLDs per RFC 2606 / 6761 plus the old .demo placeholder.
function isPlausibleRealEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const domain = e.split("@")[1] || "";
  if (/\.(demo|invalid|local|localhost|test|example)$/.test(domain)) return false;
  if (/^example\.(com|org|net)$/.test(domain)) return false;
  return true;
}

/* ----------------------------- D1 assembly helpers ----------------------------- */
async function assembleAthlete(env, row) {
  const completed = {};
  const comp = await env.DB.prepare(
    "SELECT activity_id, MIN(completed_at) AS completed_at FROM completions WHERE athlete_id = ? GROUP BY activity_id"
  ).bind(row.id).all();
  (comp.results || []).forEach(function (c) { completed[c.activity_id] = epochToIso(c.completed_at); });

  // Student-level custom links (preferred). Falls back to the legacy per-assignment
  // custom_url column if migration 0005 hasn't been applied to this database yet.
  let studentLinks = {};
  let haveLinkTable = true;
  try {
    const lr = await env.DB.prepare(
      "SELECT activity_id, url FROM student_activity_links WHERE athlete_id = ?"
    ).bind(row.id).all();
    (lr.results || []).forEach(function (x) { if (x.url) studentLinks[x.activity_id] = x.url; });
  } catch (e) { haveLinkTable = false; }

  const asg = await env.DB.prepare(
    "SELECT id,title,note,due_at,created_at FROM assignments WHERE athlete_id = ? ORDER BY created_at DESC"
  ).bind(row.id).all();
  const assignments = [];
  for (const a of (asg.results || [])) {
    // Per-item custom_url is an additive column; fall back gracefully if the
    // migration hasn't been applied to this database yet.
    let itemsRes;
    try {
      itemsRes = await env.DB.prepare(
        "SELECT activity_id, custom_url FROM assignment_items WHERE assignment_id = ? ORDER BY position"
      ).bind(a.id).all();
    } catch (e) {
      if (!isMissingColumnError(e, "custom_url")) throw e;
      itemsRes = await env.DB.prepare(
        "SELECT activity_id FROM assignment_items WHERE assignment_id = ? ORDER BY position"
      ).bind(a.id).all();
    }
    const itemRows = itemsRes.results || [];
    // Project the student-level link onto each assignment so the client keeps using
    // asg.itemLinks unchanged; fall back to the legacy per-assignment column pre-0005.
    const itemLinks = {};
    itemRows.forEach(function (x) {
      const link = haveLinkTable ? studentLinks[x.activity_id] : x.custom_url;
      if (link) itemLinks[x.activity_id] = link;
    });
    assignments.push({
      id: a.id,
      title: a.title,
      note: a.note || "",
      dueAt: a.due_at ? epochToIso(a.due_at) : null,
      createdAt: epochToIso(a.created_at),
      items: itemRows.map(function (x) { return x.activity_id; }),
      itemLinks: itemLinks
    });
  }

  const reflections = {};
  const refl = await env.DB.prepare(
    "SELECT assignment_id, activity_id, text, updated_at FROM reflections WHERE athlete_id = ?"
  ).bind(row.id).all();
  (refl.results || []).forEach(function (r) {
    const key = String(r.assignment_id || "") + "::" + String(r.activity_id || "");
    reflections[key] = { text: r.text || "", updatedAt: epochToIso(r.updated_at || nowSec()) };
  });

  return {
    id: row.id, name: row.name, email: row.email || null,
    createdAt: epochToIso(row.created_at || nowSec()),
    completed: completed, assignments: assignments, reflections: reflections,
    activityLinks: studentLinks
  };
}
async function loadCustom(env, coachId) {
  const rows = await env.DB.prepare("SELECT id,payload FROM custom_activities WHERE coach_id = ?").bind(coachId).all();
  return (rows.results || []).map(function (r) {
    let p = {};
    try { p = JSON.parse(r.payload) || {}; } catch (e) {}
    p.id = r.id;
    return p;
  });
}
async function loadOverrides(env, coachId) {
  const rows = await env.DB.prepare("SELECT activity_id,payload,hidden FROM activity_overrides WHERE coach_id = ?").bind(coachId).all();
  const overrides = {}, hidden = {};
  (rows.results || []).forEach(function (r) {
    if (r.payload) { try { overrides[r.activity_id] = JSON.parse(r.payload); } catch (e) {} }
    if (r.hidden) hidden[r.activity_id] = true;
  });
  return { overrides: overrides, hidden: hidden };
}
// CMS-managed vocabulary for a coach. Returns {topic:[],subtopic:[],type:[]};
// empty lists mean "use the built-in data.js fallback". Tolerates a DB where
// the taxonomy table hasn't been migrated yet.
async function loadTaxonomy(env, coachId) {
  const out = { topic: [], subtopic: [], type: [] };
  try {
    const rows = await env.DB.prepare(
      "SELECT kind,value FROM taxonomy WHERE coach_id = ? ORDER BY kind, position, value"
    ).bind(coachId).all();
    (rows.results || []).forEach(function (r) {
      if (out[r.kind] && r.value != null) out[r.kind].push(r.value);
    });
  } catch (e) { /* table not migrated yet — fall back to data.js vocabulary */ }
  return out;
}

/* ===================================================================== */
/*                              entry point                              */
/* ===================================================================== */
export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  if (!env.DB) return err(500, "Server not configured: D1 binding 'DB' missing");

  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  let path = url.pathname.replace(/^\/api/, "");
  if (path === "") path = "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    return await route(method, path, request, env, url, secure);
  } catch (e) {
    console.error(e);
    return err(500, "Internal server error");
  }
}

async function route(method, path, request, env, url, secure) {
  const seg = path.split("/").filter(Boolean);
  const head = seg[0] || "";

  /* -------- public (no session) -------- */
  if (method === "POST" && path === "/setup") return handleSetup(request, env, secure);
  if (method === "POST" && path === "/login") return handleLogin(request, env, secure);
  if (method === "POST" && path === "/logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie(secure) });
  if (method === "POST" && path === "/athletes/accept") return handleAccept(request, env, secure);
  if (method === "GET" && path === "/setup-status") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_superadmin=1").first();
    return json({ needsSetup: !row || row.n === 0 });
  }

  /* -------- session required below -------- */
  const session = await getSession(request, env);
  if (!session) return err(401, "Not signed in");

  if (method === "GET" && path === "/me") return json({ id: session.uid, name: session.name, role: session.role });
  if (method === "GET" && path === "/activities") return handleListBaseActivities(env);
  if (method === "GET" && path === "/bootstrap") return handleBootstrap(session, env);
  if (method === "POST" && path === "/change-password") return handleChangePassword(session, request, env);
  if (method === "POST" && path === "/completions") return handleCompletions(session, request, env);
  if (method === "POST" && path === "/reflections") return handleReflections(session, request, env);

  if (head === "assignments") {
    if (method === "GET" && seg.length === 1) return handleListAssignments(session, env, url);
    if (method === "POST" && seg.length === 1) return handleCreateAssignment(session, request, env);
    if (method === "POST" && seg.length === 3 && seg[2] === "items") return handleUpdateAssignmentItem(session, request, env, seg[1]);
    if (method === "DELETE" && seg.length === 2) return handleDeleteAssignment(session, env, seg[1]);
  }

  /* -------- super-admin only: manage coach accounts -------- */
  if (head === "coaches") {
    if (session.role !== "superadmin") return err(403, "Super admins only");
    if (method === "GET" && seg.length === 1) return handleListCoaches(env);
    if (method === "POST" && seg.length === 1) return handleCreateCoach(request, env, url);
    if (method === "POST" && seg.length === 3 && seg[2] === "reset-passcode") return handleResetCoachPasscode(env, seg[1], url);
  }

  /* -------- coach-only below -------- */
  if (session.role !== "coach") return err(403, "Coaches only");

  if (head === "athletes") {
    if (method === "GET" && seg.length === 1) return handleListAthletes(session, env);
    if (method === "POST" && seg.length === 1) return handleCreateAthlete(session, request, env, url);
    if (method === "POST" && seg.length === 3 && (seg[2] === "reset-passcode" || seg[2] === "reinvite")) return handleResetPasscode(session, env, seg[1], url);
    if (method === "POST" && seg.length === 3 && seg[2] === "links") return handleSetStudentLink(session, request, env, seg[1]);
  }
  if (head === "custom-activities") {
    if (method === "GET" && seg.length === 1) return handleListCustom(session, env);
    if (method === "POST" && seg.length === 1) return handleSaveCustom(session, request, env);
    if (method === "DELETE" && seg.length === 2) return handleDeleteCustom(session, env, seg[1]);
  }
  if (head === "overrides") {
    if (method === "GET" && seg.length === 1) return handleListOverrides(session, env);
    if (method === "POST" && seg.length === 1) return handleSaveOverride(session, request, env);
  }
  if (head === "taxonomy") {
    if (method === "GET" && seg.length === 1) return json({ taxonomy: await loadTaxonomy(env, session.uid) });
    if (method === "POST" && seg.length === 1) return handleSaveTaxonomy(session, request, env);
  }
  if (method === "POST" && path === "/import") return handleImport(session, request, env);

  return err(404, "Not found: " + method + " " + path);
}

/* ----------------------------- auth handlers ----------------------------- */
// Recovery bootstrap: create the first super-admin if none exists. The production
// super admin is normally seeded by db/migrations/0004_seed_superadmin.sql; this path
// only matters if that seed was never applied (or the row was removed).
// The effective session role: a row flagged is_superadmin is the super admin (its
// stored role stays 'coach' so the CHECK and FK references never had to change).
function effectiveRole(user) {
  return (user && user.is_superadmin) ? "superadmin" : (user && user.role);
}

async function handleSetup(request, env, secure) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_superadmin=1").first();
  if (existing && existing.n > 0) return err(403, "Setup already complete — sign in instead");
  const b = await readBody(request);
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!name || !email || password.length < 8) return err(400, "Name, email, and an 8+ character password are required");
  if (!isPlausibleRealEmail(email)) return err(400, "Enter a real email address");
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (id,email,name,role,is_superadmin,password_hash,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, email, name, "coach", 1, hash, nowSec()).run();
  const user = { id: id, name: name, role: "superadmin" };
  return json(user, 200, await issueSessionHeader(user, env, secure));
}

async function handleLogin(request, env, secure) {
  const b = await readBody(request);
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!email || !password) return err(400, "Email and password are required");
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return err(401, "Invalid email or password");
  }
  const sessionUser = { id: user.id, name: user.name, role: effectiveRole(user) };
  return json(sessionUser, 200, await issueSessionHeader(sessionUser, env, secure));
}

async function handleAccept(request, env, secure) {
  const b = await readBody(request);
  const token = String(b.token || "").trim();
  const password = String(b.password || "");
  if (!token || password.length < 8) return err(400, "Invite link and an 8+ character password are required");
  const user = await env.DB.prepare("SELECT * FROM users WHERE invite_token = ?").bind(token).first();
  if (!user) return err(400, "This invite is invalid or has already been used");
  if (user.invite_expires && nowSec() > user.invite_expires) return err(400, "This invite has expired — ask your coach for a new one");
  const hash = await hashPassword(password);
  await env.DB.prepare("UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?")
    .bind(hash, user.id).run();
  const out = { id: user.id, name: user.name, role: user.role };
  return json(out, 200, await issueSessionHeader(user, env, secure));
}

async function handleChangePassword(session, request, env) {
  const b = await readBody(request);
  const currentPassword = String(b.current_password || "");
  const newPassword = String(b.new_password || "");
  if (!currentPassword || newPassword.length < 8) return err(400, "Current password and a new 8+ character password are required");
  
  // Fetch the user's current password hash
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.uid).first();
  if (!user || !user.password_hash) return err(400, "User not found or has no password");
  
  // Verify the current password
  const isValid = await verifyPassword(currentPassword, user.password_hash);
  if (!isValid) return err(401, "Current password is incorrect");
  
  // Hash and update the new password
  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(newHash, session.uid).run();
  
  return json({ ok: true });
}

/* ----------------------------- data handlers ----------------------------- */
// The 190 built-in activities, served from D1 (seeded by db/seed_activities.sql).
// The client uses these as the authoritative base set in SERVER mode and falls back
// to its bundled data.js copy if this ever returns nothing.
async function handleListBaseActivities(env) {
  const rows = await env.DB.prepare("SELECT payload FROM base_activities ORDER BY position").all();
  const activities = [];
  let bad = 0;
  (rows.results || []).forEach(function (r) {
    try { activities.push(JSON.parse(r.payload)); } catch (e) { bad++; }
  });
  // Fail rather than return a partial set: a corrupt row would otherwise yield e.g.
  // 189/190 with a 200, defeating the client's fallback to its bundled data.js copy.
  if (bad > 0) return err(500, "Some base activities could not be read");
  return json({ activities: activities });
}

async function handleBootstrap(session, env) {
  const me = { id: session.uid, name: session.name, role: session.role };
  if (session.role === "superadmin") {
    return json({ me: me, coaches: await listCoaches(env) });
  }
  if (session.role === "coach") {
    const rows = await env.DB.prepare(
      "SELECT id,name,email,created_at,(password_hash IS NOT NULL) AS has_password FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
    ).bind(session.uid).all();
    const students = {};
    for (const r of (rows.results || [])) {
      const a = await assembleAthlete(env, r);
      a.hasPassword = !!r.has_password;
      students[r.id] = a;
    }
    const custom = await loadCustom(env, session.uid);
    const ov = await loadOverrides(env, session.uid);
    const taxonomy = await loadTaxonomy(env, session.uid);
    return json({ me: me, students: students, activeStudentId: null, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden, taxonomy: taxonomy });
  }
  // athlete: only self, plus their coach's custom/overrides so assigned content renders
  const meRow = await env.DB.prepare("SELECT id,name,email,coach_id,created_at FROM users WHERE id = ?").bind(session.uid).first();
  const self = await assembleAthlete(env, meRow);
  const students = {}; students[session.uid] = self;
  let custom = [], ov = { overrides: {}, hidden: {} }, taxonomy = { topic: [], subtopic: [], type: [] };
  if (meRow && meRow.coach_id) { custom = await loadCustom(env, meRow.coach_id); ov = await loadOverrides(env, meRow.coach_id); taxonomy = await loadTaxonomy(env, meRow.coach_id); }
  return json({ me: me, students: students, activeStudentId: session.uid, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden, taxonomy: taxonomy });
}

async function handleListAthletes(session, env) {
  const rows = await env.DB.prepare(
    "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
  ).bind(session.uid).all();
  const athletes = [];
  for (const r of (rows.results || [])) {
    const c = await env.DB.prepare("SELECT COUNT(DISTINCT activity_id) AS n FROM completions WHERE athlete_id = ?").bind(r.id).first();
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM assignments WHERE athlete_id = ?").bind(r.id).first();
    athletes.push({
      id: r.id, name: r.name, email: r.email,
      hasPassword: !!r.has_password,
      completedCount: c ? c.n : 0, assignmentCount: a ? a.n : 0
    });
  }
  return json({ athletes: athletes });
}

async function handleCreateAthlete(session, request, env, url) {
  const b = await readBody(request);
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  if (!name || !email) return err(400, "Name and email are required");
  if (!isPlausibleRealEmail(email)) return err(400, "Enter a real email address (no .demo/.test/.local placeholders)");
  const dupe = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (dupe) return err(409, "A user with that email already exists");
  const id = crypto.randomUUID();
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare(
    "INSERT INTO users (id,email,name,role,coach_id,password_hash,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, email, name, "athlete", session.uid, hash, nowSec()).run();
  // The plaintext passcode is returned exactly once so the coach can email it. Only the
  // PBKDF2 hash is stored; if the coach loses it they must reset to a new one.
  return json({ athlete: { id: id, name: name, email: email }, passcode: passcode, loginUrl: url.origin + "/" });
}

async function handleResetPasscode(session, env, athleteId, url) {
  const row = await env.DB.prepare("SELECT id,name,email FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(athleteId, session.uid).first();
  if (!row) return err(404, "Athlete not found");
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare("UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?").bind(hash, athleteId).run();
  return json({ athlete: { id: row.id, name: row.name, email: row.email }, passcode: passcode, loginUrl: url.origin + "/" });
}

/* --------------------- super-admin: coach management --------------------- */
// Every coach with their athlete count. Used by GET /coaches and the superadmin bootstrap.
async function listCoaches(env) {
  const rows = await env.DB.prepare(
    "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password,created_at FROM users WHERE role='coach' AND is_superadmin=0 ORDER BY name"
  ).all();
  const coaches = [];
  for (const r of (rows.results || [])) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE coach_id = ? AND role='athlete'").bind(r.id).first();
    coaches.push({ id: r.id, name: r.name, email: r.email, hasPassword: !!r.has_password, studentCount: c ? c.n : 0 });
  }
  return coaches;
}

async function handleListCoaches(env) {
  return json({ coaches: await listCoaches(env) });
}

// Super admin creates a coach. Like creating an athlete, the server generates a
// one-time passcode the super admin relays to the coach; only the hash is stored.
async function handleCreateCoach(request, env, url) {
  const b = await readBody(request);
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  if (!name || !email) return err(400, "Name and email are required");
  if (!isPlausibleRealEmail(email)) return err(400, "Enter a real email address (no .demo/.test/.local placeholders)");
  const dupe = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (dupe) return err(409, "A user with that email already exists");
  const id = crypto.randomUUID();
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare(
    "INSERT INTO users (id,email,name,role,coach_id,password_hash,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, email, name, "coach", null, hash, nowSec()).run();
  return json({ coach: { id: id, name: name, email: email }, passcode: passcode, loginUrl: url.origin + "/" });
}

async function handleResetCoachPasscode(env, coachId, url) {
  const row = await env.DB.prepare("SELECT id,name,email FROM users WHERE id = ? AND role='coach' AND is_superadmin=0").bind(coachId).first();
  if (!row) return err(404, "Coach not found");
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare("UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?").bind(hash, coachId).run();
  return json({ coach: { id: row.id, name: row.name, email: row.email }, passcode: passcode, loginUrl: url.origin + "/" });
}

// Set/clear a student-level custom link for one activity. Scoped to (athlete, activity)
// so it applies to every assignment of that activity for this student.
async function handleSetStudentLink(session, request, env, athleteId) {
  const owns = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(athleteId, session.uid).first();
  if (!owns) return err(404, "Athlete not found");
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  if (!activityId) return err(400, "activity_id is required");
  const url = cleanUrl(b.url != null ? b.url : (b.custom_url != null ? b.custom_url : b.customUrl));
  try {
    if (url === null) {
      await env.DB.prepare("DELETE FROM student_activity_links WHERE athlete_id = ? AND activity_id = ?")
        .bind(athleteId, activityId).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO student_activity_links (athlete_id,activity_id,url,updated_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(athlete_id,activity_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at"
      ).bind(athleteId, activityId, url, nowSec()).run();
    }
  } catch (e) {
    return err(409, "Student links aren't available yet — apply migration 0005");
  }
  return json({ ok: true, activity_id: activityId, url: url });
}

async function handleListAssignments(session, env, url) {
  let athleteId = url.searchParams.get("athlete_id");
  if (session.role === "athlete") athleteId = session.uid;     // athletes: self only
  if (!athleteId) return err(400, "athlete_id is required");
  if (session.role === "coach") {
    const owns = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ?").bind(athleteId, session.uid).first();
    if (!owns) return err(403, "Not your athlete");
  }
  const row = await env.DB.prepare("SELECT id,name,email,created_at FROM users WHERE id = ?").bind(athleteId).first();
  if (!row) return err(404, "Athlete not found");
  const data = await assembleAthlete(env, row);
  return json({ athlete_id: athleteId, assignments: data.assignments, completed: data.completed });
}

// Accept only absolute HTTPS URLs; reject http://, javascript:, data:, etc.
// Returns the trimmed URL or null (which clears any existing custom link).
function cleanUrl(u) {
  const s = String(u == null ? "" : u).trim();
  if (!s) return null;
  return /^https:\/\//i.test(s) ? s : null;
}

// Set/clear a per-student custom link for one activity inside an assignment.
async function handleUpdateAssignmentItem(session, request, env, asgId) {
  if (session.role !== "coach") return err(403, "Coaches only");
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  if (!activityId) return err(400, "activity_id is required");
  const url = cleanUrl(b.custom_url != null ? b.custom_url : b.customUrl);
  const owns = await env.DB.prepare("SELECT id FROM assignments WHERE id = ? AND coach_id = ?").bind(asgId, session.uid).first();
  if (!owns) return err(404, "Assignment not found");
  const hasItem = await env.DB.prepare("SELECT 1 AS ok FROM assignment_items WHERE assignment_id = ? AND activity_id = ?")
    .bind(asgId, activityId).first();
  if (!hasItem) return err(404, "Activity not found in assignment");
  try {
    await env.DB.prepare("UPDATE assignment_items SET custom_url = ? WHERE assignment_id = ? AND activity_id = ?")
      .bind(url, asgId, activityId).run();
  } catch (e) {
    if (!isMissingColumnError(e, "custom_url")) throw e;
    if (url !== null) return err(409, "custom_url migration not applied yet");
  }
  return json({ ok: true, custom_url: url });
}

async function handleCreateAssignment(session, request, env) {
  if (session.role !== "coach") return err(403, "Coaches only");
  const b = await readBody(request);
  const athleteId = String(b.athlete_id || b.athleteId || "").trim();
  const title = String(b.title || "").trim() || "Workout";
  const note = String(b.note || "").trim();
  const items = Array.isArray(b.activity_ids) ? b.activity_ids : (Array.isArray(b.items) ? b.items : []);
  const dueEpoch = (b.due_at != null || b.dueAt != null) ? isoOrEpochToEpoch(b.due_at != null ? b.due_at : b.dueAt) : null;
  if (!athleteId) return err(400, "athlete_id is required");
  const owns = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ?").bind(athleteId, session.uid).first();
  if (!owns) return err(403, "Not your athlete");
  const clean = [];
  const seen = {};
  items.forEach(function (x) { if (typeof x === "string" && x && !seen[x]) { seen[x] = true; clean.push(x); } });
  if (!clean.length) return err(400, "At least one activity is required");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO assignments (id,coach_id,athlete_id,title,note,due_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, session.uid, athleteId, title, note || null, dueEpoch, nowSec()).run();
  const stmts = clean.map(function (aid, i) {
    return env.DB.prepare("INSERT INTO assignment_items (assignment_id,activity_id,position) VALUES (?,?,?)").bind(id, aid, i);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return json({ id: id });
}

async function handleDeleteAssignment(session, env, asgId) {
  if (session.role !== "coach") return err(403, "Coaches only");
  const row = await env.DB.prepare("SELECT id FROM assignments WHERE id = ? AND coach_id = ?").bind(asgId, session.uid).first();
  if (!row) return err(404, "Assignment not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM completions WHERE assignment_id = ?").bind(asgId),
    env.DB.prepare("DELETE FROM reflections WHERE assignment_id = ?").bind(asgId),
    env.DB.prepare("DELETE FROM assignment_items WHERE assignment_id = ?").bind(asgId),
    env.DB.prepare("DELETE FROM assignments WHERE id = ?").bind(asgId)
  ]);
  return json({ ok: true });
}

async function handleCompletions(session, request, env) {
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  const assignmentId = b.assignment_id || b.assignmentId || null;
  const athleteIdInput = String(b.athlete_id || b.athleteId || "").trim();
  const done = b.done !== false;     // default: mark done
  if (!activityId) return err(400, "activity_id is required");

  var athleteId = session.uid;
  if (session.role === "coach") {
    athleteId = athleteIdInput;
    if (!athleteId) return err(400, "athlete_id is required for coach updates");
    const ownsAthlete = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'"
    ).bind(athleteId, session.uid).first();
    if (!ownsAthlete) return err(403, "Not your athlete");
  } else if (session.role !== "athlete") {
    return err(403, "Only athletes or their coach can mark work done");
  }

  if (assignmentId) {
    const owns = await env.DB.prepare("SELECT id FROM assignments WHERE id = ? AND athlete_id = ?").bind(assignmentId, athleteId).first();
    if (!owns) return err(403, "Assignment not found for this athlete");
  }
  if (done) {
    if (assignmentId) {
      await env.DB.prepare("INSERT OR IGNORE INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)")
        .bind(athleteId, activityId, assignmentId, nowSec()).run();
    } else {
      const ex = await env.DB.prepare("SELECT 1 AS x FROM completions WHERE athlete_id = ? AND activity_id = ? AND assignment_id IS NULL").bind(athleteId, activityId).first();
      if (!ex) await env.DB.prepare("INSERT INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)").bind(athleteId, activityId, null, nowSec()).run();
    }
  } else {
    await env.DB.prepare("DELETE FROM completions WHERE athlete_id = ? AND activity_id = ?").bind(athleteId, activityId).run();
  }
  return json({ ok: true, done: done, athlete_id: athleteId });
}

async function handleReflections(session, request, env) {
  if (session.role !== "athlete") return err(403, "Only athletes can submit reflections");
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  const assignmentId = String(b.assignment_id || b.assignmentId || "").trim();
  const text = String(b.text || "").trim();
  if (!activityId) return err(400, "activity_id is required");

  if (assignmentId) {
    const owns = await env.DB.prepare("SELECT id FROM assignments WHERE id = ? AND athlete_id = ?").bind(assignmentId, session.uid).first();
    if (!owns) return err(403, "Not your assignment");
  }

  if (!text) {
    await env.DB.prepare(
      "DELETE FROM reflections WHERE athlete_id = ? AND assignment_id = ? AND activity_id = ?"
    ).bind(session.uid, assignmentId, activityId).run();
    return json({ ok: true, cleared: true, updatedAt: epochToIso(nowSec()) });
  }

  await env.DB.prepare(
    "INSERT INTO reflections (athlete_id,assignment_id,activity_id,text,updated_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(athlete_id,assignment_id,activity_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at"
  ).bind(session.uid, assignmentId, activityId, text, nowSec()).run();
  return json({ ok: true, updatedAt: epochToIso(nowSec()) });
}

async function handleListCustom(session, env) {
  return json({ customActivities: await loadCustom(env, session.uid) });
}
async function handleSaveCustom(session, request, env) {
  const b = await readBody(request);
  const payload = (b.payload && typeof b.payload === "object") ? b.payload : b;
  let id = payload.id || b.id;
  if (!id || !/^CUST-/.test(id)) id = custId();
  const store = Object.assign({}, payload);
  delete store.id;
  const existing = await env.DB.prepare("SELECT id FROM custom_activities WHERE id = ? AND coach_id = ?").bind(id, session.uid).first();
  if (existing) {
    await env.DB.prepare("UPDATE custom_activities SET payload = ? WHERE id = ? AND coach_id = ?").bind(JSON.stringify(store), id, session.uid).run();
  } else {
    await env.DB.prepare("INSERT INTO custom_activities (id,coach_id,payload,created_at) VALUES (?,?,?,?)").bind(id, session.uid, JSON.stringify(store), nowSec()).run();
  }
  return json({ id: id });
}
async function handleDeleteCustom(session, env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM custom_activities WHERE id = ? AND coach_id = ?").bind(id, session.uid),
    env.DB.prepare("DELETE FROM activity_overrides WHERE activity_id = ? AND coach_id = ?").bind(id, session.uid)
  ]);
  return json({ ok: true });
}

async function handleListOverrides(session, env) {
  const ov = await loadOverrides(env, session.uid);
  return json(ov);
}
async function handleSaveOverride(session, request, env) {
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  if (!activityId) return err(400, "activity_id is required");
  const hidden = b.hidden ? 1 : 0;
  const payload = (b.payload === null || b.payload === undefined) ? null : JSON.stringify(b.payload);
  if (payload === null && hidden === 0) {
    await env.DB.prepare("DELETE FROM activity_overrides WHERE coach_id = ? AND activity_id = ?").bind(session.uid, activityId).run();
    return json({ ok: true, cleared: true });
  }
  await env.DB.prepare(
    "INSERT INTO activity_overrides (coach_id,activity_id,payload,hidden) VALUES (?,?,?,?) " +
    "ON CONFLICT(coach_id,activity_id) DO UPDATE SET payload = excluded.payload, hidden = excluded.hidden"
  ).bind(session.uid, activityId, payload, hidden).run();
  return json({ ok: true });
}

/* ----------------------------- Taxonomy (CMS) -----------------------------
 * Stores the coach's managed topic/subtopic/type vocabulary, and on a rename or
 * remove, cascades the value change across their activities: base activities via
 * the override layer (never touching the shared seed) and custom activities in
 * place. Vocabulary writes are atomic per kind; cascades are applied in chunks. */
const TAX_FIELD = { topic: "topic", subtopic: "subtopics", type: "type" };

async function handleSaveTaxonomy(session, request, env) {
  if (session.role !== "coach") return err(403, "Coaches only");
  const b = await readBody(request);
  const kind = String(b.kind || "").trim();
  if (!TAX_FIELD[kind]) return err(400, "Invalid kind");
  const action = String(b.action || "").trim();
  const values = Array.isArray(b.values)
    ? b.values.map(function (v) { return String(v == null ? "" : v).trim(); }).filter(Boolean)
    : [];
  const coachId = session.uid;

  // Replace the stored vocabulary for this kind in one atomic batch.
  const listStmts = [env.DB.prepare("DELETE FROM taxonomy WHERE coach_id = ? AND kind = ?").bind(coachId, kind)];
  const seen = {};
  let pos = 0;
  values.forEach(function (v) {
    const k = v.toLowerCase();
    if (seen[k]) return; seen[k] = true;
    listStmts.push(env.DB.prepare("INSERT INTO taxonomy (coach_id,kind,value,position) VALUES (?,?,?,?)").bind(coachId, kind, v, pos++));
  });

  let cascade = [];
  if (action === "rename" && b.from) {
    cascade = await buildTaxCascade(env, coachId, kind, String(b.from), String(b.to || "").trim());
  } else if (action === "remove" && b.value) {
    cascade = await buildTaxCascade(env, coachId, kind, String(b.value), null);
  }

  // Preflight: verify the taxonomy table is accessible before touching any
  // data. If this fails (e.g. the table hasn't been migrated yet) we return
  // an error and leave everything unchanged.
  try {
    await env.DB.prepare("SELECT 1 FROM taxonomy LIMIT 1").first();
  } catch (e) {
    return err(500, "Couldn't save taxonomy (is the taxonomy table migrated?)");
  }

  // Apply the cascade FIRST in chunks (it can touch many activities, so
  // chunking stays well under D1's per-batch limit). Running this before
  // committing the vocabulary means that on chunk failure the old value is
  // still present in the stored vocabulary, so the coach retains a Rename/
  // Remove control and can retry — each cascade statement is idempotent.
  for (let i = 0; i < cascade.length; i += 50) {
    try {
      await env.DB.batch(cascade.slice(i, i + 50));
    } catch (e) {
      return err(500, "Couldn't update the activities for this change — your vocabulary was left unchanged, please try again. (" + (e && e.message ? e.message : "db error") + ")");
    }
  }

  // All cascade chunks succeeded — now atomically commit the new vocabulary.
  try {
    await env.DB.batch(listStmts);
  } catch (e) {
    return err(500, "Couldn't save taxonomy (is the taxonomy table migrated?)");
  }

  return json({ ok: true, taxonomy: await loadTaxonomy(env, coachId) });
}

// Build (but don't run) the statements that rewrite `from`→`to` (or remove,
// when `to` is null/empty) for a taxonomy kind across this coach's activities.
async function buildTaxCascade(env, coachId, kind, from, to) {
  const field = TAX_FIELD[kind];
  const lcFrom = String(from).trim().toLowerCase();
  const toVal = (to == null || String(to).trim() === "") ? null : String(to).trim();
  const stmts = [];
  const mapScalar = function (v) { return (v != null && String(v).trim().toLowerCase() === lcFrom) ? toVal : v; };
  const mapArray = function (arr) {
    const seen = {};
    return (Array.isArray(arr) ? arr : [])
      .map(function (x) { return (String(x).trim().toLowerCase() === lcFrom) ? toVal : x; })
      .filter(function (x) { return x != null && String(x).trim() !== ""; })
      .filter(function (x) { const k = String(x).trim().toLowerCase(); if (seen[k]) return false; seen[k] = true; return true; });
  };
  const hitScalar = function (v) { return v != null && String(v).trim().toLowerCase() === lcFrom; };
  const hitArray = function (arr) { return (Array.isArray(arr) ? arr : []).some(function (x) { return String(x).trim().toLowerCase() === lcFrom; }); };

  // Existing per-coach overrides (payload + hidden) so we can merge & keep hidden.
  const ovRows = await env.DB.prepare("SELECT activity_id,payload,hidden FROM activity_overrides WHERE coach_id = ?").bind(coachId).all();
  const ovMap = {};
  (ovRows.results || []).forEach(function (r) {
    let p = null; if (r.payload) { try { p = JSON.parse(r.payload); } catch (e) {} }
    ovMap[r.activity_id] = { payload: p, hidden: r.hidden ? 1 : 0 };
  });

  // Base activities → write/merge an override carrying the changed field.
  const baseRows = await env.DB.prepare("SELECT id,payload FROM base_activities").all();
  (baseRows.results || []).forEach(function (r) {
    let base = {}; try { base = JSON.parse(r.payload) || {}; } catch (e) {}
    const ov = ovMap[r.id] || { payload: null, hidden: 0 };
    const merged = Object.assign({}, base, ov.payload || {});
    const hit = field === "subtopics" ? hitArray(merged.subtopics) : hitScalar(merged[field]);
    if (!hit) return;
    const newPayload = Object.assign({}, ov.payload || {});
    newPayload[field] = field === "subtopics" ? mapArray(merged.subtopics) : mapScalar(merged[field]);
    stmts.push(env.DB.prepare(
      "INSERT INTO activity_overrides (coach_id,activity_id,payload,hidden) VALUES (?,?,?,?) " +
      "ON CONFLICT(coach_id,activity_id) DO UPDATE SET payload = excluded.payload, hidden = excluded.hidden"
    ).bind(coachId, r.id, JSON.stringify(newPayload), ov.hidden));
  });

  // Custom activities → rewrite payload in place.
  const custRows = await env.DB.prepare("SELECT id,payload FROM custom_activities WHERE coach_id = ?").bind(coachId).all();
  (custRows.results || []).forEach(function (r) {
    let p = {}; try { p = JSON.parse(r.payload) || {}; } catch (e) {}
    const hit = field === "subtopics" ? hitArray(p.subtopics) : hitScalar(p[field]);
    if (!hit) return;
    p[field] = field === "subtopics" ? mapArray(p.subtopics) : mapScalar(p[field]);
    stmts.push(env.DB.prepare("UPDATE custom_activities SET payload = ? WHERE id = ? AND coach_id = ?").bind(JSON.stringify(p), r.id, coachId));
  });

  return stmts;
}

/* One-time migration of a coach's exported localStorage store into D1. */
async function handleImport(session, request, env) {
  const store = await readBody(request);
  if (!store || typeof store !== "object") return err(400, "Invalid import payload");
  const summary = { athletes: 0, assignments: 0, completions: 0, custom: 0, overrides: 0 };

  const setupStmts = [];
  (Array.isArray(store.customActivities) ? store.customActivities : []).forEach(function (a) {
    const id = (a.id && /^CUST-/.test(a.id)) ? a.id : custId();
    const p = Object.assign({}, a); delete p.id;
    setupStmts.push(env.DB.prepare("INSERT OR REPLACE INTO custom_activities (id,coach_id,payload,created_at) VALUES (?,?,?,?)").bind(id, session.uid, JSON.stringify(p), nowSec()));
    summary.custom++;
  });
  const overrides = store.overrides || {};
  const hidden = store.hidden || {};
  const ovIds = {};
  Object.keys(overrides).forEach(function (k) { ovIds[k] = true; });
  Object.keys(hidden).forEach(function (k) { ovIds[k] = true; });
  Object.keys(ovIds).forEach(function (aid) {
    const pl = overrides[aid] ? JSON.stringify(overrides[aid]) : null;
    setupStmts.push(env.DB.prepare("INSERT OR REPLACE INTO activity_overrides (coach_id,activity_id,payload,hidden) VALUES (?,?,?,?)").bind(session.uid, aid, pl, hidden[aid] ? 1 : 0));
    summary.overrides++;
  });
  if (setupStmts.length) await env.DB.batch(setupStmts);

  const students = store.students || {};
  for (const sid of Object.keys(students)) {
    const s = students[sid] || {};
    const name = String(s.name || "Athlete").trim() || "Athlete";
    const email = ("imported+" + sid + "@local.invalid").toLowerCase();
    let athleteId;
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) {
      athleteId = existing.id;
    } else {
      athleteId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO users (id,email,name,role,coach_id,invite_token,invite_expires,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(athleteId, email, name, "athlete", session.uid, randToken(24), nowSec() + INVITE_TTL, nowSec()).run();
      summary.athletes++;
    }
    for (const asg of (Array.isArray(s.assignments) ? s.assignments : [])) {
      const newId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO assignments (id,coach_id,athlete_id,title,note,due_at,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(newId, session.uid, athleteId, String(asg.title || "Workout"), asg.note || null, null, asg.createdAt ? isoOrEpochToEpoch(asg.createdAt) : nowSec()).run();
      summary.assignments++;
      const items = Array.isArray(asg.items) ? asg.items : [];
      const seen = {};
      const itemStmts = [];
      const itemStmtsFallback = [];
      let pos = 0;
      items.forEach(function (aid) {
        if (typeof aid === "string" && aid && !seen[aid]) {
          seen[aid] = true;
          const p = pos++;
          const cu = (asg.itemLinks && asg.itemLinks[aid]) ? cleanUrl(asg.itemLinks[aid]) : null;
          itemStmts.push(env.DB.prepare("INSERT OR IGNORE INTO assignment_items (assignment_id,activity_id,position,custom_url) VALUES (?,?,?,?)").bind(newId, aid, p, cu));
          itemStmtsFallback.push(env.DB.prepare("INSERT OR IGNORE INTO assignment_items (assignment_id,activity_id,position) VALUES (?,?,?)").bind(newId, aid, p));
        }
      });
      if (itemStmts.length) {
        try {
          await env.DB.batch(itemStmts);
        } catch (e) {
          if (!isMissingColumnError(e, "custom_url")) throw e;
          await env.DB.batch(itemStmtsFallback);
        }
      }
    }
    const completed = s.completed || {};
    const compStmts = [];
    Object.keys(completed).forEach(function (aid) {
      compStmts.push(env.DB.prepare("INSERT OR IGNORE INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)").bind(athleteId, aid, null, isoOrEpochToEpoch(completed[aid]) || nowSec()));
      summary.completions++;
    });
    if (compStmts.length) await env.DB.batch(compStmts);

    const reflections = (s.reflections && typeof s.reflections === "object") ? s.reflections : {};
    const reflStmts = [];
    Object.keys(reflections).forEach(function (k) {
      const entry = reflections[k];
      const txt = (entry && typeof entry === "object") ? String(entry.text || "").trim() : String(entry || "").trim();
      if (!txt) return;
      const parts = k.split("::");
      const asgId = parts[0] || "";
      const aid = parts.slice(1).join("::");
      if (!aid) return;
      const ts = (entry && typeof entry === "object" && entry.updatedAt) ? isoOrEpochToEpoch(entry.updatedAt) : nowSec();
      reflStmts.push(env.DB.prepare(
        "INSERT OR REPLACE INTO reflections (athlete_id,assignment_id,activity_id,text,updated_at) VALUES (?,?,?,?,?)"
      ).bind(athleteId, asgId, aid, txt, ts || nowSec()));
    });
    if (reflStmts.length) await env.DB.batch(reflStmts);
  }
  return json({ ok: true, summary: summary });
}
