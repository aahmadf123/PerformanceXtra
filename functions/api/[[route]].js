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
  return verifyJWT(token, env.SESSION_SECRET);
}
async function issueSessionHeader(user, env, secure) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ uid: user.id, role: user.role, name: user.name, iat: now, exp: now + SESSION_TTL }, env.SESSION_SECRET);
  return { "Set-Cookie": sessionCookie(token, SESSION_TTL, secure) };
}

/* ----------------------------- small utils ----------------------------- */
function nowSec() { return Math.floor(Date.now() / 1000); }
function epochToIso(sec) { return new Date((Number(sec) || 0) * 1000).toISOString(); }
function isoOrEpochToEpoch(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(v);
  return isNaN(t) ? nowSec() : Math.floor(t / 1000);
}
function randToken(nBytes) { return bytesToB64url(crypto.getRandomValues(new Uint8Array(nBytes || 24))); }
function custId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return "CUST-" + s.slice(0, 5).toUpperCase();
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/* ----------------------------- D1 assembly helpers ----------------------------- */
async function assembleAthlete(env, row) {
  const completed = {};
  const comp = await env.DB.prepare(
    "SELECT activity_id, MIN(completed_at) AS completed_at FROM completions WHERE athlete_id = ? GROUP BY activity_id"
  ).bind(row.id).all();
  (comp.results || []).forEach(function (c) { completed[c.activity_id] = epochToIso(c.completed_at); });

  const asg = await env.DB.prepare(
    "SELECT id,title,note,due_at,created_at FROM assignments WHERE athlete_id = ? ORDER BY created_at DESC"
  ).bind(row.id).all();
  const assignments = [];
  for (const a of (asg.results || [])) {
    const items = await env.DB.prepare(
      "SELECT activity_id FROM assignment_items WHERE assignment_id = ? ORDER BY position"
    ).bind(a.id).all();
    assignments.push({
      id: a.id,
      title: a.title,
      note: a.note || "",
      dueAt: a.due_at ? epochToIso(a.due_at) : null,
      createdAt: epochToIso(a.created_at),
      items: (items.results || []).map(function (x) { return x.activity_id; })
    });
  }
  return {
    id: row.id, name: row.name, email: row.email || null,
    createdAt: epochToIso(row.created_at || nowSec()),
    completed: completed, assignments: assignments
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

/* ===================================================================== */
/*                              entry point                              */
/* ===================================================================== */
export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  if (!env.DB) return err(500, "Server not configured: D1 binding 'DB' missing");
  if (!env.SESSION_SECRET) return err(500, "Server not configured: SESSION_SECRET missing");

  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  let path = url.pathname.replace(/^\/api/, "");
  if (path === "") path = "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    return await route(method, path, request, env, url, secure);
  } catch (e) {
    return err(500, "Server error: " + (e && e.message ? e.message : String(e)));
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
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='coach'").first();
    return json({ needsSetup: !row || row.n === 0 });
  }

  /* -------- session required below -------- */
  const session = await getSession(request, env);
  if (!session) return err(401, "Not signed in");

  if (method === "GET" && path === "/me") return json({ id: session.uid, name: session.name, role: session.role });
  if (method === "GET" && path === "/bootstrap") return handleBootstrap(session, env);
  if (method === "POST" && path === "/completions") return handleCompletions(session, request, env);

  if (head === "assignments") {
    if (method === "GET" && seg.length === 1) return handleListAssignments(session, env, url);
    if (method === "POST" && seg.length === 1) return handleCreateAssignment(session, request, env);
    if (method === "DELETE" && seg.length === 2) return handleDeleteAssignment(session, env, seg[1]);
  }

  /* -------- coach-only below -------- */
  if (session.role !== "coach") return err(403, "Coaches only");

  if (head === "athletes") {
    if (method === "GET" && seg.length === 1) return handleListAthletes(session, env);
    if (method === "POST" && seg.length === 1) return handleCreateAthlete(session, request, env, url);
    if (method === "POST" && seg.length === 3 && seg[2] === "reinvite") return handleReinvite(session, env, seg[1], url);
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
  if (method === "POST" && path === "/import") return handleImport(session, request, env);

  return err(404, "Not found: " + method + " " + path);
}

/* ----------------------------- auth handlers ----------------------------- */
async function handleSetup(request, env, secure) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='coach'").first();
  if (existing && existing.n > 0) return err(403, "Setup already complete — sign in instead");
  const b = await readBody(request);
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!name || !email || password.length < 8) return err(400, "Name, email, and an 8+ character password are required");
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, email, name, "coach", hash, nowSec()).run();
  const user = { id: id, name: name, role: "coach" };
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
  const out = { id: user.id, name: user.name, role: user.role };
  return json(out, 200, await issueSessionHeader(user, env, secure));
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

