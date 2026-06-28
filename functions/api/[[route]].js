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
// Owner id for the shared global content library (custom activities, overrides,
// taxonomy). Seeded as a non-login users row by migration 0006 so the coach_id FKs are
// satisfied. Coaches/athletes read GLOBAL ∪ own; admins/super admins edit this owner.
const GLOBAL_OWNER_ID = "usr_global_library";
// Strict tier ladder. Guards widen WHO may enter an endpoint (atLeast), never WHOSE
// rows they touch — ownership sub-queries (coach_id = session.uid) stay unchanged.
const ROLE_RANK = { athlete: 0, coach: 1, admin: 2, superadmin: 3 };
function rank(role) { return ROLE_RANK[role] != null ? ROLE_RANK[role] : -1; }
function atLeast(session, role) { return !!session && rank(session.role) >= rank(role); }
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
// `extra` (optional) merges machine-readable fields into the error body — e.g.
// { code: "DUPLICATE_NAME" } so the client can branch on the cause, not the wording.
function err(status, message, extra) { return json(Object.assign({ error: message }, extra || {}), status); }

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
// Human-friendly passcode the coach shares with a student. Avoids ambiguous characters
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
// opts.includeCoachNote: include the coach-private note (coach views only — it must
// never reach the athlete's own bootstrap).
async function assembleAthlete(env, row, opts) {
  opts = opts || {};
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

  // Mental-performance check-ins + journal (migration 0008). Tolerate a DB where the
  // tables don't exist yet by degrading to empty lists.
  let checkins = [];
  try {
    const ci = await env.DB.prepare(
      "SELECT day, mood, energy, stress, note, updated_at FROM checkins WHERE athlete_id = ? ORDER BY day DESC LIMIT 60"
    ).bind(row.id).all();
    checkins = (ci.results || []).map(function (r) {
      return { day: r.day, mood: r.mood, energy: r.energy, stress: r.stress, note: r.note || "", updatedAt: epochToIso(r.updated_at || nowSec()) };
    });
  } catch (e) { checkins = []; }
  let journal = [];
  try {
    const jr = await env.DB.prepare(
      "SELECT id, body, created_at FROM journal_entries WHERE athlete_id = ? ORDER BY created_at DESC LIMIT 100"
    ).bind(row.id).all();
    journal = (jr.results || []).map(function (r) {
      return { id: r.id, body: r.body || "", createdAt: epochToIso(r.created_at || nowSec()) };
    });
  } catch (e) { journal = []; }

  // In-app messages thread + (coach-only) private note (migration 0009). Degrade to
  // empty when the tables aren't migrated yet. Scope to the athlete's CURRENT coach
  // (opts.coachId) so a coach change never merges/leaks the previous coach's thread.
  let messages = [];
  try {
    const ms = opts.coachId
      ? await env.DB.prepare(
          "SELECT id, sender, body, created_at, read_at FROM messages WHERE athlete_id = ? AND coach_id = ? ORDER BY created_at DESC LIMIT 100"
        ).bind(row.id, opts.coachId).all()
      : await env.DB.prepare(
          "SELECT id, sender, body, created_at, read_at FROM messages WHERE athlete_id = ? ORDER BY created_at DESC LIMIT 100"
        ).bind(row.id).all();
    // Return oldest-first so the client can render a natural top-to-bottom thread.
    messages = (ms.results || []).map(function (r) {
      return { id: r.id, sender: r.sender, body: r.body || "", createdAt: epochToIso(r.created_at || nowSec()), readAt: r.read_at ? epochToIso(r.read_at) : null };
    }).reverse();
  } catch (e) { messages = []; }
  let coachNote = "";
  if (opts.includeCoachNote) {
    try {
      const nr = await env.DB.prepare("SELECT note FROM athlete_notes WHERE athlete_id = ?").bind(row.id).first();
      coachNote = (nr && nr.note) || "";
    } catch (e) { coachNote = ""; }
  }

  return {
    id: row.id, name: row.name, email: row.email || null,
    createdAt: epochToIso(row.created_at || nowSec()),
    completed: completed, assignments: assignments, reflections: reflections,
    activityLinks: studentLinks, checkins: checkins, journal: journal,
    messages: messages, coachNote: coachNote
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

/* ---- merged loaders: GLOBAL library ∪ a user's own private content ----
 * A coach/athlete sees the admin-curated global library merged with their own
 * private items; on any key conflict the PRIVATE overlay wins so a coach's local
 * edit/hide is never visually clobbered by a global one. Each tolerates a DB where
 * the global owner row hasn't been seeded yet (degrades to "own content only"). */
async function loadCustomMerged(env, coachId) {
  let globalItems = [];
  try { globalItems = await loadCustom(env, GLOBAL_OWNER_ID); } catch (e) { globalItems = []; }
  const own = (coachId && coachId !== GLOBAL_OWNER_ID) ? await loadCustom(env, coachId) : [];
  // Distinct CUST- ids across owners, but de-dupe defensively (own wins on id clash).
  const seen = {};
  const out = [];
  own.concat(globalItems).forEach(function (a) {
    if (!a || a.id == null) return;
    if (seen[a.id]) return;
    seen[a.id] = true;
    out.push(a);
  });
  return out;
}
async function loadOverridesMerged(env, coachId) {
  let g = { overrides: {}, hidden: {} };
  try { g = await loadOverrides(env, GLOBAL_OWNER_ID); } catch (e) {}
  const own = (coachId && coachId !== GLOBAL_OWNER_ID) ? await loadOverrides(env, coachId) : { overrides: {}, hidden: {} };
  return {
    overrides: Object.assign({}, g.overrides, own.overrides),   // private wins
    hidden: Object.assign({}, g.hidden, own.hidden)
  };
}
async function loadTaxonomyMerged(env, coachId) {
  const g = await loadTaxonomy(env, GLOBAL_OWNER_ID);
  const own = (coachId && coachId !== GLOBAL_OWNER_ID) ? await loadTaxonomy(env, coachId) : { topic: [], subtopic: [], type: [] };
  const out = {};
  ["topic", "subtopic", "type"].forEach(function (kind) {
    const seen = {};
    out[kind] = [];
    // Global order first, then any private-only extras; dedup case-insensitively.
    (g[kind] || []).concat(own[kind] || []).forEach(function (v) {
      if (v == null) return;
      const k = String(v).trim().toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      out[kind].push(v);
    });
  });
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
  // Site appearance (theme tokens + brand) and published builder pages are PUBLIC so the
  // signed-out login page can theme/render itself. Writes are super-admin only (below).
  if (method === "GET" && path === "/site") return handleGetSite(env);
  if (method === "GET" && head === "pages" && seg.length === 2) return handleGetPage(env, seg[1]);

  /* -------- session required below -------- */
  const session = await getSession(request, env);
  if (!session) return err(401, "Not signed in");

  if (method === "GET" && path === "/me") return json({ id: session.uid, name: session.name, role: session.role });
  if (method === "GET" && path === "/activities") return handleListBaseActivities(env);
  if (method === "GET" && path === "/bootstrap") return handleBootstrap(session, env);
  if (method === "POST" && path === "/change-password") return handleChangePassword(session, request, env);
  if (method === "POST" && path === "/completions") return handleCompletions(session, request, env);
  if (method === "POST" && path === "/reflections") return handleReflections(session, request, env);
  if (method === "POST" && path === "/checkins") return handleSaveCheckin(session, request, env);
  if (head === "journal") {
    if (method === "POST" && seg.length === 1) return handleAddJournal(session, request, env);
    if (method === "DELETE" && seg.length === 2) return handleDeleteJournal(session, env, seg[1]);
  }
  if (head === "messages") {
    if (method === "POST" && seg.length === 1) return handleSendMessage(session, request, env);
    if (method === "POST" && seg.length === 2 && seg[1] === "read") return handleMarkRead(session, request, env);
  }
  if (method === "POST" && path === "/athlete-note") return handleSaveAthleteNote(session, request, env);

  if (head === "assignments") {
    if (method === "GET" && seg.length === 1) return handleListAssignments(session, env, url);
    if (method === "POST" && seg.length === 1) return handleCreateAssignment(session, request, env);
    if (method === "POST" && seg.length === 2 && seg[1] === "bulk") return handleBulkAssign(session, request, env);
    if (method === "POST" && seg.length === 3 && seg[2] === "items") return handleUpdateAssignmentItem(session, request, env, seg[1]);
    if (method === "DELETE" && seg.length === 2) return handleDeleteAssignment(session, env, seg[1]);
  }
  if (head === "templates") {
    if (!atLeast(session, "coach")) return err(403, "Coaches only");
    if (method === "GET" && seg.length === 1) return json({ templates: await loadTemplates(env, session.uid) });
    if (method === "POST" && seg.length === 1) return handleSaveTemplate(session, request, env);
    if (method === "DELETE" && seg.length === 2) return handleDeleteTemplate(session, env, seg[1]);
  }

  /* -------- super-admin only: manage admins & other super admins, appearance -------- */
  if (head === "users") {
    if (!atLeast(session, "superadmin")) return err(403, "Super admins only");
    if (method === "GET" && seg.length === 1) return handleListUsers(env, url);
    if (method === "POST" && seg.length === 1) return handleCreateUser(session, request, env, url);
    if (method === "POST" && seg.length === 3 && seg[2] === "reset-passcode") return handleResetUserPasscode(env, seg[1], url, "any");
    if (method === "DELETE" && seg.length === 2) return handleDeleteUser(session, env, seg[1], "admin");
  }
  if (head === "site" && method === "POST" && seg.length === 1) {
    if (!atLeast(session, "superadmin")) return err(403, "Super admins only");
    return handleSaveSite(request, env);
  }
  if (head === "pages") {
    // GET /pages/:slug (published) is public and handled above. Admin/builder ops below.
    if (!atLeast(session, "superadmin")) return err(403, "Super admins only");
    if (method === "GET" && seg.length === 1) return handleListPages(env);
    if (method === "POST" && seg.length === 2) return handleSavePage(request, env, seg[1]);
  }

  /* -------- admin & super admin: manage coach accounts -------- */
  if (head === "coaches") {
    if (!atLeast(session, "admin")) return err(403, "Admins only");
    if (method === "GET" && seg.length === 1) return handleListCoaches(env);
    if (method === "POST" && seg.length === 1) return handleCreateUser(session, request, env, url, "coach");
    if (method === "POST" && seg.length === 3 && seg[2] === "reset-passcode") return handleResetUserPasscode(env, seg[1], url, "coach");
    if (method === "DELETE" && seg.length === 2) return handleDeleteUser(session, env, seg[1], "coach");
  }
  /* -------- super admin only: curate the shared global content library -------- */
  if (head === "global") {
    if (!atLeast(session, "superadmin")) return err(403, "Super admins only");
    const sub = seg[1] || "";
    if (sub === "custom-activities") {
      if (method === "GET" && seg.length === 2) return json({ customActivities: await loadCustom(env, GLOBAL_OWNER_ID) });
      if (method === "POST" && seg.length === 2) return handleSaveCustom(session, request, env, GLOBAL_OWNER_ID);
      if (method === "DELETE" && seg.length === 3) return handleDeleteCustom(session, env, seg[2], GLOBAL_OWNER_ID);
    }
    if (sub === "overrides") {
      if (method === "GET" && seg.length === 2) return json(await loadOverrides(env, GLOBAL_OWNER_ID));
      if (method === "POST" && seg.length === 2) return handleSaveOverride(session, request, env, GLOBAL_OWNER_ID);
    }
    if (sub === "taxonomy") {
      if (method === "GET" && seg.length === 2) return json({ taxonomy: await loadTaxonomy(env, GLOBAL_OWNER_ID) });
      if (method === "POST" && seg.length === 2) return handleSaveTaxonomy(session, request, env, GLOBAL_OWNER_ID);
    }
  }

  /* -------- coach-level below (coach OR admin OR super admin) -------- */
  if (!atLeast(session, "coach")) return err(403, "Coaches only");

  if (head === "athletes") {
    if (method === "GET" && seg.length === 1) return handleListAthletes(session, env, url);
    if (method === "POST" && seg.length === 1) return handleCreateAthlete(session, request, env, url);
    if (method === "DELETE" && seg.length === 2) return handleDeleteAthlete(session, env, seg[1]);
    if (method === "POST" && seg.length === 3 && (seg[2] === "reset-passcode" || seg[2] === "reinvite")) return handleResetPasscode(session, env, seg[1], url);
    if (method === "POST" && seg.length === 3 && seg[2] === "links") return handleSetStudentLink(session, request, env, seg[1]);
    if (method === "POST" && seg.length === 3 && seg[2] === "reassign") return handleReassignAthlete(session, request, env, seg[1]);
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
  if (head === "lookup") {
    if (method === "GET" && seg.length === 1) return handleLookup(env, url);
  }
  if (head === "all-athletes") {
    if (method === "GET" && seg.length === 1) return handleAllAthletes(env);
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
  if (!user) return null;
  if (user.is_superadmin) return "superadmin";
  if (user.is_admin) return "admin";
  return user.role;   // 'coach' | 'athlete'
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

  // Coach, admin and super admin all use the tabbed app: their own athletes plus the
  // content they see — the global library merged with their own private items. Higher
  // tiers also get management rosters (coaches for admin+, admins/super admins for super
  // admin). Site appearance + pages are fetched on demand by the Appearance tab.
  if (session.role !== "athlete") {
    const rows = await env.DB.prepare(
      "SELECT id,name,email,created_at,(password_hash IS NOT NULL) AS has_password FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
    ).bind(session.uid).all();
    const students = {};
    for (const r of (rows.results || [])) {
      const a = await assembleAthlete(env, r, { includeCoachNote: true, coachId: session.uid });
      a.hasPassword = !!r.has_password;
      students[r.id] = a;
    }
    const custom = await loadCustomMerged(env, session.uid);
    const ov = await loadOverridesMerged(env, session.uid);
    const taxonomy = await loadTaxonomyMerged(env, session.uid);
    const out = { me: me, students: students, activeStudentId: null, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden, taxonomy: taxonomy, templates: await loadTemplates(env, session.uid) };
    if (atLeast(session, "admin")) out.coaches = await listCoaches(env);
    if (atLeast(session, "superadmin")) { out.admins = await listAdmins(env); out.superadmins = await listSuperadmins(env); }
    return json(out);
  }

  // athlete: only self, plus GLOBAL ∪ their coach's content so assigned content renders
  const meRow = await env.DB.prepare("SELECT id,name,email,coach_id,created_at FROM users WHERE id = ?").bind(session.uid).first();
  const self = await assembleAthlete(env, meRow, { coachId: (meRow && meRow.coach_id) || null });
  const students = {}; students[session.uid] = self;
  const coachOwner = (meRow && meRow.coach_id) ? meRow.coach_id : null;
  const custom = await loadCustomMerged(env, coachOwner);
  const ov = await loadOverridesMerged(env, coachOwner);
  const taxonomy = await loadTaxonomyMerged(env, coachOwner);
  return json({ me: me, students: students, activeStudentId: session.uid, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden, taxonomy: taxonomy });
}

async function handleListAthletes(session, env, url) {
  // A coach sees only their own athletes. An admin/super admin may pass ?coachId= to
  // inspect (and empty) any coach's roster — needed before deleting that coach.
  let coachId = session.uid;
  const want = url && url.searchParams.get("coachId");
  if (want && atLeast(session, "admin")) coachId = want;
  const rows = await env.DB.prepare(
    "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
  ).bind(coachId).all();
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

// Org-wide directory search used by the create modals to surface possible duplicates
// before an account is made. Coach-level (any signed-in staff): the user explicitly chose
// full org-wide visibility, so it spans every coach's roster. ?kind=athlete|staff narrows
// it; results are capped and carry each athlete's owning-coach name for context.
async function handleLookup(env, url) {
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ matches: [] });
  const kind = String(url.searchParams.get("kind") || "").toLowerCase();
  // Escape LIKE wildcards in the user's text so "%"/"_" match literally (ESCAPE '\').
  const like = "%" + q.replace(/[\\%_]/g, function (c) { return "\\" + c; }) + "%";
  let roleClause = "";
  if (kind === "athlete") roleClause = " AND u.role='athlete'";
  else if (kind === "staff") roleClause = " AND u.role='coach'";
  const rows = await env.DB.prepare(
    "SELECT u.id,u.name,u.email,u.role,u.is_admin,u.is_superadmin, c.name AS coach_name " +
    "FROM users u LEFT JOIN users c ON c.id = u.coach_id " +
    "WHERE u.id != ?" + roleClause + " AND (lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\') " +
    "ORDER BY u.name LIMIT 25"
  ).bind(GLOBAL_OWNER_ID, like, like).all();
  const matches = (rows.results || []).map(function (r) {
    return { id: r.id, name: r.name, email: r.email, tier: effectiveRole(r), coachName: r.coach_name || null };
  });
  return json({ matches: matches });
}

// Org-wide student directory for the Students tab's "All students" subtab. Coach-level
// (any signed-in staff): the user chose full org-wide visibility. One query — a self-join
// for the owning coach's name plus correlated counts — keeps it to a single round trip.
async function handleAllAthletes(env) {
  const rows = await env.DB.prepare(
    "SELECT u.id,u.name,u.email,u.coach_id, c.name AS coach_name, " +
    "  (u.password_hash IS NOT NULL) AS has_password, " +
    "  (SELECT COUNT(DISTINCT activity_id) FROM completions WHERE athlete_id=u.id) AS completed, " +
    "  (SELECT COUNT(*) FROM assignments WHERE athlete_id=u.id) AS assignments " +
    "FROM users u LEFT JOIN users c ON c.id = u.coach_id " +
    "WHERE u.role='athlete' ORDER BY u.name"
  ).all();
  const athletes = (rows.results || []).map(function (r) {
    return {
      id: r.id, name: r.name, email: r.email,
      coachId: r.coach_id || null, coachName: r.coach_name || null,
      hasPassword: !!r.has_password,
      completedCount: r.completed || 0, assignmentCount: r.assignments || 0
    };
  });
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
  // Block an exact (case-insensitive) name collision with an existing student anywhere in
  // the org so the same athlete isn't created twice by accident. allowDuplicateName lets a
  // creator who has confirmed it's a genuinely different person override it.
  if (b.allowDuplicateName !== true) {
    const nameDupe = await env.DB.prepare("SELECT id FROM users WHERE role='athlete' AND lower(name)=lower(?)").bind(name).first();
    if (nameDupe) return err(409, "A student named \"" + name + "\" already exists. Confirm this is a different person to continue.", { code: "DUPLICATE_NAME" });
  }
  const id = crypto.randomUUID();
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare(
    "INSERT INTO users (id,email,name,role,coach_id,password_hash,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, email, name, "athlete", session.uid, hash, nowSec()).run();
  // The plaintext passcode is returned exactly once so the coach can share it. Only the
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

// Permanently delete an athlete and everything keyed to them. A plain coach may only delete
// their own athletes; an admin/super admin may delete any. No user reference in the schema
// has ON DELETE CASCADE, so every dependent row is removed explicitly in one atomic batch.
async function handleDeleteAthlete(session, env, athleteId) {
  const row = await env.DB.prepare("SELECT id,coach_id FROM users WHERE id = ? AND role='athlete'").bind(athleteId).first();
  if (!row) return err(404, "Athlete not found");
  if (!atLeast(session, "admin") && row.coach_id !== session.uid) return err(404, "Athlete not found");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM completions WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM reflections WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM assignment_items WHERE assignment_id IN (SELECT id FROM assignments WHERE athlete_id = ?)").bind(athleteId),
    env.DB.prepare("DELETE FROM assignments WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM student_activity_links WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM checkins WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM journal_entries WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM messages WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM athlete_notes WHERE athlete_id = ?").bind(athleteId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(athleteId)
  ]);
  return json({ ok: true });
}

// Admin/super-admin only: move an athlete to a different coach, or unassign them entirely
// (coachId null/empty -> coach_id = NULL). This is the non-destructive alternative to deleting
// an athlete just so their coach can be removed: once a coach's roster reaches zero, the
// HAS_STUDENTS guard in handleDeleteUser stops firing. Only coach_id changes — the athlete's
// assignments, messages and the previous coach's private notes are intentionally left in place
// (messages are re-scoped to the new coach automatically by assembleAthlete).
async function handleReassignAthlete(session, request, env, athleteId) {
  if (!atLeast(session, "admin")) return err(403, "Admins only");
  const athlete = await env.DB.prepare("SELECT id,name,coach_id FROM users WHERE id = ? AND role='athlete'").bind(athleteId).first();
  if (!athlete) return err(404, "Athlete not found");
  const b = await readBody(request);
  const raw = b.coachId;
  const targetId = (raw == null || String(raw).trim() === "") ? null : String(raw).trim();
  let coachName = null;
  if (targetId) {
    // Only a pure coach is a valid target (mirrors listCoaches) — never an admin/super admin
    // or the global-library sentinel.
    const coach = await env.DB.prepare(
      "SELECT id,name FROM users WHERE id = ? AND role='coach' AND is_admin=0 AND is_superadmin=0 AND id != ?"
    ).bind(targetId, GLOBAL_OWNER_ID).first();
    if (!coach) return err(404, "Coach not found");
    if (targetId === athlete.coach_id) return err(400, "Already assigned to that coach", { code: "NO_CHANGE" });
    coachName = coach.name;
  }
  await env.DB.prepare("UPDATE users SET coach_id = ? WHERE id = ? AND role='athlete'").bind(targetId, athleteId).run();
  return json({ athlete: { id: athleteId, name: athlete.name, coachId: targetId, coachName: coachName } });
}

/* ------------------- staff management (coaches / admins / super admins) -------------------
 * A "coach" is a pure operational account; an "admin"/"super admin" is the same kind of
 * row with an elevated flag. All three are excluded from each other's rosters by the
 * flag filters below, and the non-login global-library sentinel is always excluded. */

// Pure coaches (no admin/super-admin flag), each with their athlete count.
// Tolerates a DB where migration 0006 (the is_admin column) hasn't been applied yet:
// rather than 500 the whole bootstrap, it degrades to an empty roster until migrated.
async function listCoaches(env) {
  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password,created_at FROM users " +
      "WHERE role='coach' AND is_admin=0 AND is_superadmin=0 AND id != ? ORDER BY name"
    ).bind(GLOBAL_OWNER_ID).all();
  } catch (e) { return []; }   // is_admin column not migrated yet
  const coaches = [];
  for (const r of (rows.results || [])) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE coach_id = ? AND role='athlete'").bind(r.id).first();
    coaches.push({ id: r.id, name: r.name, email: r.email, hasPassword: !!r.has_password, studentCount: c ? c.n : 0, tier: "coach" });
  }
  return coaches;
}
async function listStaffTier(env, column, tier) {
  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password,created_at FROM users " +
      "WHERE " + column + "=1 AND id != ? ORDER BY name"
    ).bind(GLOBAL_OWNER_ID).all();
  } catch (e) { return []; }   // is_admin column not migrated yet
  return (rows.results || []).map(function (r) {
    return { id: r.id, name: r.name, email: r.email, hasPassword: !!r.has_password, tier: tier };
  });
}
function listAdmins(env) { return listStaffTier(env, "is_admin", "admin"); }
function listSuperadmins(env) { return listStaffTier(env, "is_superadmin", "superadmin"); }

async function handleListCoaches(env) {
  return json({ coaches: await listCoaches(env) });
}
// Super-admin roster view. ?tier=coach|admin|superadmin narrows it; otherwise all three.
async function handleListUsers(env, url) {
  const tier = String(url.searchParams.get("tier") || "").toLowerCase();
  if (tier === "coach") return json({ coaches: await listCoaches(env) });
  if (tier === "admin") return json({ admins: await listAdmins(env) });
  if (tier === "superadmin") return json({ superadmins: await listSuperadmins(env) });
  return json({ coaches: await listCoaches(env), admins: await listAdmins(env), superadmins: await listSuperadmins(env) });
}

const TIER_FLAGS = {                       // role stays 'coach'; the flags set the tier
  coach:      { is_admin: 0, is_superadmin: 0 },
  admin:      { is_admin: 1, is_superadmin: 0 },
  superadmin: { is_admin: 0, is_superadmin: 1 }
};

// Create a coach / admin / super admin. forcedTier is set by /coaches (always "coach",
// admin-level); /users reads the tier from the body (super-admin-only). The server
// generates a one-time passcode the creator relays; only the PBKDF2 hash is stored.
// A creator can never mint a tier ABOVE their own rank (defence-in-depth on the routes).
async function handleCreateUser(session, request, env, url, forcedTier) {
  const b = await readBody(request);
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const tier = String(forcedTier || b.tier || "coach").trim().toLowerCase();
  if (!name || !email) return err(400, "Name and email are required");
  if (!isPlausibleRealEmail(email)) return err(400, "Enter a real email address (no .demo/.test/.local placeholders)");
  if (!TIER_FLAGS[tier]) return err(400, "Invalid role");
  if (rank(tier) > rank(session.role)) return err(403, "You can't create an account above your own role");
  const dupe = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (dupe) return err(409, "A user with that email already exists");
  // Block an exact (case-insensitive) name collision with an existing staff member (any of
  // coach/admin/super admin — all stored with role='coach'). Overridable via allowDuplicateName.
  if (b.allowDuplicateName !== true) {
    const nameDupe = await env.DB.prepare("SELECT id FROM users WHERE role='coach' AND id != ? AND lower(name)=lower(?)").bind(GLOBAL_OWNER_ID, name).first();
    if (nameDupe) return err(409, "A staff member named \"" + name + "\" already exists. Confirm this is a different person to continue.", { code: "DUPLICATE_NAME" });
  }
  const id = crypto.randomUUID();
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  const flags = TIER_FLAGS[tier];
  await env.DB.prepare(
    "INSERT INTO users (id,email,name,role,is_admin,is_superadmin,coach_id,password_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, email, name, "coach", flags.is_admin, flags.is_superadmin, null, hash, nowSec()).run();
  const user = { id: id, name: name, email: email, tier: tier };
  // `coach` alias kept so the existing credentials modal keeps working for coach creation.
  return json({ user: user, coach: user, passcode: passcode, loginUrl: url.origin + "/" });
}

// Reset a staff account's passcode. scope "coach" (used by the admin-level /coaches route)
// matches pure coaches only, so an admin can't reset an admin/super-admin; scope "any"
// (super-admin-only /users route) matches any non-athlete staff row. The global-library
// sentinel is never resettable.
async function handleResetUserPasscode(env, userId, url, scope) {
  if (userId === GLOBAL_OWNER_ID) return err(404, "Not found");
  const where = scope === "coach"
    ? "id = ? AND role='coach' AND is_admin=0 AND is_superadmin=0"
    : "id = ? AND role='coach'";   // coach/admin/super admin staff rows all have role='coach'
  const row = await env.DB.prepare("SELECT id,name,email FROM users WHERE " + where).bind(userId).first();
  if (!row) return err(404, "Account not found");
  const passcode = genPasscode();
  const hash = await hashPassword(passcode);
  await env.DB.prepare("UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?").bind(hash, userId).run();
  const out = { id: row.id, name: row.name, email: row.email };
  return json({ user: out, coach: out, passcode: passcode, loginUrl: url.origin + "/" });
}

// Permanently delete a staff account. scope "coach" (admin-level /coaches route) targets a
// pure coach; scope "admin" (super-admin-only /users route) targets an admin. No scope can
// reach a super admin, and you can never delete your own account or the global-library
// sentinel — so each tier can only delete strictly below itself. A staff member who still
// has athletes is blocked (HAS_STUDENTS) so their roster is dealt with first; otherwise the
// account and the private content it owns are removed together in one atomic batch.
async function handleDeleteUser(session, env, userId, scope) {
  if (userId === GLOBAL_OWNER_ID) return err(404, "Account not found");
  if (userId === session.uid) return err(403, "You can't delete your own account");
  const where = scope === "coach"
    ? "id = ? AND role='coach' AND is_admin=0 AND is_superadmin=0"
    : "id = ? AND role='coach' AND is_admin=1 AND is_superadmin=0";
  const row = await env.DB.prepare("SELECT id,name FROM users WHERE " + where).bind(userId).first();
  if (!row) return err(404, "Account not found");
  const kids = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE coach_id = ? AND role='athlete'").bind(userId).first();
  const n = kids ? kids.n : 0;
  if (n > 0) return err(409, "This " + (scope === "admin" ? "admin" : "coach") + " still has " + n + " student" + (n === 1 ? "" : "s") + ". Remove them first.", { code: "HAS_STUDENTS", count: n });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM custom_activities WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM activity_overrides WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM taxonomy WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM assignment_templates WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM assignments WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM messages WHERE coach_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
  ]);
  return json({ ok: true });
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
  if (session.role !== "athlete") {                            // coach/admin/super admin: own athletes only
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
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
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
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
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
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
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

/* ------------------- assignment templates + bulk assign (Phase 6) ------------------- */
async function loadTemplates(env, coachId) {
  try {
    const rows = await env.DB.prepare(
      "SELECT id,title,note,items,created_at FROM assignment_templates WHERE coach_id = ? ORDER BY created_at DESC"
    ).bind(coachId).all();
    return (rows.results || []).map(function (r) {
      let items = [];
      try { items = JSON.parse(r.items) || []; } catch (e) {}
      return { id: r.id, title: r.title, note: r.note || "", items: items, createdAt: epochToIso(r.created_at || nowSec()) };
    });
  } catch (e) { return []; }   // table not migrated yet
}
function cleanIdList(arr) {
  const seen = {}, out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (x) { if (typeof x === "string" && x && !seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}
async function handleSaveTemplate(session, request, env) {
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
  const b = await readBody(request);
  const title = String(b.title || "").trim() || "Workout";
  const note = String(b.note || "").trim();
  const items = cleanIdList(b.activity_ids || b.items);
  if (!items.length) return err(400, "At least one activity is required");
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO assignment_templates (id,coach_id,title,note,items,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, session.uid, title, note || null, JSON.stringify(items), nowSec()).run();
  } catch (e) {
    return err(500, "Couldn't save the template (is the assignment_templates table migrated?)");
  }
  return json({ ok: true, id: id });
}
async function handleDeleteTemplate(session, env, id) {
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
  await env.DB.prepare("DELETE FROM assignment_templates WHERE id = ? AND coach_id = ?").bind(String(id), session.uid).run();
  return json({ ok: true });
}
// Create the same assignment for several owned athletes in one action.
async function handleBulkAssign(session, request, env) {
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
  const b = await readBody(request);
  const athleteIds = cleanIdList(b.athlete_ids || b.athleteIds);
  const title = String(b.title || "").trim() || "Workout";
  const note = String(b.note || "").trim();
  const items = cleanIdList(b.activity_ids || b.items);
  const dueEpoch = (b.due_at != null || b.dueAt != null) ? isoOrEpochToEpoch(b.due_at != null ? b.due_at : b.dueAt) : null;
  if (!athleteIds.length) return err(400, "Pick at least one athlete");
  if (!items.length) return err(400, "At least one activity is required");
  // Authorize every athlete up front; skip any that aren't this coach's.
  const owned = [];
  for (const aid of athleteIds) {
    const ok = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(aid, session.uid).first();
    if (ok) owned.push(aid);
  }
  if (!owned.length) return err(403, "None of those are your athletes");
  let created = 0;
  for (const aid of owned) {
    const asgId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO assignments (id,coach_id,athlete_id,title,note,due_at,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(asgId, session.uid, aid, title, note || null, dueEpoch, nowSec()).run();
    const stmts = items.map(function (actId, i) {
      return env.DB.prepare("INSERT INTO assignment_items (assignment_id,activity_id,position) VALUES (?,?,?)").bind(asgId, actId, i);
    });
    if (stmts.length) await env.DB.batch(stmts);
    created++;
  }
  return json({ ok: true, created: created });
}

async function handleCompletions(session, request, env) {
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  const assignmentId = b.assignment_id || b.assignmentId || null;
  const athleteIdInput = String(b.athlete_id || b.athleteId || "").trim();
  const done = b.done !== false;     // default: mark done
  if (!activityId) return err(400, "activity_id is required");

  var athleteId = session.uid;
  if (session.role !== "athlete") {     // coach/admin/super admin: mark for an athlete they own
    athleteId = athleteIdInput;
    if (!athleteId) return err(400, "athlete_id is required for coach updates");
    const ownsAthlete = await env.DB.prepare(
      "SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'"
    ).bind(athleteId, session.uid).first();
    if (!ownsAthlete) return err(403, "Not your athlete");
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

// Mental-performance check-ins + journal (Phase 3). Athletes write their own; their
// coach reads them via assembleAthlete in the bootstrap.
function clampScore(v) {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  if (!isFinite(n)) return null;
  return n < 1 ? 1 : (n > 5 ? 5 : n);
}
async function handleSaveCheckin(session, request, env) {
  if (session.role !== "athlete") return err(403, "Only athletes can check in");
  const b = await readBody(request);
  let day = String(b.day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = new Date(nowSec() * 1000).toISOString().slice(0, 10);
  const mood = clampScore(b.mood), energy = clampScore(b.energy), stress = clampScore(b.stress);
  const note = String(b.note || "").trim().slice(0, 2000);
  try {
    await env.DB.prepare(
      "INSERT INTO checkins (athlete_id,day,mood,energy,stress,note,updated_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(athlete_id,day) DO UPDATE SET mood=excluded.mood, energy=excluded.energy, stress=excluded.stress, note=excluded.note, updated_at=excluded.updated_at"
    ).bind(session.uid, day, mood, energy, stress, note, nowSec()).run();
  } catch (e) {
    return err(500, "Couldn't save your check-in (is the checkins table migrated?)");
  }
  return json({ ok: true, day: day });
}
async function handleAddJournal(session, request, env) {
  if (session.role !== "athlete") return err(403, "Only athletes can journal");
  const b = await readBody(request);
  const body = String(b.body || "").trim().slice(0, 8000);
  if (!body) return err(400, "Write something first");
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO journal_entries (id,athlete_id,body,created_at) VALUES (?,?,?,?)")
      .bind(id, session.uid, body, nowSec()).run();
  } catch (e) {
    return err(500, "Couldn't save your journal entry (is the journal_entries table migrated?)");
  }
  return json({ ok: true, id: id });
}
async function handleDeleteJournal(session, env, id) {
  if (session.role !== "athlete") return err(403, "Only athletes can delete journal entries");
  await env.DB.prepare("DELETE FROM journal_entries WHERE id = ? AND athlete_id = ?").bind(String(id), session.uid).run();
  return json({ ok: true });
}

// In-app messaging + coach-private notes (Phase 4). All in-app — no email is sent.
// Resolve the (athlete, coach) pair for a thread action and authorize it: an athlete
// acts on their own thread (with their coach); a coach/admin/super admin acts on a
// thread for an athlete they own.
async function resolveThread(session, env, athleteIdInput) {
  if (session.role === "athlete") {
    const me = await env.DB.prepare("SELECT coach_id FROM users WHERE id = ?").bind(session.uid).first();
    if (!me || !me.coach_id) return null;
    return { athleteId: session.uid, coachId: me.coach_id };
  }
  const athleteId = String(athleteIdInput || "").trim();
  if (!athleteId) return null;
  const owns = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(athleteId, session.uid).first();
  if (!owns) return null;
  return { athleteId: athleteId, coachId: session.uid };
}
async function handleSendMessage(session, request, env) {
  const b = await readBody(request);
  const t = await resolveThread(session, env, b.athlete_id || b.athleteId);
  if (!t) return err(403, "Not your thread");
  const body = String(b.body || "").trim().slice(0, 4000);
  if (!body) return err(400, "Write a message first");
  const sender = session.role === "athlete" ? "athlete" : "coach";
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare("INSERT INTO messages (id,athlete_id,coach_id,sender,body,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, t.athleteId, t.coachId, sender, body, nowSec()).run();
  } catch (e) {
    return err(500, "Couldn't send your message (is the messages table migrated?)");
  }
  return json({ ok: true, id: id });
}
async function handleMarkRead(session, request, env) {
  const b = await readBody(request);
  const t = await resolveThread(session, env, b.athlete_id || b.athleteId);
  if (!t) return err(403, "Not your thread");
  // Mark the OTHER party's messages in THIS coach<->athlete thread as read.
  const otherSender = session.role === "athlete" ? "coach" : "athlete";
  try {
    await env.DB.prepare("UPDATE messages SET read_at = ? WHERE athlete_id = ? AND coach_id = ? AND sender = ? AND read_at IS NULL")
      .bind(nowSec(), t.athleteId, t.coachId, otherSender).run();
  } catch (e) { /* table not migrated yet — nothing to mark */ }
  return json({ ok: true });
}
async function handleSaveAthleteNote(session, request, env) {
  if (session.role === "athlete") return err(403, "Coaches only");
  const b = await readBody(request);
  const athleteId = String(b.athlete_id || b.athleteId || "").trim();
  const owns = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(athleteId, session.uid).first();
  if (!owns) return err(403, "Not your athlete");
  const note = String(b.note || "").trim().slice(0, 4000);
  try {
    if (!note) {
      await env.DB.prepare("DELETE FROM athlete_notes WHERE athlete_id = ?").bind(athleteId).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO athlete_notes (athlete_id,note,updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(athlete_id) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at"
      ).bind(athleteId, note, nowSec()).run();
    }
  } catch (e) {
    return err(500, "Couldn't save the note (is the athlete_notes table migrated?)");
  }
  return json({ ok: true });
}

async function handleListCustom(session, env) {
  return json({ customActivities: await loadCustom(env, session.uid) });
}
// targetCoachId defaults to the caller (private content); the /global/* routes pass
// GLOBAL_OWNER_ID so an admin/super admin edits the shared library instead.
async function handleSaveCustom(session, request, env, targetCoachId) {
  const owner = targetCoachId || session.uid;
  const b = await readBody(request);
  const payload = (b.payload && typeof b.payload === "object") ? b.payload : b;
  let id = payload.id || b.id;
  if (!id || !/^CUST-/.test(id)) id = custId();
  const store = Object.assign({}, payload);
  delete store.id;
  const existing = await env.DB.prepare("SELECT id FROM custom_activities WHERE id = ? AND coach_id = ?").bind(id, owner).first();
  if (existing) {
    await env.DB.prepare("UPDATE custom_activities SET payload = ? WHERE id = ? AND coach_id = ?").bind(JSON.stringify(store), id, owner).run();
  } else {
    await env.DB.prepare("INSERT INTO custom_activities (id,coach_id,payload,created_at) VALUES (?,?,?,?)").bind(id, owner, JSON.stringify(store), nowSec()).run();
  }
  return json({ id: id });
}
async function handleDeleteCustom(session, env, id, targetCoachId) {
  const owner = targetCoachId || session.uid;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM custom_activities WHERE id = ? AND coach_id = ?").bind(id, owner),
    env.DB.prepare("DELETE FROM activity_overrides WHERE activity_id = ? AND coach_id = ?").bind(id, owner)
  ]);
  return json({ ok: true });
}

async function handleListOverrides(session, env) {
  const ov = await loadOverrides(env, session.uid);
  return json(ov);
}
async function handleSaveOverride(session, request, env, targetCoachId) {
  const owner = targetCoachId || session.uid;
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  if (!activityId) return err(400, "activity_id is required");
  const hidden = b.hidden ? 1 : 0;
  const payload = (b.payload === null || b.payload === undefined) ? null : JSON.stringify(b.payload);
  if (payload === null && hidden === 0) {
    await env.DB.prepare("DELETE FROM activity_overrides WHERE coach_id = ? AND activity_id = ?").bind(owner, activityId).run();
    return json({ ok: true, cleared: true });
  }
  await env.DB.prepare(
    "INSERT INTO activity_overrides (coach_id,activity_id,payload,hidden) VALUES (?,?,?,?) " +
    "ON CONFLICT(coach_id,activity_id) DO UPDATE SET payload = excluded.payload, hidden = excluded.hidden"
  ).bind(owner, activityId, payload, hidden).run();
  return json({ ok: true });
}

/* ----------------------------- Taxonomy (CMS) -----------------------------
 * Stores the coach's managed topic/subtopic/type vocabulary, and on a rename or
 * remove, cascades the value change across their activities: base activities via
 * the override layer (never touching the shared seed) and custom activities in
 * place. Vocabulary writes are atomic per kind; cascades are applied in chunks. */
const TAX_FIELD = { topic: "topic", subtopic: "subtopics", type: "type" };

async function handleSaveTaxonomy(session, request, env, targetCoachId) {
  if (!atLeast(session, "coach")) return err(403, "Coaches only");
  const b = await readBody(request);
  const kind = String(b.kind || "").trim();
  if (!TAX_FIELD[kind]) return err(400, "Invalid kind");
  const action = String(b.action || "").trim();
  const values = Array.isArray(b.values)
    ? b.values.map(function (v) { return String(v == null ? "" : v).trim(); }).filter(Boolean)
    : [];
  const coachId = targetCoachId || session.uid;

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

/* ----------------------- Appearance CMS: theme + page builder -----------------------
 * Super-admin-only writes; reads are public (the signed-out login page themes itself).
 * Theme tokens map 1:1 to the CSS custom properties in styles.css :root. Page blocks
 * are an ordered, whitelisted, sanitized JSON array rendered to DOM on the client. */

// Built-in defaults returned when site_settings is empty or unmigrated, so theming
// never blocks the login gate. Keys mirror styles.css :root.
const DEFAULT_THEME = {
  accent: "#c9f24e", ember: "#ff6a3d", bg: "#0b0d12", surface: "#14171f",
  ink: "#f1f4f8", line: "rgba(255,255,255,.08)", danger: "#ff5d6c", warn: "#f5c451",
  radius: "14px", space: "16px",
  fontBody: "\"Hanken Grotesk\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
  fontDisplay: "\"Bricolage Grotesque\", \"Hanken Grotesk\", system-ui, sans-serif",
  fontScale: "1"
};
const THEME_KEYS = Object.keys(DEFAULT_THEME);
const SITE_KEYS = ["brandName", "brandTag"];
const BLOCK_TYPES = ["hero", "heading", "text", "image", "cards", "button", "spacer"];

async function loadSiteSettings(env) {
  const out = { theme: Object.assign({}, DEFAULT_THEME), site: {} };
  try {
    const rows = await env.DB.prepare("SELECT key,value FROM site_settings").all();
    (rows.results || []).forEach(function (r) {
      let v = null; try { v = JSON.parse(r.value); } catch (e) {}
      if (!v || typeof v !== "object") return;
      if (r.key === "theme") out.theme = Object.assign({}, DEFAULT_THEME, v);
      else if (r.key === "site") out.site = v;
    });
  } catch (e) { /* table not migrated yet — return defaults */ }
  return out;
}
async function handleGetSite(env) {
  return json(await loadSiteSettings(env));
}
// Keep only known keys with string values, so a malformed save can't inject arbitrary
// CSS-variable names or oversized blobs.
function pickStrings(src, keys) {
  const out = {};
  if (src && typeof src === "object") {
    keys.forEach(function (k) {
      if (src[k] != null) out[k] = String(src[k]).slice(0, 400);
    });
  }
  return out;
}
async function handleSaveSite(request, env) {
  const b = await readBody(request);
  const stmts = [];
  if (b.theme != null) {
    const theme = pickStrings(b.theme, THEME_KEYS);
    stmts.push(env.DB.prepare(
      "INSERT INTO site_settings (key,value,updated_at) VALUES ('theme',?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(JSON.stringify(theme), nowSec()));
  }
  if (b.site != null) {
    const site = pickStrings(b.site, SITE_KEYS);
    stmts.push(env.DB.prepare(
      "INSERT INTO site_settings (key,value,updated_at) VALUES ('site',?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(JSON.stringify(site), nowSec()));
  }
  if (!stmts.length) return err(400, "Nothing to save");
  try { await env.DB.batch(stmts); }
  catch (e) { return err(500, "Couldn't save appearance (is the site_settings table migrated?)"); }
  return json({ ok: true, site: await loadSiteSettings(env) });
}

// Drop ASCII control chars and cap length before persistence. Rendering uses textContent
// on the client, and this server-side scrub adds an extra defence-in-depth layer.
function cleanText(v, max) {
  return String(v == null ? "" : v).replace(/[\x00-\x1F\x7F]/g, " ").slice(0, max || 2000);
}
// Allow only tight CSS length tokens used for image max-width.
function cleanMaxWidth(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/^((?:[0-9]{1,3}|1[0-9]{3}|2000))(px|%)$/);
  if (!m) return "";
  return String(Number(m[1])) + m[2];
}
// One sanitized block. Unknown types/props are dropped; links must be absolute https.
function sanitizeBlock(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").toLowerCase();
  if (BLOCK_TYPES.indexOf(type) === -1) return null;
  const p = (raw.props && typeof raw.props === "object") ? raw.props : {};
  const id = /^[a-zA-Z0-9_-]{1,40}$/.test(String(raw.id || "")) ? String(raw.id) : ("b" + i + "_" + (nowSec() % 100000));
  const props = {};
  if (type === "hero") {
    props.heading = cleanText(p.heading, 160);
    props.sub = cleanText(p.sub, 400);
    props.ctaLabel = cleanText(p.ctaLabel, 60);
    props.ctaHref = cleanUrl(p.ctaHref) || "";
    props.align = (p.align === "left" || p.align === "right") ? p.align : "center";
  } else if (type === "heading") {
    props.text = cleanText(p.text, 160);
    props.level = (p.level === 1 || p.level === 2 || p.level === 3) ? p.level : 2;
  } else if (type === "text") {
    props.text = cleanText(p.text, 4000);
  } else if (type === "image") {
    props.src = cleanUrl(p.src) || "";
    props.alt = cleanText(p.alt, 200);
    props.width = cleanMaxWidth(p.width);
  } else if (type === "cards") {
    props.items = (Array.isArray(p.items) ? p.items : []).slice(0, 12).map(function (it) {
      it = it || {};
      return { title: cleanText(it.title, 120), body: cleanText(it.body, 600), icon: cleanText(it.icon, 8) };
    });
  } else if (type === "button") {
    props.label = cleanText(p.label, 60);
    props.href = cleanUrl(p.href) || "";
    props.style = (p.style === "ghost" || p.style === "ember") ? p.style : "primary";
  } else if (type === "spacer") {
    props.size = (p.size === "sm" || p.size === "lg") ? p.size : "md";
  }
  return { id: id, type: type, props: props };
}
function sanitizeBlocks(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 100).map(sanitizeBlock).filter(Boolean);
}
async function handleGetPage(env, slug) {
  try {
    const row = await env.DB.prepare("SELECT id,title,blocks,published FROM pages WHERE id = ?").bind(String(slug)).first();
    if (!row || !row.published) return err(404, "Page not found");
    let blocks = []; try { blocks = JSON.parse(row.blocks) || []; } catch (e) {}
    return json({ id: row.id, title: row.title, blocks: blocks, published: !!row.published });
  } catch (e) { return err(404, "Page not found"); }
}
async function handleListPages(env) {
  try {
    const rows = await env.DB.prepare("SELECT id,title,blocks,published,updated_at FROM pages ORDER BY id").all();
    const pages = (rows.results || []).map(function (r) {
      let blocks = []; try { blocks = JSON.parse(r.blocks) || []; } catch (e) {}
      return { id: r.id, title: r.title, blocks: blocks, published: !!r.published, updated_at: r.updated_at };
    });
    return json({ pages: pages });
  } catch (e) { return json({ pages: [] }); }
}
async function handleSavePage(request, env, slug) {
  const id = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return err(400, "Invalid page slug");
  const b = await readBody(request);
  const title = cleanText(b.title, 120) || id;
  const blocks = sanitizeBlocks(b.blocks);
  const published = b.published ? 1 : 0;
  try {
    await env.DB.prepare(
      "INSERT INTO pages (id,title,blocks,published,updated_at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET title = excluded.title, blocks = excluded.blocks, published = excluded.published, updated_at = excluded.updated_at"
    ).bind(id, title, JSON.stringify(blocks), published, nowSec()).run();
  } catch (e) { return err(500, "Couldn't save page (is the pages table migrated?)"); }
  return json({ ok: true, id: id, title: title, blocks: blocks, published: !!published });
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