/* ----------------------------- data handlers ----------------------------- */
async function handleBootstrap(session, env) {
  const me = { id: session.uid, name: session.name, role: session.role };
  if (session.role === "coach") {
    const rows = await env.DB.prepare(
      "SELECT id,name,email,created_at,(password_hash IS NOT NULL) AS has_password,invite_token,invite_expires FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
    ).bind(session.uid).all();
    const students = {};
    for (const r of (rows.results || [])) {
      const a = await assembleAthlete(env, r);
      a.hasPassword = !!r.has_password;
      a.pending = !r.has_password;
      a.inviteToken = r.invite_token || null;
      a.inviteExpires = r.invite_expires || null;
      students[r.id] = a;
    }
    const custom = await loadCustom(env, session.uid);
    const ov = await loadOverrides(env, session.uid);
    return json({ me: me, students: students, activeStudentId: null, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden });
  }
  // athlete: only self, plus their coach's custom/overrides so assigned content renders
  const meRow = await env.DB.prepare("SELECT id,name,email,coach_id,created_at FROM users WHERE id = ?").bind(session.uid).first();
  const self = await assembleAthlete(env, meRow);
  const students = {}; students[session.uid] = self;
  let custom = [], ov = { overrides: {}, hidden: {} };
  if (meRow && meRow.coach_id) { custom = await loadCustom(env, meRow.coach_id); ov = await loadOverrides(env, meRow.coach_id); }
  return json({ me: me, students: students, activeStudentId: session.uid, customActivities: custom, overrides: ov.overrides, hidden: ov.hidden });
}

async function handleListAthletes(session, env) {
  const rows = await env.DB.prepare(
    "SELECT id,name,email,(password_hash IS NOT NULL) AS has_password,invite_token,invite_expires FROM users WHERE coach_id = ? AND role='athlete' ORDER BY name"
  ).bind(session.uid).all();
  const athletes = [];
  for (const r of (rows.results || [])) {
    const c = await env.DB.prepare("SELECT COUNT(DISTINCT activity_id) AS n FROM completions WHERE athlete_id = ?").bind(r.id).first();
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM assignments WHERE athlete_id = ?").bind(r.id).first();
    athletes.push({
      id: r.id, name: r.name, email: r.email,
      hasPassword: !!r.has_password, inviteToken: r.invite_token, inviteExpires: r.invite_expires,
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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "That doesn't look like a valid email");
  const dupe = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (dupe) return err(409, "A user with that email already exists");
  const id = crypto.randomUUID();
  const token = randToken(24);
  const expires = nowSec() + INVITE_TTL;
  await env.DB.prepare(
    "INSERT INTO users (id,email,name,role,coach_id,invite_token,invite_expires,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(id, email, name, "athlete", session.uid, token, expires, nowSec()).run();
  return json({ athlete: { id: id, name: name, email: email }, inviteToken: token, inviteUrl: url.origin + "/?invite=" + token, inviteExpires: expires });
}

async function handleReinvite(session, env, athleteId, url) {
  const row = await env.DB.prepare("SELECT id,name,email FROM users WHERE id = ? AND coach_id = ? AND role='athlete'").bind(athleteId, session.uid).first();
  if (!row) return err(404, "Athlete not found");
  const token = randToken(24);
  const expires = nowSec() + INVITE_TTL;
  await env.DB.prepare("UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?").bind(token, expires, athleteId).run();
  return json({ inviteToken: token, inviteUrl: url.origin + "/?invite=" + token, inviteExpires: expires });
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
    env.DB.prepare("DELETE FROM assignment_items WHERE assignment_id = ?").bind(asgId),
    env.DB.prepare("DELETE FROM assignments WHERE id = ?").bind(asgId)
  ]);
  return json({ ok: true });
}

async function handleCompletions(session, request, env) {
  if (session.role !== "athlete") return err(403, "Only athletes can mark their own work done");
  const b = await readBody(request);
  const activityId = String(b.activity_id || b.activityId || "").trim();
  const assignmentId = b.assignment_id || b.assignmentId || null;
  const done = b.done !== false;     // default: mark done
  if (!activityId) return err(400, "activity_id is required");
  if (assignmentId) {
    const owns = await env.DB.prepare("SELECT id FROM assignments WHERE id = ? AND athlete_id = ?").bind(assignmentId, session.uid).first();
    if (!owns) return err(403, "Not your assignment");
  }
  if (done) {
    if (assignmentId) {
      await env.DB.prepare("INSERT OR IGNORE INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)")
        .bind(session.uid, activityId, assignmentId, nowSec()).run();
    } else {
      const ex = await env.DB.prepare("SELECT 1 AS x FROM completions WHERE athlete_id = ? AND activity_id = ? AND assignment_id IS NULL").bind(session.uid, activityId).first();
      if (!ex) await env.DB.prepare("INSERT INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)").bind(session.uid, activityId, null, nowSec()).run();
    }
  } else {
    await env.DB.prepare("DELETE FROM completions WHERE athlete_id = ? AND activity_id = ?").bind(session.uid, activityId).run();
  }
  return json({ ok: true, done: done });
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
      let pos = 0;
      items.forEach(function (aid) { if (typeof aid === "string" && aid && !seen[aid]) { seen[aid] = true; itemStmts.push(env.DB.prepare("INSERT OR IGNORE INTO assignment_items (assignment_id,activity_id,position) VALUES (?,?,?)").bind(newId, aid, pos++)); } });
      if (itemStmts.length) await env.DB.batch(itemStmts);
    }
    const completed = s.completed || {};
    const compStmts = [];
    Object.keys(completed).forEach(function (aid) {
      compStmts.push(env.DB.prepare("INSERT OR IGNORE INTO completions (athlete_id,activity_id,assignment_id,completed_at) VALUES (?,?,?,?)").bind(athleteId, aid, null, isoOrEpochToEpoch(completed[aid]) || nowSec()));
      summary.completions++;
    });
    if (compStmts.length) await env.DB.batch(compStmts);
  }
  return json({ ok: true, summary: summary });
}
