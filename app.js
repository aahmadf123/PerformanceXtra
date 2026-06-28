(function () {
  "use strict";

  /* ----------------------------- Data -----------------------------
   * The activity dataset and filter taxonomy are generated from the spreadsheet
   * into data.js (window.PX_DATA / window.PX_TAXONOMY), loaded before this file. */
  // BASE is the immutable set generated from the spreadsheet. The working sets
  // (ALL / DATA / BY_ID / PRESENT) are rebuilt from BASE plus admin additions
  // (custom activities, per-activity overrides, hidden flags) by rebuildData().
  var BASE = (typeof window.PX_DATA !== "undefined" && Array.isArray(window.PX_DATA)) ? window.PX_DATA : [];
  var TAX = (typeof window.PX_TAXONOMY !== "undefined" && window.PX_TAXONOMY)
    ? window.PX_TAXONOMY
    : { topics: [], subtopics: [], types: [], progressions: [], frequencies: [], months: [] };
  // The built-in vocabulary shipped in data.js. Used as the fallback whenever a
  // coach hasn't customised that list via the CMS (state.tracking.taxonomy).
  var TAX_FALLBACK = {
    topic: (TAX.topics || []).slice(),
    subtopic: (TAX.subtopics || []).slice(),
    type: (TAX.types || []).slice()
  };
  var ALL = [];   // every activity, including hidden — used for BY_ID lookups & admin management
  var DATA = [];  // visible activities — what students, the builder and filters see
  var BY_ID = {};
  var SEARCH_INDEX = {}; // normalized text + word index for smart search scoring
  var PRESENT = { topic: [], subtopic: [], type: [], progression: [], frequency: [] };

  // The spreadsheet's dropdown sheet reuses one 36-term vocabulary for both
  // Topics and Subtopics, so filter dropdowns are built from values actually
  // present in the data (ordered by the canonical taxonomy) to avoid dead ends.
  function distinctPresent(field) {
    var present = {};
    DATA.forEach(function (a) {
      if (field === "subtopic") (a.subtopics || []).forEach(function (s) { present[s] = true; });
      else if (a[field] != null) present[a[field]] = true;
    });
    return present;
  }
  function ordered(taxList, presentObj) {
    var out = taxList.filter(function (v) { return presentObj[v]; });
    Object.keys(presentObj).forEach(function (v) { if (out.indexOf(v) === -1) out.push(v); });
    return out;
  }
  // Case-insensitive alphabetical sort, returning a new array. Used for the
  // topic / subtopic / content-type lists so every dropdown reads A→Z.
  // (Progressions and frequencies keep their canonical taxonomy order.)
  function alpha(list) {
    return (list || []).slice().sort(function (a, b) {
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    });
  }
  // The effective, alphabetised vocabulary for a taxonomy kind ('topic' |
  // 'subtopic' | 'type'): the coach's CMS-managed list when they have one,
  // otherwise the built-in data.js fallback.
  function taxList(kind) {
    var tx = (state.tracking && state.tracking.taxonomy) || {};
    var managed = tx[kind];
    return alpha((managed && managed.length) ? managed : (TAX_FALLBACK[kind] || []));
  }
  function applyOverride(a, ov) {
    if (!ov) return a;
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    Object.keys(ov).forEach(function (k) { out[k] = ov[k]; });
    return out;
  }
  // Recompute the working sets from BASE + admin additions. Called once at
  // startup (after the store is loaded) and again whenever the admin adds,
  // edits, or hides an activity.
  function rebuildData() {
    var st = state.tracking;
    var overrides = st.overrides || {};
    var hidden = st.hidden || {};
    var custom = st.customActivities || [];
    var merged = BASE.map(function (a) { return applyOverride(a, overrides[a.id]); });
    custom.forEach(function (a) { merged.push(applyOverride(a, overrides[a.id])); });
    ALL = merged;
    BY_ID = {};
    SEARCH_INDEX = {};
    ALL.forEach(function (a) {
      BY_ID[a.id] = a;
      SEARCH_INDEX[a.id] = buildSearchIndex(a);
    });
    DATA = ALL.filter(function (a) { return !hidden[a.id]; });
    // Fold any CMS-managed vocabulary into TAX before deriving the filter lists.
    TAX.topics = taxList("topic");
    TAX.subtopics = taxList("subtopic");
    TAX.types = taxList("type");
    PRESENT = {
      topic: alpha(ordered(TAX.topics, distinctPresent("topic"))),
      subtopic: alpha(ordered(TAX.subtopics, distinctPresent("subtopic"))),
      type: alpha(ordered(TAX.types, distinctPresent("type"))),
      progression: ordered(TAX.progressions, distinctPresent("progression")),
      frequency: ordered(TAX.frequencies, distinctPresent("frequency"))
    };
  }
  function isHidden(id) { return !!(state.tracking.hidden && state.tracking.hidden[id]); }
  function isCustom(id) { return /^CUST-/.test(id); }
  // Subtopics that actually co-occur with a given topic in the visible data,
  // alphabetical. Empty topic → every present subtopic. Used to keep the
  // Topic→Subtopic dropdowns from offering choices that yield no results.
  function subtopicsForTopic(topic) {
    if (!topic) return PRESENT.subtopic.slice();
    var found = {};
    DATA.forEach(function (a) {
      if (a.topic === topic) (a.subtopics || []).forEach(function (s) { found[s] = true; });
    });
    return alpha(Object.keys(found));
  }

  /* ----------------------------- DOM helpers ----------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function option(value, label) { return el("option", { value: value }, label); }

  function norm(s) {
    return (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function searchText(a) {
    return [
      a.id,
      a.name,
      a.topic,
      (a.subtopics || []).join(" "),
      a.type,
      a.progression,
      a.frequency,
      a.time,
      a.instructions,
      a.reflection,
      a.link
    ].filter(Boolean).join(" ");
  }

  function tokenizeSearch(s) {
    return norm(s).replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  }

  function buildSearchIndex(a) {
    var hay = norm(searchText(a)).replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
    var seen = {};
    var words = [];
    hay.split(" ").forEach(function (w) {
      if (!w || seen[w]) return;
      seen[w] = true;
      words.push(w);
    });
    return { hay: hay, words: words };
  }

  function editDistanceAtMost(a, b, maxDist) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    var prev = [];
    var cur = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        var val = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
        cur[k] = val;
        if (val < rowMin) rowMin = val;
      }
      if (rowMin > maxDist) return maxDist + 1;
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  function fuzzyTokenHit(token, words) {
    if (!token || token.length < 4) return false;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w || Math.abs(w.length - token.length) > 2) continue;
      if (w.charAt(0) !== token.charAt(0)) continue;
      if (editDistanceAtMost(token, w, 2) <= 2) return true;
    }
    return false;
  }

  function smartSearchScore(a, query) {
    var q = norm(query || "").trim();
    if (!q) return 1;
    var idx = SEARCH_INDEX[a.id] || buildSearchIndex(a);
    var tokens = tokenizeSearch(q);
    if (!tokens.length) return 1;

    var score = 0;
    var matched = 0;
    if (idx.hay.indexOf(q) !== -1) score += 8;

    tokens.forEach(function (t) {
      if (idx.words.indexOf(t) !== -1) {
        matched++; score += 5; return;
      }
      if (idx.hay.indexOf(t) !== -1) {
        matched++; score += 3; return;
      }
      if (fuzzyTokenHit(t, idx.words)) {
        matched++; score += 1.6;
      }
    });

    if (!matched) return 0;
    var minNeeded = tokens.length === 1 ? 1 : Math.ceil(tokens.length * 0.6);
    if (matched < minNeeded) return 0;
    return score + (matched / tokens.length);
  }

  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ----------------------------- Server mode (Cloudflare API) -----------------------------
   * When the site is served by Cloudflare Pages, /api/* Functions back the app with a
   * shared D1 database and real, server-trusted sessions. The app boots by probing
   * GET /api/me: if the API answers, we run in SERVER mode (real login + shared data);
   * if it's unreachable (e.g. opened straight from file://), we fall back to the
   * original offline LOCAL mode (localStorage + the client passcode gate). */
  var SERVER = false;            // true once we confirm the API is reachable

  // Thin fetch wrapper. Resolves to { ok, status, data } and only rejects on a real
  // network failure (which is how we detect "no backend → run offline").
  function api(path, opts) {
    opts = opts || {};
    var init = { credentials: "same-origin", headers: { "Content-Type": "application/json" } };
    Object.keys(opts).forEach(function (k) { if (k !== "headers" && k !== "body") init[k] = opts[k]; });
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { init.headers[k] = opts.headers[k]; });
    if (opts.body != null) init.body = (typeof opts.body === "string") ? opts.body : JSON.stringify(opts.body);
    return fetch("/api" + path, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        if (t) { try { data = JSON.parse(t); } catch (e) {} }
        return { ok: r.ok, status: r.status, data: data };
      });
    });
  }
  function apiError(res, fallback) { return (res && res.data && res.data.error) || fallback; }

  // Pull the full snapshot the UI needs and load it into state.tracking, which uses
  // the exact same shape as the local store — so every render function works unchanged.
  // In SERVER mode the 190 base activities are the authoritative copy in D1. Pull them
  // and swap them in for the bundled data.js set; on any failure we keep the data.js copy
  // (identical content) so the app still works.
  function loadBaseActivities() {
    return api("/activities").then(function (res) {
      // Only adopt the D1 copy when it's at least as complete as the bundled set.
      // A short/partial response (corrupt or partially-seeded table) means we keep
      // the known-good data.js copy rather than render a missing-activities set.
      if (res.ok && res.data && Array.isArray(res.data.activities) && res.data.activities.length >= BASE.length) {
        BASE = res.data.activities;
      }
    }).catch(function () {});
  }
  function loadServerSnapshot() {
    return api("/bootstrap").then(function (res) {
      if (!res.ok || !res.data) throw new Error("bootstrap failed (" + res.status + ")");
      var d = res.data;
      state.session = d.me;
      state.coaches = d.coaches || [];
      state.admins = d.admins || [];
      state.superadmins = d.superadmins || [];
      state.templates = d.templates || [];
      state.tracking = normalizeStore({
        students: d.students || {},
        activeStudentId: d.activeStudentId || (state.tracking && state.tracking.activeStudentId) || null,
        customActivities: d.customActivities || [],
        overrides: d.overrides || {},
        hidden: d.hidden || {},
        taxonomy: d.taxonomy || { topic: [], subtopic: [], type: [] }
      });
      if (d.me.role === "athlete") {
        state.tracking.activeStudentId = d.me.id;
      } else if (!state.tracking.activeStudentId || !state.tracking.students[state.tracking.activeStudentId]) {
        state.tracking.activeStudentId = Object.keys(state.tracking.students)[0] || null;
      }
      rebuildData();
      return d;
    });
  }
  // Re-pull server state, then refresh dependent dropdowns. Callers re-render after.
  function refreshFromServer() {
    return loadServerSnapshot().then(function () { refreshSelects(); })
      .catch(function () { toast("Couldn't refresh from the server"); });
  }

  /* ----------------------------- Store / localStorage -----------------------------
   * v2 store holds everything the coach owns on this device: students (each with
   * their completions and assignments), admin-added custom activities, per-activity
   * overrides, hidden flags, and the admin passcode hash. v1 (student tracking only)
   * is migrated forward on first load. */
  var LS_KEY = "performancextra.store.v2";
  var LS_KEY_V1 = "performancextra.tracking.v1";
  var THEME_KEY = "performancextra.theme";
  var DEFAULT_PASSCODE = "pxadmin";
  var storageOK = true;

  function detectTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  function applyTheme(theme) {
    var next = theme === "light" ? "light" : "dark";
    document.body.setAttribute("data-theme", next);
    document.documentElement.style.colorScheme = next;
    var btn = $("#theme-toggle");
    if (btn) btn.textContent = next === "dark" ? "Light mode" : "Dark mode";
  }
  function toggleTheme() {
    var current = document.body.getAttribute("data-theme") || detectTheme();
    var next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  }

  function emptyStore() {
    return {
      version: 2, activeStudentId: null, students: {},
      customActivities: [], overrides: {}, hidden: {},
      taxonomy: { topic: [], subtopic: [], type: [] },
      settings: { passcodeHash: hashPasscode(DEFAULT_PASSCODE) }
    };
  }

  // Ensure every expected field exists (covers migrated / partial / imported data).
  function normalizeStore(obj) {
    var s = emptyStore();
    if (obj && typeof obj === "object") {
      if (obj.students && typeof obj.students === "object") s.students = obj.students;
      if (obj.activeStudentId) s.activeStudentId = obj.activeStudentId;
      if (Array.isArray(obj.customActivities)) s.customActivities = obj.customActivities;
      if (obj.overrides && typeof obj.overrides === "object") s.overrides = obj.overrides;
      if (obj.hidden && typeof obj.hidden === "object") s.hidden = obj.hidden;
      if (obj.taxonomy && typeof obj.taxonomy === "object") {
        ["topic", "subtopic", "type"].forEach(function (k) {
          if (Array.isArray(obj.taxonomy[k])) s.taxonomy[k] = obj.taxonomy[k];
        });
      }
      if (obj.settings && obj.settings.passcodeHash) s.settings.passcodeHash = obj.settings.passcodeHash;
    }
    // Every student needs completed, assignments, and per-item reflections.
    Object.keys(s.students).forEach(function (id) {
      var st = s.students[id];
      if (!st.completed || typeof st.completed !== "object") st.completed = {};
      if (!Array.isArray(st.assignments)) st.assignments = [];
      if (!st.reflections || typeof st.reflections !== "object") st.reflections = {};
      if (!Array.isArray(st.checkins)) st.checkins = [];
      if (!Array.isArray(st.journal)) st.journal = [];
      if (!Array.isArray(st.messages)) st.messages = [];
      if (typeof st.coachNote !== "string") st.coachNote = "";
    });
    return s;
  }

  function loadStore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return normalizeStore(JSON.parse(raw));
      // First run on v2: migrate any existing v1 tracking forward.
      var v1 = localStorage.getItem(LS_KEY_V1);
      if (v1) {
        var old = JSON.parse(v1);
        return normalizeStore({ students: old.students, activeStudentId: old.activeStudentId });
      }
      return emptyStore();
    } catch (e) {
      storageOK = false;
      return emptyStore();
    }
  }

  function saveStore() {
    // In SERVER mode the database is the source of truth; never mirror it to
    // localStorage (that would let stale device data shadow the shared state).
    if (SERVER || !storageOK) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.tracking)); }
    catch (e) { storageOK = false; $("#storage-warning").hidden = false; }
  }
  // Back-compat alias: lots of call sites persist via saveTracking().
  var saveTracking = saveStore;

  function genId() { return "stu_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function genActId() { return "CUST-" + Math.random().toString(36).slice(2, 7).toUpperCase(); }
  function genAsgId() { return "asg_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

  /* ----------------------------- Auth (client-side gate) -----------------------------
   * A small non-cryptographic hash gives light obfuscation of the passcode in
   * storage. This keeps honest students out of admin tools; it is not, and does
   * not claim to be, real server-side security on a static site. */
  function hashPasscode(s) {
    var h = 5381; s = String(s);
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return "h" + h.toString(36);
  }
  function passcodeHash() { return (state.tracking.settings && state.tracking.settings.passcodeHash) || hashPasscode(DEFAULT_PASSCODE); }
  function checkPasscode(input) { return hashPasscode(input) === passcodeHash(); }
  function setPasscode(input) {
    if (!state.tracking.settings) state.tracking.settings = {};
    state.tracking.settings.passcodeHash = hashPasscode(input);
    saveStore();
  }
  function isUsingDefaultPasscode() { return passcodeHash() === hashPasscode(DEFAULT_PASSCODE); }

  var AUTH_KEY = "performancextra.admin";
  function isAuthed() { try { return sessionStorage.getItem(AUTH_KEY) === "1"; } catch (e) { return state._authed === true; } }
  function setAuthed(on) {
    state._authed = !!on;
    try { if (on) sessionStorage.setItem(AUTH_KEY, "1"); else sessionStorage.removeItem(AUTH_KEY); } catch (e) {}
  }

  function students() { return state.tracking.students; }
  function studentList() {
    return Object.keys(students()).map(function (id) { return students()[id]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function activeStudent() {
    var id = state.tracking.activeStudentId;
    return id && students()[id] ? students()[id] : null;
  }
  function completedMap() {
    var s = activeStudent();
    return s ? s.completed : {};
  }

  // Mark/unmark an activity done for a student. Optimistically updates the in-memory
  // map (so the UI flips instantly), then persists: to the server (athlete only) in
  // SERVER mode, or to localStorage in LOCAL mode.
  function setCompletion(student, activityId, done, assignmentId) {
    if (!student) return;
    if (done) student.completed[activityId] = new Date().toISOString();
    else delete student.completed[activityId];
    if (SERVER) {
      api("/completions", {
        method: "POST",
        body: {
          activity_id: activityId,
          assignment_id: assignmentId || null,
          athlete_id: (state.session && state.session.role !== "athlete") ? student.id : null,
          done: done
        }
      })
        .then(function (res) { if (!res.ok) toast(apiError(res, "Couldn't save — please retry")); })
        .catch(function () { toast("Couldn't reach the server"); });
    } else {
      saveTracking();
    }
  }

  function reflectionKey(assignmentId, activityId) {
    return String(assignmentId || "") + "::" + String(activityId || "");
  }
  function ensureReflections(student) {
    if (!student.reflections || typeof student.reflections !== "object") student.reflections = {};
    return student.reflections;
  }
  function getReflectionEntry(student, assignmentId, activityId) {
    var map = ensureReflections(student);
    return map[reflectionKey(assignmentId, activityId)] || null;
  }
  function setReflectionEntry(student, assignmentId, activityId, text, updatedAt) {
    var map = ensureReflections(student);
    var key = reflectionKey(assignmentId, activityId);
    var clean = String(text || "").trim();
    if (!clean) {
      delete map[key];
      return;
    }
    map[key] = { text: clean, updatedAt: updatedAt || new Date().toISOString() };
  }
  function fmtDateTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch (e) {
      return (iso || "").slice(0, 16).replace("T", " ");
    }
  }
  function saveReflectionFlow(student, assignmentId, activityId, text, onDone) {
    if (!student) { if (onDone) onDone(false, "No student selected"); return; }
    var key = reflectionKey(assignmentId, activityId);
    var prev = getReflectionEntry(student, assignmentId, activityId);
    setReflectionEntry(student, assignmentId, activityId, text);

    if (!SERVER) {
      saveTracking();
      if (onDone) onDone(true);
      return;
    }
    if (!state.session || state.session.role !== "athlete") {
      if (prev) ensureReflections(student)[key] = prev; else delete ensureReflections(student)[key];
      if (onDone) onDone(false, "Only athletes can submit reflections");
      return;
    }
    api("/reflections", {
      method: "POST",
      body: { assignment_id: assignmentId, activity_id: activityId, text: String(text || "") }
    }).then(function (res) {
      if (!res.ok) {
        if (prev) ensureReflections(student)[key] = prev; else delete ensureReflections(student)[key];
        if (onDone) onDone(false, apiError(res, "Couldn't save reflection"));
        return;
      }
      var entry = getReflectionEntry(student, assignmentId, activityId);
      if (entry && res.data && res.data.updatedAt) entry.updatedAt = res.data.updatedAt;
      if (onDone) onDone(true);
    }).catch(function () {
      if (prev) ensureReflections(student)[key] = prev; else delete ensureReflections(student)[key];
      if (onDone) onDone(false, "Couldn't reach the server");
    });
  }

  function addStudent(name) {
    name = (name || "").trim();
    if (!name) return null;
    var id = genId();
    students()[id] = { id: id, name: name, createdAt: new Date().toISOString(), completed: {}, assignments: [], reflections: {} };
    if (!state.tracking.activeStudentId) state.tracking.activeStudentId = id;
    saveTracking();
    return id;
  }

  /* ----------------------------- Assignments ----------------------------- */
  function studentAssignments(s) { return (s && Array.isArray(s.assignments)) ? s.assignments : []; }

  function addAssignment(studentId, title, note, activityIds, dueAt) {
    var s = students()[studentId];
    if (!s) return null;
    if (!Array.isArray(s.assignments)) s.assignments = [];
    var items = (activityIds || []).filter(function (id) { return BY_ID[id]; });
    if (!items.length) return null;
    var asg = {
      id: genAsgId(),
      title: (title || "").trim() || "Workout",
      note: (note || "").trim(),
      createdAt: new Date().toISOString(),
      dueAt: dueAt || null,
      items: items
    };
    s.assignments.unshift(asg);
    saveTracking();
    return asg.id;
  }
  function deleteAssignment(studentId, asgId) {
    var s = students()[studentId];
    if (!s || !Array.isArray(s.assignments)) return;
    s.assignments = s.assignments.filter(function (a) { return a.id !== asgId; });
    var map = ensureReflections(s);
    Object.keys(map).forEach(function (k) {
      if (k.indexOf(asgId + "::") === 0) delete map[k];
    });
    saveTracking();
  }
  function assignmentProgress(s, asg) {
    var done = 0;
    asg.items.forEach(function (id) { if (s.completed[id]) done++; });
    return { done: done, total: asg.items.length };
  }

  // At-a-glance counts for a student's assignments: how many are still in progress
  // (not fully done) vs. fully completed, plus the timestamp of their most recent
  // completion. Used for the admin per-student summary line.
  function assignmentStatusSummary(s) {
    var list = studentAssignments(s);
    var completed = 0;
    list.forEach(function (asg) {
      var prog = assignmentProgress(s, asg);
      if (prog.total > 0 && prog.done === prog.total) completed++;
    });
    var times = Object.keys(s.completed || {})
      .map(function (id) { return s.completed[id]; })
      .filter(Boolean)
      .sort();
    return {
      total: list.length,
      completed: completed,
      inProgress: list.length - completed,
      lastActivity: times.length ? times[times.length - 1] : null
    };
  }

  function assignedActivityIds(student) {
    var out = {};
    studentAssignments(student).forEach(function (asg) {
      (asg.items || []).forEach(function (id) { if (BY_ID[id]) out[id] = true; });
    });
    return Object.keys(out);
  }

  // A coach can override an activity's link for one student within an assignment
  // (e.g. a doc in that student's private folder). itemLinks is a map of
  // { activityId: customUrl }; the custom URL wins over the activity default.
  function itemHasCustomLink(asg, id) {
    return !!(asg && asg.itemLinks && asg.itemLinks[id] && String(asg.itemLinks[id]).trim());
  }
  function itemLink(asg, id) {
    if (itemHasCustomLink(asg, id)) return String(asg.itemLinks[id]).trim();
    var a = BY_ID[id];
    return (a && a.link) || null;
  }
  // Set or clear a student-level custom URL for one activity. Scoped to (student,
  // activity), so it applies to every assignment of that activity for this student.
  // asgId is unused server-side but kept for call-site compatibility.
  function setItemLinkFlow(studentId, asgId, activityId, url, onDone) {
    var clean = (url == null ? "" : String(url)).trim();
    if (SERVER) {
      api("/athletes/" + encodeURIComponent(studentId) + "/links", {
        method: "POST", body: { activity_id: activityId, url: clean }
      }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save link")); return; }
        refreshFromServer().then(function () { if (onDone) onDone(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    var s = students()[studentId];
    if (!s) { toast("Student not found"); return; }
    // Store at the student level and mirror onto every assignment so itemLink() works.
    if (!s.activityLinks) s.activityLinks = {};
    if (clean) s.activityLinks[activityId] = clean; else delete s.activityLinks[activityId];
    studentAssignments(s).forEach(function (a) {
      if (!a.itemLinks) a.itemLinks = {};
      if (clean) a.itemLinks[activityId] = clean; else delete a.itemLinks[activityId];
    });
    saveTracking();
    if (onDone) onDone();
  }

  // Create an assignment, routing to the server in SERVER mode. onDone runs on success.
  function createAssignmentFlow(studentId, title, note, ids, onDone, dueAt) {
    if (SERVER) {
      api("/assignments", { method: "POST", body: { athlete_id: studentId, title: title, note: note, activity_ids: ids, due_at: dueAt || null } })
        .then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't create assignment")); return; }
          refreshFromServer().then(function () { if (onDone) onDone(); });
        }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (addAssignment(studentId, title, note, ids, dueAt)) { if (onDone) onDone(); }
    else { toast("Couldn't create assignment"); }
  }
  // A <input type="date"> value ("YYYY-MM-DD") -> the coach's LOCAL end-of-day as an
  // unambiguous UTC instant (…Z). Building the Date from local parts and calling
  // toISOString() bakes in the timezone offset, so an assignment due "today" only turns
  // overdue once the coach's local day is over (not at UTC midnight). Empty -> null.
  function dueInputToIso(v) {
    v = (v || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    var p = v.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 23, 59, 59).toISOString();
  }
  // An assignment is overdue when its due date has passed and it isn't fully complete;
  // "due soon" is the same but within the next 7 days. Both are in-app cues only.
  function assignmentDueState(s, asg) {
    if (!asg.dueAt) return "";
    var prog = assignmentProgress(s, asg);
    if (prog.total > 0 && prog.done === prog.total) return "";
    var t = new Date(asg.dueAt).getTime(), now = Date.now();
    if (t < now) return "overdue";
    if (t <= now + 7 * 864e5) return "soon";
    return "";
  }
  function deleteAssignmentFlow(studentId, asgId) {
    if (SERVER) {
      api("/assignments/" + encodeURIComponent(asgId), { method: "DELETE" }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
        refreshFromServer().then(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    deleteAssignment(studentId, asgId); renderAll();
  }

  /* ----------------------------- Custom activities / overrides / hidden ----------------------------- */
  function monthForWeek(week) {
    if (!week) return null;
    var m = (TAX.months || []).filter(function (x) { return (x.weeks || []).indexOf(week) !== -1; })[0];
    return m ? m.value : Math.ceil(week / 4);
  }
  // Coerce a raw form object into the canonical activity shape used everywhere.
  function normalizeActivity(o, id) {
    var week = o.week ? Number(o.week) : null;
    var tm = o.timeMinutes !== "" && o.timeMinutes != null ? Number(o.timeMinutes) : null;
    var subs = Array.isArray(o.subtopics) ? o.subtopics
      : String(o.subtopics || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    return {
      id: id,
      name: (o.name || "").trim(),
      topic: (o.topic || "").trim() || null,
      subtopics: subs,
      type: (o.type || "").trim() || null,
      week: week,
      progression: (o.progression || "").trim() || (week ? "Week " + week : null),
      month: o.month ? Number(o.month) : monthForWeek(week),
      frequency: (o.frequency || "").trim() || null,
      time: (o.time || "").trim() || null,
      timeMinutes: isNaN(tm) ? null : tm,
      link: (o.link || "").trim() || null,
      instructions: (o.instructions || "").trim() || null,
      reflection: (o.reflection || "").trim() || null
    };
  }
  function addCustomActivity(form) {
    var a = normalizeActivity(form, genActId());
    if (!a.name) return null;
    if (SERVER) {
      var payload = Object.assign({}, a); delete payload.id;
      api(cmsRoute("/custom-activities"), { method: "POST", body: { payload: payload } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save activity")); return; }
        afterCmsWrite(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return a.id;
    }
    state.tracking.customActivities.push(a);
    saveStore(); rebuildData();
    return a.id;
  }
  // Edit a custom activity in place; edit a built-in one via an override layer.
  function saveActivityEdit(id, form) {
    var fields = normalizeActivity(form, id);
    if (SERVER) {
      var body, path;
      if (isCustom(id)) {
        var payload = Object.assign({}, fields); delete payload.id;
        path = cmsRoute("/custom-activities"); body = { payload: Object.assign({ id: id }, payload) };
      } else {
        path = cmsRoute("/overrides"); body = { activity_id: id, payload: fields, hidden: cmsHidden(id) };
      }
      api(path, { method: "POST", body: body }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save changes")); return; }
        afterCmsWrite(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (isCustom(id)) {
      var list = state.tracking.customActivities;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i] = fields; break; }
      }
    } else {
      state.tracking.overrides[id] = fields;
    }
    saveStore(); rebuildData();
  }
  function resetActivityOverride(id) {
    if (SERVER) {
      api(cmsRoute("/overrides"), { method: "POST", body: { activity_id: id, payload: null, hidden: false } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't revert")); return; }
        afterCmsWrite(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    delete state.tracking.overrides[id]; saveStore(); rebuildData();
  }
  function setHidden(id, on) {
    if (SERVER) {
      // Preserve any existing edit payload while flipping the hidden flag (scope-aware:
      // in Global scope read the global override, not the merged/private one).
      var payload = (cmsGlobal() ? (cmsTrack().overrides || {}) : state.tracking.overrides)[id] || null;
      api(cmsRoute("/overrides"), { method: "POST", body: { activity_id: id, payload: payload, hidden: !!on } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't update")); return; }
        afterCmsWrite(function () { renderRepo(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (on) state.tracking.hidden[id] = true; else delete state.tracking.hidden[id];
    saveStore(); rebuildData();
  }
  function deleteCustomActivity(id) {
    if (SERVER) {
      api(cmsRoute("/custom-activities/" + encodeURIComponent(id)), { method: "DELETE" }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
        afterCmsWrite(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    state.tracking.customActivities = state.tracking.customActivities.filter(function (a) { return a.id !== id; });
    delete state.tracking.hidden[id];
    saveStore(); rebuildData();
  }

  /* ----------------------------- Taxonomy (CMS) ----------------------------- */
  function lc(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  // The list of values for a kind after an add / rename / remove edit.
  function nextTaxValues(kind, action, args) {
    var out = cmsTaxList(kind).slice();
    if (action === "add") {
      var v = (args.value || "").trim();
      if (v && out.map(lc).indexOf(lc(v)) === -1) out.push(v);
    } else if (action === "rename") {
      var to = (args.to || "").trim();
      out = out.map(function (x) { return lc(x) === lc(args.from) ? to : x; }).filter(Boolean);
    } else if (action === "remove") {
      out = out.filter(function (x) { return lc(x) !== lc(args.value); });
    }
    var seen = {};
    out = out.filter(function (x) { var k = lc(x); if (seen[k]) return false; seen[k] = true; return true; });
    return alpha(out);
  }
  // Apply a taxonomy edit: persist the new vocabulary and cascade the value
  // change onto existing activities. Routes to the server in SERVER mode.
  function taxonomyFlow(kind, action, args, onDone) {
    var values = nextTaxValues(kind, action, args);
    if (SERVER) {
      api(cmsRoute("/taxonomy"), { method: "POST", body: {
        kind: kind, action: action, value: args.value, from: args.from, to: args.to, values: values
      } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save")); afterCmsWrite(); return; }
        afterCmsWrite(function () { if (onDone) onDone(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (!state.tracking.taxonomy) state.tracking.taxonomy = { topic: [], subtopic: [], type: [] };
    state.tracking.taxonomy[kind] = values;
    if (action === "rename") cascadeTaxLocal(kind, args.from, args.to);
    else if (action === "remove") cascadeTaxLocal(kind, args.value, null);
    saveStore(); rebuildData(); refreshSelects();
    if (onDone) onDone();
  }
  // Rewrite (or remove, when `to` is null) a topic/subtopic/type value across
  // every activity in local mode: base activities via the override layer, and
  // custom activities / existing overrides in place.
  function cascadeTaxLocal(kind, from, to) {
    var field = kind === "type" ? "type" : (kind === "topic" ? "topic" : "subtopics");
    function mapValue(v) {
      if (field === "subtopics") {
        var arr = (v || []).map(function (x) { return lc(x) === lc(from) ? to : x; }).filter(Boolean);
        var seen = {}; return arr.filter(function (x) { var k = lc(x); if (seen[k]) return false; seen[k] = true; return true; });
      }
      return lc(v) === lc(from) ? to : v;
    }
    function affected(a) {
      if (field === "subtopics") return (a.subtopics || []).some(function (x) { return lc(x) === lc(from); });
      return lc(a[field]) === lc(from);
    }
    BASE.forEach(function (a) {
      var merged = applyOverride(a, state.tracking.overrides[a.id]);
      if (!affected(merged)) return;
      var ov = Object.assign({}, state.tracking.overrides[a.id] || {});
      ov[field] = mapValue(merged[field]);
      state.tracking.overrides[a.id] = ov;
    });
    (state.tracking.customActivities || []).forEach(function (a) {
      if (affected(a)) a[field] = mapValue(a[field]);
    });
    Object.keys(state.tracking.overrides).forEach(function (id) {
      var ov = state.tracking.overrides[id];
      if (ov && ov[field] != null && affected(ov)) ov[field] = mapValue(ov[field]);
    });
  }

  function renameStudent(id, name) {
    name = (name || "").trim();
    if (students()[id] && name) { students()[id].name = name; saveTracking(); }
  }
  function deleteStudent(id) {
    delete students()[id];
    if (state.tracking.activeStudentId === id) {
      var rest = Object.keys(students());
      state.tracking.activeStudentId = rest.length ? rest[0] : null;
    }
    saveTracking();
  }
  function setActiveStudent(id) {
    state.tracking.activeStudentId = id || null;
    saveTracking();
  }

  function computeProgress(student) {
    var ids = Object.keys(student.completed);
    var byTopic = {}, byWeek = {};
    ids.forEach(function (aid) {
      var a = BY_ID[aid];
      if (!a) return;
      if (a.topic) byTopic[a.topic] = (byTopic[a.topic] || 0) + 1;
      var wk = a.week ? "Week " + a.week : "Extra Activities";
      byWeek[wk] = (byWeek[wk] || 0) + 1;
    });
    return { total: ids.length, byTopic: byTopic, byWeek: byWeek };
  }

  /* ----------------------------- State ----------------------------- */
  var state = {
    tab: "repo",
    view: "student",        // "admin" once authed; "student" otherwise (or coach preview)
    session: null,          // server-trusted {id,name,role} when SERVER mode is active
    showHidden: false,      // admin toggle to surface hidden activities in the repo
    reflectionTimers: {},
    filters: { search: "", topic: "", subtopic: "", type: "", progression: "", frequency: "" },
    tracking: loadStore(),
    coaches: [], admins: [], superadmins: [],   // staff rosters, populated on bootstrap
    templates: [],          // reusable assignment templates (coach), from bootstrap
    globalTracking: null    // global-library-only snapshot, lazy-loaded for the super-admin Content "Global" scope
  };
  rebuildData();
  saveStore();   // persist normalization / v1→v2 migration so it survives even if nothing else changes

  function isAdminView() { return state.view === "admin"; }

  /* ----------------------------- Role tier (client) -----------------------------
   * Mirrors the server's strict ladder coach < admin < super admin. The server is
   * the only authority (every staff route re-checks the session); these helpers just
   * decide which tabs/controls to show. In LOCAL mode there's no session, so admin-view
   * counts as "coach" and the staff features (which are SERVER-only) stay hidden. */
  var ROLE_RANK_C = { athlete: 0, coach: 1, admin: 2, superadmin: 3 };
  function sessionRole() { return (state.session && state.session.role) || (isAdminView() ? "coach" : "athlete"); }
  function rankC(r) { return ROLE_RANK_C[r] != null ? ROLE_RANK_C[r] : -1; }
  function isAtLeast(r) { return rankC(sessionRole()) >= rankC(r); }
  function isAtLeastAdmin() { return SERVER && isAtLeast("admin"); }
  function isSuperadmin() { return SERVER && sessionRole() === "superadmin"; }

  // Which content library the CMS flows write to. "private" -> the caller's own content
  // (/custom-activities, /overrides, /taxonomy); "global" -> the shared library an
  // admin/super admin curates (/global/*). Set by the Content tab's scope switch and
  // reset to "private" whenever we leave the Content tab, so Repository edits never
  // accidentally hit the global library.
  var currentCmsTarget = "private";
  function cmsRoute(p) { return currentCmsTarget === "global" ? ("/global" + p) : p; }
  function cmsGlobal() { return currentCmsTarget === "global"; }

  // Lazily fetch the global-library-ONLY content for the super-admin Content "Global"
  // scope, kept separate from state.tracking (which is the merged catalog every coach
  // sees). Editing in Global scope reads AND writes only this snapshot, so a super
  // admin's own private items can never leak into the shared library.
  function loadGlobalTracking() {
    return Promise.all([
      api("/global/custom-activities"),
      api("/global/overrides"),
      api("/global/taxonomy")
    ]).then(function (rs) {
      var ca = (rs[0] && rs[0].ok && rs[0].data && rs[0].data.customActivities) || [];
      var ov = (rs[1] && rs[1].ok && rs[1].data) || {};
      var tx = (rs[2] && rs[2].ok && rs[2].data && rs[2].data.taxonomy) || {};
      state.globalTracking = {
        customActivities: ca,
        overrides: ov.overrides || {},
        hidden: ov.hidden || {},
        taxonomy: { topic: tx.topic || [], subtopic: tx.subtopic || [], type: tx.type || [] }
      };
    }).catch(function () {
      state.globalTracking = { customActivities: [], overrides: {}, hidden: {}, taxonomy: { topic: [], subtopic: [], type: [] } };
    });
  }
  function cmsTrack() { return cmsGlobal() ? (state.globalTracking || { customActivities: [], overrides: {}, hidden: {}, taxonomy: {} }) : state.tracking; }
  // Scope-aware reads for the CMS table. In Global scope they come from the global-only
  // snapshot; otherwise from the merged catalog (ALL/DATA/isHidden/taxList) as before.
  function cmsActivityRows(showHidden) {
    if (!cmsGlobal()) return (showHidden ? ALL : DATA).slice();
    var gt = cmsTrack(), ov = gt.overrides || {}, hid = gt.hidden || {}, cust = gt.customActivities || [];
    var merged = BASE.map(function (a) { return applyOverride(a, ov[a.id]); });
    cust.forEach(function (a) { merged.push(applyOverride(a, ov[a.id])); });
    return showHidden ? merged : merged.filter(function (a) { return !hid[a.id]; });
  }
  function cmsHidden(id) { if (!cmsGlobal()) return isHidden(id); return !!(cmsTrack().hidden || {})[id]; }
  function cmsTaxList(kind) {
    if (!cmsGlobal()) return taxList(kind);
    var m = (cmsTrack().taxonomy || {})[kind];
    return alpha((m && m.length) ? m : (TAX_FALLBACK[kind] || []));
  }
  function cmsTaxUsage(kind) {
    var counts = {}, field = kind === "type" ? "type" : (kind === "topic" ? "topic" : "subtopics");
    cmsActivityRows(true).forEach(function (a) {
      if (field === "subtopics") (a.subtopics || []).forEach(function (s) { counts[lc(s)] = (counts[lc(s)] || 0) + 1; });
      else if (a[field] != null) counts[lc(a[field])] = (counts[lc(a[field])] || 0) + 1;
    });
    return counts;
  }
  // Scope-aware single-activity lookup for the CMS edit form. In Global scope the form
  // must initialize from the GLOBAL snapshot's view (global override on a base activity,
  // or a global custom), NOT BY_ID (the merged private+global catalog) — otherwise saving
  // would write a super admin's private values into the shared library.
  function cmsActivityById(id) {
    if (!cmsGlobal()) return BY_ID[id];
    return cmsActivityRows(true).filter(function (a) { return a.id === id; })[0] || BY_ID[id];
  }
  // After a CMS write, refresh the merged catalog; in Global scope also invalidate the
  // global-only snapshot so the next render re-fetches it (keeping the table truthful).
  function afterCmsWrite(cb) {
    return refreshFromServer().then(function () {
      if (cmsGlobal()) state.globalTracking = null;
      if (cb) cb();
    });
  }

  /* ----------------------------- Repository ----------------------------- */
  function applyFilters() {
    var f = state.filters;
    var q = norm(f.search).trim();
    // Admins can opt to see hidden activities (to unhide/edit them); everyone
    // else only ever sees the visible set.
    var source = (isAdminView() && state.showHidden) ? ALL : DATA;
    var out = [];
    source.forEach(function (a) {
      if (f.topic && a.topic !== f.topic) return false;
      if (f.subtopic && (a.subtopics || []).indexOf(f.subtopic) === -1) return false;
      if (f.type && a.type !== f.type) return false;
      if (f.progression && a.progression !== f.progression) return false;
      if (f.frequency && a.frequency !== f.frequency) return false;
      if (q) {
        var score = smartSearchScore(a, q);
        if (score <= 0) return false;
        out.push({ a: a, score: score });
      } else {
        out.push({ a: a, score: 0 });
      }
    });
    if (!q) return out.map(function (x) { return x.a; });
    out.sort(function (x, y) {
      return y.score - x.score || x.a.name.localeCompare(y.a.name);
    });
    return out.map(function (x) { return x.a; });
  }

  function detailBlock(label, text) {
    return el("div", { class: "detail-block" }, [
      el("div", { class: "detail-label" }, label),
      el("div", { class: "detail-text" }, text)
    ]);
  }

  function createCard(a) {
    var hidden = isHidden(a.id);
    var card = el("article", { class: "card" + (hidden ? " is-hidden-activity" : ""), "data-id": a.id });

    card.appendChild(el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h3", { class: "card-title" }, a.name),
        el("div", { class: "card-id" }, a.id)
      ]),
      el("span", { class: "badge", "data-type": a.type || "" }, a.type || "—")
    ]));

    var chips = el("div", { class: "chips" });
    if (isCustom(a.id)) chips.appendChild(el("span", { class: "tag-custom" }, "Custom"));
    if (hidden) chips.appendChild(el("span", { class: "tag-hidden" }, "Hidden"));
    if (a.topic) chips.appendChild(el("span", { class: "chip chip--topic" }, a.topic));
    (a.subtopics || []).forEach(function (s) { chips.appendChild(el("span", { class: "chip chip--sub" }, s)); });
    chips.appendChild(el("span", { class: "chip" }, a.progression || "—"));
    if (a.time) chips.appendChild(el("span", { class: "chip chip--meta" }, a.time));
    if (a.frequency) chips.appendChild(el("span", { class: "chip chip--meta" }, a.frequency));
    card.appendChild(chips);

    if (a.instructions || a.reflection) {
      var det = el("details", { class: "detail" }, el("summary", {}, "Instructions & reflection"));
      if (a.instructions) det.appendChild(detailBlock("Instructions", a.instructions));
      if (a.reflection) det.appendChild(detailBlock("Reflection prompt", a.reflection));
      card.appendChild(det);
    }

    // The Repository is the shared activity catalog (coach-only tab). Completion is a
    // per-student, per-assignment fact, so it is NOT shown here — it lives in the
    // student's My Workouts and the admin's per-student Students/Progress views.
    var foot = el("div", { class: "card-foot" });
    if (a.link) {
      foot.appendChild(el("a", { class: "btn btn--sm btn--primary", href: a.link, target: "_blank", rel: "noopener" }, "Open resource ↗"));
    } else {
      foot.appendChild(el("span", { class: "no-link" }, "No link (on-court)"));
    }
    card.appendChild(foot);

    if (isAdminView()) {
      var admin = el("div", { class: "card-admin" }, [
        el("button", { class: "btn btn--sm", onclick: function () { openActivityModal(a.id); } }, "✎ Edit"),
        el("button", { class: "btn btn--sm", onclick: function () { setHidden(a.id, !hidden); renderRepo(); toast(hidden ? "Activity shown" : "Activity hidden"); } }, hidden ? "↺ Unhide" : "Hide"),
        el("button", { class: "btn btn--sm btn--accent", onclick: function () { openAssignModal([a.id], a.name); } }, "Assign…")
      ]);
      if (isCustom(a.id)) {
        admin.appendChild(el("button", { class: "btn btn--sm btn--danger", onclick: function () {
          if (confirm("Delete custom activity “" + a.name + "”?")) { deleteCustomActivity(a.id); renderRepo(); toast("Custom activity deleted"); }
        } }, "Delete"));
      } else if (state.tracking.overrides[a.id]) {
        admin.appendChild(el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
          resetActivityOverride(a.id); renderRepo(); toast("Reverted to original");
        } }, "Reset edits"));
      }
      card.appendChild(admin);
    }

    return card;
  }

  function renderRepo() {
    var results = applyFilters();
    var grid = $("#repo-grid");
    grid.textContent = "";
    $("#result-count").innerHTML = "Showing <strong>" + results.length + "</strong> of " + (isAdminView() && state.showHidden ? ALL.length : DATA.length) + " activities";

    if (!results.length) {
      grid.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No activities match these filters"),
        el("p", {}, "Try removing a filter or clearing your search."),
        el("button", { class: "btn btn--ghost", onclick: clearFilters }, "Clear filters")
      ]));
      return;
    }
    var frag = document.createDocumentFragment();
    results.forEach(function (a) { frag.appendChild(createCard(a)); });
    grid.appendChild(frag);
  }

  function clearFilters() {
    state.filters = { search: "", topic: "", subtopic: "", type: "", progression: "", frequency: "" };
    $("#f-search").value = "";
    ["topic", "subtopic", "type", "progression", "frequency"].forEach(function (k) { $("#f-" + k).value = ""; });
    // Topic is now empty, so restore the full subtopic list.
    syncSubtopicSelect($("#f-topic"), $("#f-subtopic"), "All subtopics");
    renderRepo();
  }

  /* ----------------------------- Workout Builder ----------------------------- */
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  var TYPE_ORDER = { Exercise: 0, Breathing: 0, Meditation: 1, Video: 2, Blog: 3, Article: 3, Book: 4, Module: 4 };

  function candidatePool(c) {
    var pool = DATA.slice();
    if (c.scope === "month" && c.month) {
      var m = TAX.months.filter(function (x) { return x.value === c.month; })[0];
      var weeks = m ? m.weeks : [];
      pool = pool.filter(function (a) { return weeks.indexOf(a.week) !== -1; });
    } else if (c.scope === "week" && c.week) {
      pool = pool.filter(function (a) { return a.week === c.week; });
    }
    if (c.topic) pool = pool.filter(function (a) { return a.topic === c.topic; });
    if (c.subtopic) pool = pool.filter(function (a) { return a.subtopics.indexOf(c.subtopic) !== -1; });
    if (c.type) pool = pool.filter(function (a) { return a.type === c.type; });
    if (c.excludeCompleted) {
      var done = completedMap();
      pool = pool.filter(function (a) { return !done[a.id]; });
    }
    return pool;
  }

  function selectWorkout(pool, c) {
    var shuffled = shuffle(pool.slice());
    var chosen = [];
    if (c.mix) {
      var groups = {};
      shuffled.forEach(function (a) { (groups[a.type] = groups[a.type] || []).push(a); });
      var types = Object.keys(groups);
      var i = 0, guard = 0;
      while (chosen.length < c.count && guard < 1000) {
        guard++;
        var t = types[i % types.length];
        if (groups[t] && groups[t].length) chosen.push(groups[t].shift());
        i++;
        if (types.every(function (k) { return !groups[k].length; })) break;
      }
    } else {
      chosen = shuffled.slice(0, c.count);
    }
    // Respect a time budget if one was given (items with unknown time count as 0).
    if (c.timeBudget > 0) {
      var total = 0, within = [];
      chosen.forEach(function (a) {
        var m = a.timeMinutes || 0;
        if (total + m <= c.timeBudget) { within.push(a); total += m; }
      });
      chosen = within;
    }
    chosen.sort(function (a, b) {
      var oa = TYPE_ORDER[a.type] == null ? 5 : TYPE_ORDER[a.type];
      var ob = TYPE_ORDER[b.type] == null ? 5 : TYPE_ORDER[b.type];
      return oa - ob || (a.week || 99) - (b.week || 99);
    });
    return chosen;
  }

  function downloadFile(filename, content, mime) {
    var blob = new Blob([content], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // Copy arbitrary text to the clipboard, with a legacy fallback for older browsers.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function assignmentToText(student, asg) {
    var lines = [];
    lines.push("PERFORMANCEXTRA — ASSIGNED WORKOUT");
    lines.push("Athlete: " + student.name);
    lines.push("Assignment: " + asg.title);
    lines.push("Assigned: " + fmtDate(asg.createdAt) + (asg.dueAt ? " · Due: " + fmtDate(asg.dueAt) : ""));
    if (asg.note) {
      lines.push("");
      lines.push("Coach note:");
      lines.push(asg.note);
    }
    lines.push("");
    asg.items.forEach(function (id, idx) {
      var a = BY_ID[id];
      if (!a) return;
      var meta = [a.type || "—", a.time || ""].filter(Boolean).join(", ");
      lines.push((idx + 1) + ". " + a.name + " [" + meta + "]");
      lines.push("   Status: " + (student.completed[id] ? "Completed" : "Pending"));
      lines.push("   Link: " + (itemLink(asg, id) || "No link (on-court)"));
      if (a.instructions) lines.push("   Instructions: " + a.instructions.replace(/\n/g, "\n      "));
      if (a.reflection) lines.push("   Reflection prompt: " + a.reflection.replace(/\n/g, "\n      "));

      lines.push("");
    });
    var asgRefl = getReflectionEntry(student, asg.id, "__assignment__");
    if (asgRefl && asgRefl.text) {
      lines.push("ASSIGNMENT REFLECTION:");
      lines.push(asgRefl.text.replace(/\n/g, "\n   "));
      lines.push("Submitted: " + fmtDateTime(asgRefl.updatedAt));
      lines.push("");
    }
    return lines.join("\n");
  }
  function safeFilePart(v) {
    return String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "assignment";
  }
  function downloadAssignmentTxt(student, asg) {
    var date = new Date().toISOString().slice(0, 10);
    var filename = "performancextra-" + safeFilePart(student.name) + "-" + safeFilePart(asg.title) + "-" + date + ".txt";
    downloadFile(filename, assignmentToText(student, asg), "text/plain");
    toast("Assignment downloaded (.txt)");
  }
  // Generate a polished single-assignment PDF block used by the all-assignments export.
  function appendAssignmentPdfBlock(doc, student, asg, ctx) {
    var pageW = ctx.pageW;
    var pageH = ctx.pageH;
    var marginX = ctx.marginX;
    var lineH = ctx.lineH;
    var ensureSpace = ctx.ensureSpace;
    var yRef = ctx.yRef;

    function textBlock(lines, x, y, opts) {
      opts = opts || {};
      if (opts.font) doc.setFont("helvetica", opts.font);
      if (opts.size) doc.setFontSize(opts.size);
      if (opts.color) doc.setTextColor(opts.color[0], opts.color[1], opts.color[2]);
      doc.text(lines, x, y);
      if (opts.color) doc.setTextColor(17, 24, 39);
      return y + (lines.length * lineH);
    }

    function drawLinedBox(x, y, width, height) {
      doc.setDrawColor(148, 163, 184);
      doc.rect(x, y, width, height);
      var lineY = y + 16;
      while (lineY < y + height - 6) {
        doc.line(x + 8, lineY, x + width - 8, lineY);
        lineY += 16;
      }
    }

    var title = asg.title;
    var headerWidth = pageW - marginX * 2;
    var titleLines = doc.splitTextToSize(title, headerWidth - 22);
    var subLines = doc.splitTextToSize(
      "Assigned " + fmtDate(asg.createdAt) + (asg.dueAt ? "  ·  Due " + fmtDate(asg.dueAt) : "") + "  ·  " + asg.items.length + " activities",
      headerWidth - 22
    );
    var noteLines = asg.note ? doc.splitTextToSize(asg.note, headerWidth - 22) : [];
    var headerHeight = 26 + (titleLines.length * lineH) + (subLines.length * lineH) + (noteLines.length ? (12 + noteLines.length * lineH) : 0);

    var cardHeight = headerHeight + 14;
    ensureSpace(cardHeight + 10);

    var y = yRef.value;
    doc.setDrawColor(163, 190, 36);
    doc.setFillColor(244, 251, 220);
    doc.roundedRect(marginX, y, headerWidth, headerHeight, 9, 9, "FD");

    var cy = y + 18;
    cy = textBlock(titleLines, marginX + 11, cy, { font: "bold", size: 12.5 });
    cy += 2;
    cy = textBlock(subLines, marginX + 11, cy, { font: "normal", size: 9.5, color: [55, 65, 81] });

    if (noteLines.length) {
      cy += 5;
      cy = textBlock(["Coach plan:"], marginX + 11, cy, { font: "bold", size: 9.5, color: [194, 65, 12] });
      cy = textBlock(noteLines, marginX + 11, cy + 1, { font: "normal", size: 9.2, color: [30, 41, 59] });
    }

    yRef.value = y + headerHeight + 12;

    asg.items.forEach(function (id, idx) {
      var a = BY_ID[id];
      if (!a) return;

      var prompt = a.reflection || "Write your reflection for this activity.";
      var done = !!student.completed[id];
      var doneText = done ? ("Completed on " + fmtDate(student.completed[id])) : "Not marked completed";
      var itemTitle = (idx + 1) + ". " + a.name;
      var meta = [
        a.type || "Activity",
        a.topic || null,
        (a.subtopics || []).length ? ("Subtopics: " + a.subtopics.join(", ")) : null,
        a.progression || null,
        a.frequency || null,
        a.time || null
      ].filter(Boolean).join("  |  ");
      var linkText = itemLink(asg, id) || "No external link (coach-led or on-court activity)";
      var instructionText = a.instructions || "No additional instructions provided.";
      var existing = getReflectionEntry(student, asg.id, id);
      var submittedLines = (existing && existing.text)
        ? doc.splitTextToSize("Existing reflection: " + existing.text, headerWidth - 42)
        : [];

      var itemTitleLines = doc.splitTextToSize(itemTitle, headerWidth - 42);
      var metaLines = doc.splitTextToSize(meta, headerWidth - 42);
      var statusLines = doc.splitTextToSize("Status: " + doneText, headerWidth - 42);
      var linkLines = doc.splitTextToSize("Resource link: " + linkText, headerWidth - 42);
      var instLabel = ["Instructions:"];
      var instLines = doc.splitTextToSize(instructionText, headerWidth - 42);
      var promptLabel = ["Reflection prompt:"];
      var promptLines = doc.splitTextToSize(prompt, headerWidth - 42);

      var writingBoxH = 84;
      var itemHeight = 28
        + (itemTitleLines.length * lineH)
        + (metaLines.length * lineH)
        + (statusLines.length * lineH)
        + (linkLines.length * lineH)
        + lineH
        + (instLines.length * lineH)
        + lineH
        + (promptLines.length * lineH)
        + (submittedLines.length ? (lineH + submittedLines.length * lineH) : 0)
        + 10
        + writingBoxH
        + 12;

      ensureSpace(itemHeight + 8);

      var iy = yRef.value;
      doc.setDrawColor(203, 213, 225);
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(marginX, iy, headerWidth, itemHeight, 8, 8, "FD");

      var ty = iy + 18;
      ty = textBlock(itemTitleLines, marginX + 12, ty, { font: "bold", size: 10.5 });
      ty += 1;
      ty = textBlock(metaLines, marginX + 12, ty, { font: "normal", size: 8.7, color: [71, 85, 105] });
      ty += 1;
      ty = textBlock(statusLines, marginX + 12, ty, { font: "bold", size: 8.7, color: done ? [21, 128, 61] : [180, 83, 9] });
      ty += 1;
      ty = textBlock(linkLines, marginX + 12, ty, { font: "normal", size: 8.5, color: [37, 99, 235] });
      ty += 4;
      ty = textBlock(instLabel, marginX + 12, ty, { font: "bold", size: 9.3 });
      ty = textBlock(instLines, marginX + 12, ty, { font: "normal", size: 8.8 });
      ty += 3;
      ty = textBlock(promptLabel, marginX + 12, ty, { font: "bold", size: 9.3 });
      ty = textBlock(promptLines, marginX + 12, ty, { font: "normal", size: 8.8 });

      if (submittedLines.length) {
        ty += 3;
        ty = textBlock(submittedLines, marginX + 12, ty, { font: "normal", size: 8.5, color: [15, 118, 110] });
      }

      ty += 6;
      textBlock(["Reflection response:"], marginX + 12, ty, { font: "bold", size: 9.2 });
      drawLinedBox(marginX + 12, ty + 4, headerWidth - 24, writingBoxH);

      yRef.value = iy + itemHeight + 8;
    });

    var asgReflection = getReflectionEntry(student, asg.id, "__assignment__");
    var asgReflectionText = asgReflection && asgReflection.text
      ? doc.splitTextToSize("Existing assignment reflection: " + asgReflection.text, headerWidth - 24)
      : [];
    var assignmentBoxH = 92 + (asgReflectionText.length ? (asgReflectionText.length * lineH + 8) : 0);
    ensureSpace(assignmentBoxH + 10);
    var ay = yRef.value;
    doc.setDrawColor(251, 146, 60);
    doc.setFillColor(255, 247, 237);
    doc.roundedRect(marginX, ay, headerWidth, assignmentBoxH, 8, 8, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.8);
    doc.text("Assignment-level reflection", marginX + 12, ay + 16);
    if (asgReflectionText.length) {
      textBlock(asgReflectionText, marginX + 12, ay + 30, { font: "normal", size: 8.5, color: [124, 45, 18] });
    }
    drawLinedBox(marginX + 12, ay + assignmentBoxH - 58, headerWidth - 24, 44);
    yRef.value = ay + assignmentBoxH + 14;

    ensureSpace(18);
    doc.setDrawColor(226, 232, 240);
    doc.line(marginX, yRef.value, pageW - marginX, yRef.value);
    yRef.value += 10;
  }

  function downloadAllAssignmentsPdf(student) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast("PDF generator unavailable on this device");
      return;
    }

    var list = studentAssignments(student);
    if (!list.length) { toast("No assignments to download"); return; }

    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var marginX = 44;
    var topY = 44;
    var bottomY = pageH - 54;
    var yRef = { value: topY };
    var lineH = 14;

    function ensureSpace(heightNeeded) {
      if (yRef.value + heightNeeded <= bottomY) return;
      doc.addPage();
      yRef.value = topY;
      drawRunningHeader();
    }

    function drawRunningHeader() {
      doc.setFillColor(12, 16, 25);
      doc.rect(0, 0, pageW, 34, "F");
      doc.setFont("helvetica", "bold");
      doc.setTextColor(224, 231, 239);
      doc.setFontSize(9);
      doc.text("PerformanceXtra Assignment Sheet", marginX, 22);
      doc.setTextColor(107, 114, 128);
      doc.setFont("helvetica", "normal");
      doc.text("Student: " + student.name, pageW - marginX, 22, { align: "right" });
      doc.setTextColor(17, 24, 39);
    }

    function drawFooter(pageNum, totalPages) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text("Generated " + fmtDateTime(new Date().toISOString()), marginX, pageH - 20);
      doc.text("Page " + pageNum + " of " + totalPages, pageW - marginX, pageH - 20, { align: "right" });
      doc.setTextColor(17, 24, 39);
    }

    drawRunningHeader();

    doc.setFillColor(201, 242, 78);
    doc.roundedRect(marginX, yRef.value, pageW - marginX * 2, 86, 12, 12, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(20, 24, 10);
    doc.text("Assigned Workouts", marginX + 16, yRef.value + 28);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Student: " + student.name, marginX + 16, yRef.value + 48);
    doc.text("Workouts: " + list.length, marginX + 16, yRef.value + 64);
    doc.text("Generated: " + fmtDate(new Date().toISOString()), marginX + 16, yRef.value + 78);

    yRef.value += 106;
    doc.setTextColor(17, 24, 39);

    list.forEach(function (asg) {
      appendAssignmentPdfBlock(doc, student, asg, {
        pageW: pageW,
        pageH: pageH,
        marginX: marginX,
        lineH: lineH,
        yRef: yRef,
        ensureSpace: ensureSpace
      });
    });

    var totalPages = doc.getNumberOfPages();
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      drawFooter(p, totalPages);
    }

    var date = new Date().toISOString().slice(0, 10);
    var filename = "performancextra-" + safeFilePart(student.name) + "-all-assignments-" + date + ".pdf";
    doc.save(filename);
    toast("All assignments downloaded (.pdf)");
  }

  function downloadAllAssignmentsTxt(student) {
    var list = studentAssignments(student);
    if (!list.length) { toast("No assignments to download"); return; }
    var sections = list.map(function (asg) { return assignmentToText(student, asg); });
    var date = new Date().toISOString().slice(0, 10);
    var filename = "performancextra-" + safeFilePart(student.name) + "-all-assignments-" + date + ".txt";
    downloadFile(filename, sections.join("\n" + "=".repeat(60) + "\n\n"), "text/plain");
    toast("All assignments downloaded (.txt)");
  }
  function legacyCopy(text) {
    var ta = el("textarea", {}, text);
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  /* ----------------------------- Exports (T8) ----------------------------- */
  // Build a clean, printable single-assignment view and trigger the browser's
  // print/"Save as PDF" dialog. Reuses the same print isolation as the builder.
  function printAssignment(student, asg) {
    var area = $("#print-area");
    area.textContent = "";
    area.appendChild(el("h1", { class: "pa-title" }, asg.title));
    var sub = "For " + student.name + " · Assigned " + fmtDate(asg.createdAt) + (asg.dueAt ? " · Due " + fmtDate(asg.dueAt) : "");
    area.appendChild(el("div", { class: "pa-sub" }, sub));
    if (asg.note) area.appendChild(noteNode(asg.note, "pa-note", "p"));
    var ol = el("ol", { class: "pa-list" });
    asg.items.forEach(function (id) {
      var a = BY_ID[id];
      if (!a) return;
      var li = el("li", {});
      li.appendChild(el("div", { class: "pa-name" }, a.name + (a.time ? " (" + a.time + ")" : "") + (student.completed[id] ? "  ✓ done" : "")));
      var meta = [a.type, a.topic, a.progression, a.frequency].filter(Boolean).join(" · ");
      if (meta) li.appendChild(el("div", { class: "pa-meta" }, meta));
      var paLink = itemLink(asg, id);
      if (paLink) li.appendChild(el("div", { class: "pa-link" }, paLink));
      if (a.instructions) li.appendChild(detailBlock("Instructions", a.instructions));
      if (a.reflection) li.appendChild(detailBlock("Reflection prompt", a.reflection));
      ol.appendChild(li);
    });
    area.appendChild(ol);
    document.body.classList.add("printing-assignment");
    window.print();
    setTimeout(function () { document.body.classList.remove("printing-assignment"); }, 500);
  }

  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function lastActivityDate(s) {
    var times = Object.keys(s.completed).map(function (k) { return s.completed[k]; }).filter(Boolean).sort();
    return times.length ? fmtDate(times[times.length - 1]) : "—";
  }
  // Coach roster/progress export: one row per assignment (or per athlete if none).
  function exportRosterCSV() {
    var rows = [["Athlete", "Assignment", "Items", "Completed", "Percent", "Last activity"]];
    studentList().forEach(function (s) {
      var asgs = studentAssignments(s);
      var last = lastActivityDate(s);
      if (!asgs.length) {
        rows.push([s.name, "(no assignments)", "0", "0", "0%", last]);
      } else {
        asgs.forEach(function (asg) {
          var prog = assignmentProgress(s, asg);
          var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
          rows.push([s.name, asg.title, String(prog.total), String(prog.done), pct + "%", last]);
        });
      }
    });
    var csv = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    downloadFile("performancextra-roster-" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv");
    toast("Roster exported");
  }

  /* ----------------------------- Students ----------------------------- */
  function renderStudents() {
    var list = $("#student-list");
    list.textContent = "";
    var all = studentList();
    if (!all.length) {
      list.appendChild(el("p", { class: "no-link" }, "No students yet. Add one below to start tracking."));
    }
    all.forEach(function (s) {
      var active = state.tracking.activeStudentId === s.id;
      var nameKids = [el("span", { class: "name" }, s.name)];
      var unreadMsgs = threadUnread(s, "athlete");
      if (unreadMsgs) nameKids.push(el("span", { class: "msg-badge", title: unreadMsgs + " unread message" + (unreadMsgs === 1 ? "" : "s") }, "✉ " + unreadMsgs));
      if (SERVER && s.email) {
        nameKids.push(el("span", { class: "student-email", title: "Signs in with this email" }, s.email));
      }
      // At-a-glance dashboard stat: completion across all assigned work + check-in streak.
      var totalI = 0, doneI = 0;
      (s.assignments || []).forEach(function (a) { (a.items || []).forEach(function (id) { totalI++; if (s.completed[id]) doneI++; }); });
      var statBits = [];
      if (totalI) statBits.push(Math.round(doneI / totalI * 100) + "% done");
      var stk = checkinStreak(s.checkins);
      if (stk > 1) statBits.push(stk + "d streak");
      if (statBits.length) nameKids.push(el("span", { class: "student-stat" }, statBits.join(" · ")));
      var row = el("div", { class: "student-row" + (active ? " is-active" : "") }, [
        el("span", { class: "name-wrap" }, nameKids)
      ]);
      var rowActions = el("div", { class: "student-row-actions" });
      rowActions.appendChild(el("button", {
        class: "btn btn--sm btn--ghost", title: "Set active",
        "aria-pressed": active ? "true" : "false",
        onclick: function () { setActiveStudent(s.id); renderAll(); }
      }, active ? "● Active" : "○ Set active"));
      if (SERVER) {
        rowActions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new passcode to email this athlete", "aria-label": "Reset passcode for " + s.name, onclick: function () { resetPasscode(s); } }, "↻ Reset passcode"));
        rowActions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this athlete and all their data", "aria-label": "Delete " + s.name, onclick: function () { deleteAthleteServer(s); } }, "✕ Delete"));
      } else {
        rowActions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Rename", "aria-label": "Rename " + s.name, onclick: function () {
          var name = prompt("Rename student", s.name);
          if (name) { renameStudent(s.id, name); renderAll(); }
        } }, "✎"));
        rowActions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete", "aria-label": "Delete " + s.name, onclick: function () {
          if (confirm("Delete " + s.name + " and their progress?")) { deleteStudent(s.id); renderAll(); }
        } }, "✕"));
      }
      row.appendChild(rowActions);
      list.appendChild(row);
    });

    renderStudentDetail();
    renderNeedsAttention();
  }

  // Coach overview: athletes with overdue work, a stale check-in, a low recent mood, or
  // unread messages — a single glance so nothing slips. In-app only (no email reminders).
  function renderNeedsAttention() {
    var host = $("#needs-attention");
    if (!host) return;
    host.textContent = "";
    var items = [];
    studentList().forEach(function (s) {
      var reasons = [];
      var overdue = (s.assignments || []).filter(function (a) { return assignmentDueState(s, a) === "overdue"; }).length;
      if (overdue) reasons.push(overdue + " overdue");
      var latest = s.checkins && s.checkins[0];
      if (latest && latest.day) {
        var days = Math.floor((Date.now() - new Date(latest.day + "T12:00:00").getTime()) / 864e5);
        if (days >= 7) reasons.push("no check-in " + days + "d");
      }
      if (latest && latest.mood != null && latest.mood <= 2) reasons.push("low mood");
      var unread = threadUnread(s, "athlete");
      if (unread) reasons.push(unread + " unread");
      if (reasons.length) items.push({ s: s, reasons: reasons });
    });
    if (!items.length) return;
    var panel = el("div", { class: "panel attention-panel" });
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Needs attention"),
      el("span", { class: "cms-count" }, items.length + " athlete" + (items.length === 1 ? "" : "s"))
    ]));
    items.forEach(function (it) {
      var openIt = function () { setActiveStudent(it.s.id); renderAll(); };
      panel.appendChild(el("div", { class: "attention-row", role: "button", tabindex: "0", title: "Open " + it.s.name, onclick: openIt, onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } } }, [
        el("span", { class: "attention-name" }, it.s.name),
        el("span", { class: "attention-reasons" }, it.reasons.join(" · "))
      ]));
    });
    host.appendChild(panel);
  }

  function bars(map, total) {
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    var max = keys.reduce(function (m, k) { return Math.max(m, map[k]); }, 1);
    var wrap = el("div", {});
    keys.forEach(function (k) {
      wrap.appendChild(el("div", { class: "bar-row" }, [
        el("span", {}, k),
        el("span", { class: "track" }, el("span", { style: "width:" + (map[k] / max * 100) + "%" })),
        el("span", { class: "num" }, String(map[k]))
      ]));
    });
    return wrap;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return (iso || "").slice(0, 10); }
  }

  // Shared progress block — used by the admin Students detail and the student
  // My Progress tab.
  function appendProgress(container, s) {
    var assigned = assignedActivityIds(s);
    var assignedMap = {};
    assigned.forEach(function (id) { assignedMap[id] = true; });

    // Progress is always measured against what has actually been assigned to
    // this athlete (not the whole ~188-activity catalogue), for the coach and
    // athlete views alike.
    var p = computeProgress({ completed: Object.keys(s.completed).reduce(function (acc, id) {
      if (assignedMap[id]) acc[id] = s.completed[id];
      return acc;
    }, {}) });

    var denom = assigned.length;
    if (!denom) {
      container.appendChild(el("p", { class: "no-link" }, "No activities assigned yet — progress will appear here once this athlete has a workout."));
      return;
    }
    var pct = denom ? Math.round(p.total / denom * 100) : 0;
    container.appendChild(el("div", { class: "progress-stat" }, [
      el("span", { class: "big" }, String(p.total)),
      el("span", {}, "of " + denom + " assigned activities completed (" + pct + "%)")
    ]));
    container.appendChild(el("div", { class: "progress-bar" }, el("span", { style: "width:" + pct + "%" })));

    if (p.total) {
      container.appendChild(el("div", { class: "breakdown" }, [
        el("div", {}, [el("div", { class: "detail-label", style: "margin-bottom:8px" }, "By topic"), bars(p.byTopic)]),
        el("div", {}, [el("div", { class: "detail-label", style: "margin-bottom:8px" }, "By progression"), bars(p.byWeek)])
      ]));

      var canUndo = !SERVER || (state.session && state.session.role === "athlete");
      var showCondensedAdmin = isAdminView() && (!SERVER || (state.session && state.session.role === "coach"));
      // For the coach/admin view we no longer repeat a completed-workouts list here:
      // completed assignments are already consolidated into the single collapsible in
      // the assignment list above. The student My Progress tab keeps its flat list.
      if (!showCondensedAdmin) {
        container.appendChild(el("div", { class: "detail-label", style: "margin-bottom:8px" }, "Completed activities"));
        var cl = el("div", { class: "completed-list" });
        Object.keys(s.completed)
          .filter(function (aid) { return assignedMap[aid]; })
          .sort(function (a, b) { return (s.completed[b] || "").localeCompare(s.completed[a] || ""); })
          .forEach(function (aid) {
            var a = BY_ID[aid];
            if (!a) return;
            cl.appendChild(el("div", { class: "completed-row" }, [
              el("span", { class: "badge", "data-type": a.type || "" }, a.type || "—"),
              el("span", { class: "c-name" }, a.name),
              canUndo ? el("button", { class: "btn btn--sm btn--ghost", title: "Un-complete", onclick: function () {
                setCompletion(s, aid, false, null); renderAll();
              } }, "Undo") : null
            ]));
          });
        container.appendChild(cl);
      }
    } else {
      container.appendChild(el("p", { class: "no-link" }, "No assigned activities completed yet."));
    }
  }

  // Render a student's assignments. opts.admin adds a delete control; opts.actionable
  // adds per-item "Mark done" buttons (used in the student's My Workouts tab).
  function appendAssignmentList(container, s, opts) {
    opts = opts || {};
    var list = studentAssignments(s);
    if (!list.length) {
      container.appendChild(el("p", { class: "no-link" }, opts.admin
        ? "No assignments yet. Create one to give this student a focused set of activities."
        : "No workouts assigned yet. Ask your coach for your next set."));
      return;
    }
    function buildAssignmentCard(asg) {
      var prog = assignmentProgress(s, asg);
      var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
      var complete = prog.total > 0 && prog.done === prog.total;
      var card = el("div", { class: "assignment" });

      var actions = el("div", { class: "assignment-actions" });
      if (opts.admin) {
        if (SERVER) actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Save this set as a reusable template", onclick: function () {
          saveTemplate(asg.title, asg.note || "", asg.items);
        } }, "★ Template"));
        actions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete assignment", "aria-label": "Delete assignment", onclick: function () {
          if (confirm("Delete assignment “" + asg.title + "”?")) { deleteAssignmentFlow(s.id, asg.id); }
        } }, "✕"));
      }
      // Audit trail (T12): assigned on / due by / completed on.
      var metaParts = ["Assigned " + fmtDate(asg.createdAt)];
      if (asg.dueAt) metaParts.push("Due " + fmtDate(asg.dueAt));
      if (complete) {
        var times = asg.items.map(function (id) { return s.completed[id]; }).filter(Boolean).sort();
        if (times.length) metaParts.push("Completed " + fmtDate(times[times.length - 1]));
      }
      var dueState = assignmentDueState(s, asg);
      var dueChip = dueState === "overdue" ? el("span", { class: "due-chip due-chip--overdue" }, "Overdue")
        : (dueState === "soon" ? el("span", { class: "due-chip due-chip--soon" }, "Due soon") : null);
      card.appendChild(el("div", { class: "assignment-head" }, [
        el("div", {}, [
          el("div", { class: "assignment-title" }, [asg.title, dueChip]),
          asg.note ? noteNode(asg.note) : null,
          el("div", { class: "assignment-meta" }, metaParts.join(" · "))
        ]),
        actions
      ]));
      card.appendChild(el("div", { class: "assignment-status" + (complete ? " is-complete" : "") },
        complete ? "✓ All done" : prog.done + " of " + prog.total + " done"));
      card.appendChild(el("div", { class: "assignment-bar" }, el("span", { style: "width:" + pct + "%" })));

      asg.items.forEach(function (id) {
        var a = BY_ID[id];
        if (!a) return;
        var done = !!s.completed[id];
        var item = el("div", { class: "assign-item" + (done ? " is-done" : "") });
        item.appendChild(el("span", { class: "ai-name" }, [
          el("strong", {}, a.name), a.time ? (" · " + a.time) : "", a.type ? (" · " + a.type) : ""
        ]));
        var link = itemLink(asg, id);
        if (link) item.appendChild(el("a", { class: "btn btn--sm" + (itemHasCustomLink(asg, id) ? " has-custom-link" : ""), href: link, target: "_blank", rel: "noopener", title: itemHasCustomLink(asg, id) ? "Custom link for this student" : "" }, "Open ↗"));
        if (opts.admin) {
          var hasCustom = itemHasCustomLink(asg, id);
          item.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: hasCustom ? "Edit this student's custom link" : "Set a custom link for this student", onclick: function () {
            openItemLinkModal(s.id, asg, id);
          } }, hasCustom ? "🔗 Edit link" : "🔗 Custom link"));
        }
        if (opts.actionable || opts.admin) {
          var btn = el("button", { class: "btn btn--sm done-btn", "aria-pressed": done ? "true" : "false", onclick: function () {
            setCompletion(s, id, !s.completed[id], asg.id);
            renderAll();
          } }, done ? "✓ Done" : (opts.admin ? "Mark done" : "Mark done"));
          item.appendChild(btn);
        }
        // Show the activity's instructions & reflection inline so the athlete (and
        // the coach reviewing) can read them without opening the repository card.
        if (a.instructions || a.reflection) {
          var det = el("details", { class: "detail", style: "width:100%; margin-top:6px;" },
            el("summary", {}, "Instructions & reflection"));
          if (a.instructions) det.appendChild(detailBlock("Instructions", a.instructions));
          if (a.reflection) det.appendChild(detailBlock("Reflection prompt", a.reflection));
          item.appendChild(det);
        }

        card.appendChild(item);
      });

      // Assignment-level reflection textbox (student) or read-only view (coach).
      var ASSIGN_REFL_KEY = "__assignment__";
      if (opts.actionable) {
        var asgRefl = getReflectionEntry(s, asg.id, ASSIGN_REFL_KEY);
        var asgTa = el("textarea", {
          class: "reflection-input",
          placeholder: "Write your overall reflection for this assignment here\u2026",
          "aria-label": "Assignment reflection for " + asg.title
        });
        asgTa.value = asgRefl && asgRefl.text ? asgRefl.text : "";
        var asgStatus = el("div", { class: "reflection-status" }, asgRefl && asgRefl.updatedAt
          ? ("Saved " + fmtDateTime(asgRefl.updatedAt))
          : "Not submitted yet");
        asgTa.addEventListener("input", function () {
          var timerKey = [s.id, asg.id, ASSIGN_REFL_KEY].join("::");
          clearTimeout(state.reflectionTimers[timerKey]);
          asgStatus.textContent = "Saving...";
          state.reflectionTimers[timerKey] = setTimeout(function () {
            saveReflectionFlow(s, asg.id, ASSIGN_REFL_KEY, asgTa.value, function (ok, msg) {
              if (ok) {
                var latest = getReflectionEntry(s, asg.id, ASSIGN_REFL_KEY);
                asgStatus.textContent = latest && latest.updatedAt ? ("Saved " + fmtDateTime(latest.updatedAt)) : "Not submitted yet";
              } else {
                asgStatus.textContent = msg || "Could not save";
                toast(msg || "Couldn't save reflection");
              }
            });
          }, 450);
        });
        card.appendChild(el("div", { class: "reflection-box assignment-reflection" }, [
          el("div", { class: "detail-label" }, "Your reflection for this assignment"),
          asgTa,
          asgStatus
        ]));
      }
      if (opts.admin) {
        var asgReflAdmin = getReflectionEntry(s, asg.id, ASSIGN_REFL_KEY);
        card.appendChild(el("div", { class: "reflection-read assignment-reflection" }, [
          el("div", { class: "detail-label" }, "Student reflection"),
          el("div", { class: "detail-text" }, asgReflAdmin && asgReflAdmin.text ? asgReflAdmin.text : "No reflection submitted yet."),
          asgReflAdmin && asgReflAdmin.updatedAt ? el("div", { class: "assignment-meta", style: "margin-top:6px" }, "Updated " + fmtDateTime(asgReflAdmin.updatedAt)) : null
        ]));
      }
      return card;
    }

    function isAssignmentComplete(asg) {
      var prog = assignmentProgress(s, asg);
      return prog.total > 0 && prog.done === prog.total;
    }

    // On the admin/coach side, collapse fully-completed assignments into one
    // expandable section so the coach doesn't scroll past finished work to find
    // what's still in progress.
    if (opts.admin) {
      var activeAsgs = list.filter(function (asg) { return !isAssignmentComplete(asg); });
      var doneAsgs = list.filter(isAssignmentComplete);
      if (!activeAsgs.length) {
        container.appendChild(el("p", { class: "no-link" }, "No assignments in progress \u2014 everything assigned is complete."));
      }
      activeAsgs.forEach(function (asg) { container.appendChild(buildAssignmentCard(asg)); });
      if (doneAsgs.length) {
        var doneTimes = [];
        doneAsgs.forEach(function (asg) {
          (asg.items || []).forEach(function (id) { if (s.completed[id]) doneTimes.push(s.completed[id]); });
        });
        doneTimes.sort();
        var lastDone = doneTimes.length ? doneTimes[doneTimes.length - 1] : null;
        var det = el("details", { class: "completed-assignments" });
        det.appendChild(el("summary", { class: "completed-assignments-summary" }, [
          el("span", { class: "ca-title" }, "Completed assignments"),
          el("span", { class: "ca-meta" }, String(doneAsgs.length) + (doneAsgs.length === 1 ? " assignment" : " assignments") + (lastDone ? " · last " + fmtDate(lastDone) : ""))
        ]));
        var body = el("div", { class: "completed-assignments-body" });
        doneAsgs.forEach(function (asg) { body.appendChild(buildAssignmentCard(asg)); });
        det.appendChild(body);
        container.appendChild(det);
      }
      return;
    }

    list.forEach(function (asg) { container.appendChild(buildAssignmentCard(asg)); });
  }

  function renderStudentDetail() {
    var detail = $("#student-detail");
    detail.textContent = "";
    var s = activeStudent();
    if (!s) {
      detail.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No student selected"),
        el("p", {}, "Add a student, then set them active to assign work and see progress.")
      ]));
      return;
    }
    var headActions = el("div", { class: "section-head-actions" }, [
      el("button", { class: "btn btn--sm", title: "Download all assignments as .pdf", onclick: function () { downloadAllAssignmentsPdf(s); } }, "⬇ Download all as PDF"),
      el("button", { class: "btn btn--sm", title: "Download all assignments as .txt", onclick: function () { downloadAllAssignmentsTxt(s); } }, "⬇ Download all as TXT"),
      el("button", { class: "btn btn--sm btn--accent", onclick: function () { openAssignBuilderModal(s.id); } }, "+ New assignment")
    ]);
    detail.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, s.name + " — Assignments"),
      headActions
    ]));
    if (studentAssignments(s).length) {
      var sum = assignmentStatusSummary(s);
      var summaryParts = [
        el("span", { class: "asg-summary-item" }, sum.inProgress + " in progress"),
        el("span", { class: "asg-summary-sep" }, "·"),
        el("span", { class: "asg-summary-item" }, sum.completed + " completed")
      ];
      if (sum.lastActivity) {
        summaryParts.push(el("span", { class: "asg-summary-sep" }, "·"));
        summaryParts.push(el("span", { class: "asg-summary-item" }, "last activity " + fmtDate(sum.lastActivity)));
      }
      detail.appendChild(el("div", { class: "asg-summary" }, summaryParts));
    }
    appendAssignmentList(detail, s, { admin: true });

    detail.appendChild(el("h3", { style: "margin:24px 0 14px" }, "Progress"));
    appendProgress(detail, s);
    appendWellbeing(detail, s);
    appendCoachComms(detail, s);
  }

  /* ----------------------------- Student views ----------------------------- */
  function renderWorkoutsTab() {
    var panel = $("#workouts-panel");
    panel.textContent = "";
    var s = activeStudent();
    if (!s) {
      panel.appendChild(el("div", { class: "panel" }, el("div", { class: "empty-state" }, [
        el("h3", {}, "No student selected"),
        el("p", {}, "Ask your coach to set you up. (Coach? Use “Admin login”, top right.)")
      ])));
      return;
    }
    appendAssignmentList(panel, s, { actionable: true });
  }

  function renderProgressTab() {
    var panel = $("#progress-panel");
    panel.textContent = "";
    var s = activeStudent();
    if (!s) {
      panel.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No student selected"),
        el("p", {}, "Ask your coach to set you up. (Coach? Use “Admin login”, top right.)")
      ]));
      return;
    }
    panel.appendChild(el("h3", { style: "margin-bottom:14px" }, s.name + " — Progress"));
    appendProgress(panel, s);
  }

  /* ----------------------------- Check-ins & journal ----------------------------- */
  var CHECKIN_DIMS = [
    { key: "mood", label: "Mood", low: "Tough", high: "Great" },
    { key: "energy", label: "Energy", low: "Drained", high: "Energized" },
    { key: "stress", label: "Stress", low: "Calm", high: "Stressed" }
  ];
  function todayKey() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function fmtDay(day) {
    try { return new Date(day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    catch (e) { return day; }
  }
  function scoreText(v) { return v == null ? "—" : String(v); }
  function todaysCheckin(s) {
    var t = todayKey();
    return (s.checkins || []).filter(function (c) { return c.day === t; })[0] || null;
  }
  // Consecutive days with a check-in, counting back from today (or yesterday, so a
  // streak isn't "broken" simply because today's check-in hasn't happened yet).
  function checkinStreak(checkins) {
    if (!checkins || !checkins.length) return 0;
    var days = {};
    checkins.forEach(function (c) { if (c.day) days[c.day] = true; });
    function key(dt) { function p(n) { return (n < 10 ? "0" : "") + n; } return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()); }
    var d = new Date(); d.setHours(12, 0, 0, 0);
    if (!days[key(d)]) d.setDate(d.getDate() - 1);
    var n = 0;
    while (days[key(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function checkinAverages(list) {
    function avg(key) {
      var vals = list.map(function (c) { return c[key]; }).filter(function (v) { return v != null; });
      if (!vals.length) return "—";
      return (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(1);
    }
    return { mood: avg("mood"), energy: avg("energy"), stress: avg("stress") };
  }
  function checkinRow(c) {
    return el("div", { class: "checkin-history-row" }, [
      el("span", { class: "ch-date" }, fmtDay(c.day)),
      el("span", { class: "ch-scores" }, "Mood " + scoreText(c.mood) + " · Energy " + scoreText(c.energy) + " · Stress " + scoreText(c.stress)),
      c.note ? el("span", { class: "ch-note" }, c.note) : null
    ]);
  }

  // Athlete's own daily check-in + journal (the "Check-in" tab).
  function renderCheckinTab() {
    var panel = $("#checkin-panel");
    if (!panel) return;
    panel.textContent = "";
    var s = activeStudent();
    if (!s) {
      panel.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No check-in yet"),
        el("p", {}, "Ask your coach to set you up to start checking in.")
      ]));
      return;
    }
    var today = todaysCheckin(s);
    var picked = { mood: today ? today.mood : null, energy: today ? today.energy : null, stress: today ? today.stress : null };

    var card = el("div", { class: "panel checkin-card" });
    card.appendChild(el("h3", {}, today ? "Update today’s check-in" : "How are you today?"));
    CHECKIN_DIMS.forEach(function (dim) {
      var scale = el("div", { class: "checkin-scale" });
      [1, 2, 3, 4, 5].forEach(function (n) {
        var btn = el("button", { type: "button", class: "checkin-dot" + (picked[dim.key] === n ? " is-on" : ""), "aria-label": dim.label + " " + n + " of 5", "aria-pressed": picked[dim.key] === n ? "true" : "false", onclick: function () {
          picked[dim.key] = (picked[dim.key] === n ? null : n);
          $all(".checkin-dot", scale).forEach(function (b, i) { var on = picked[dim.key] === (i + 1); b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
        } }, String(n));
        scale.appendChild(btn);
      });
      card.appendChild(el("div", { class: "checkin-dim" }, [
        el("div", { class: "checkin-dim-head" }, [
          el("span", { class: "checkin-dim-label" }, dim.label),
          el("span", { class: "checkin-dim-ends" }, dim.low + " → " + dim.high)
        ]),
        scale
      ]));
    });
    var note = el("textarea", { class: "checkin-note", placeholder: "Anything on your mind? (optional)" });
    if (today && today.note) note.value = today.note;
    card.appendChild(el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]));
    card.appendChild(el("button", { class: "btn btn--accent", onclick: function () {
      saveCheckin({ mood: picked.mood, energy: picked.energy, stress: picked.stress, note: note.value.trim() });
    } }, today ? "Update check-in" : "Save check-in"));
    panel.appendChild(card);

    var streak = checkinStreak(s.checkins);
    var recent = (s.checkins || []).slice(0, 14);
    var hist = el("div", { class: "panel" });
    hist.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Recent check-ins"),
      streak > 1 ? el("span", { class: "checkin-streak" }, "🔥 " + streak + "-day streak") : null
    ]));
    if (!recent.length) hist.appendChild(el("p", { class: "no-link" }, "No check-ins yet — your first one is above."));
    else recent.forEach(function (c) { hist.appendChild(checkinRow(c)); });
    panel.appendChild(hist);

    var jpanel = el("div", { class: "panel" });
    jpanel.appendChild(el("h3", {}, "Journal"));
    jpanel.appendChild(el("p", { class: "field-hint" }, "Write a longer reflection whenever you want. Your coach can read these to support you."));
    var jbody = el("textarea", { class: "checkin-note", placeholder: "Write a journal entry…" });
    jpanel.appendChild(jbody);
    jpanel.appendChild(el("button", { class: "btn btn--accent", onclick: function () {
      var v = jbody.value.trim();
      if (!v) { jbody.focus(); return; }
      addJournalEntry(v);
    } }, "Add entry"));
    var jlist = el("div", { class: "journal-list" });
    if (!(s.journal || []).length) jlist.appendChild(el("p", { class: "no-link" }, "No journal entries yet."));
    (s.journal || []).forEach(function (j) {
      jlist.appendChild(el("div", { class: "journal-entry" }, [
        el("div", { class: "journal-meta" }, fmtDate(j.createdAt)),
        el("div", { class: "journal-body" }, j.body),
        el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete entry", onclick: function () {
          if (confirm("Delete this journal entry?")) deleteJournalEntry(j.id);
        } }, "Delete")
      ]));
    });
    jpanel.appendChild(jlist);
    panel.appendChild(jpanel);
  }

  // Coach's read-only Wellbeing view of an athlete (Students detail).
  function appendWellbeing(container, s) {
    var checkins = s.checkins || [], journal = s.journal || [];
    if (!checkins.length && !journal.length) return;
    container.appendChild(el("h3", { style: "margin:24px 0 14px" }, "Wellbeing"));
    if (checkins.length) {
      var latest = checkins[0], avg = checkinAverages(checkins.slice(0, 14)), streak = checkinStreak(checkins);
      var head = el("div", { class: "wellbeing-summary" }, [
        el("span", { class: "wb-chip" }, "Latest " + fmtDay(latest.day) + " — Mood " + scoreText(latest.mood) + " · Energy " + scoreText(latest.energy) + " · Stress " + scoreText(latest.stress)),
        el("span", { class: "wb-chip" }, "14-day avg — Mood " + avg.mood + " · Energy " + avg.energy + " · Stress " + avg.stress),
        streak > 1 ? el("span", { class: "wb-chip" }, "🔥 " + streak + "-day streak") : null
      ]);
      container.appendChild(head);
      var list = el("div", { class: "wellbeing-list" });
      checkins.slice(0, 10).forEach(function (c) { list.appendChild(checkinRow(c)); });
      container.appendChild(list);
    }
    if (journal.length) {
      container.appendChild(el("div", { class: "detail-label", style: "margin:14px 0 8px" }, "Journal"));
      var jl = el("div", { class: "journal-list" });
      journal.slice(0, 10).forEach(function (j) {
        jl.appendChild(el("div", { class: "journal-entry" }, [
          el("div", { class: "journal-meta" }, fmtDate(j.createdAt)),
          el("div", { class: "journal-body" }, j.body)
        ]));
      });
      container.appendChild(jl);
    }
  }

  function saveCheckin(scores) {
    var s = activeStudent(); if (!s) return;
    var day = todayKey();
    if (SERVER) {
      api("/checkins", { method: "POST", body: { day: day, mood: scores.mood, energy: scores.energy, stress: scores.stress, note: scores.note } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save check-in")); return; }
        refreshFromServer().then(function () { renderAll(); toast("Check-in saved — thanks for showing up"); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    s.checkins = (s.checkins || []).filter(function (c) { return c.day !== day; });
    s.checkins.unshift({ day: day, mood: scores.mood, energy: scores.energy, stress: scores.stress, note: scores.note, updatedAt: new Date().toISOString() });
    saveStore(); renderAll(); toast("Check-in saved");
  }
  function addJournalEntry(body) {
    var s = activeStudent(); if (!s) return;
    if (SERVER) {
      api("/journal", { method: "POST", body: { body: body } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save entry")); return; }
        refreshFromServer().then(function () { renderAll(); toast("Journal entry added"); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    s.journal = s.journal || [];
    s.journal.unshift({ id: "J-" + Date.now(), body: body, createdAt: new Date().toISOString() });
    saveStore(); renderAll(); toast("Journal entry added");
  }
  function deleteJournalEntry(id) {
    var s = activeStudent(); if (!s) return;
    if (SERVER) {
      api("/journal/" + encodeURIComponent(id), { method: "DELETE" }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
        refreshFromServer().then(function () { renderAll(); toast("Entry deleted"); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    s.journal = (s.journal || []).filter(function (j) { return j.id !== id; });
    saveStore(); renderAll(); toast("Entry deleted");
  }

  /* ----------------------------- Messaging & coach notes ----------------------------- */
  function threadUnread(s, otherSender) {
    return ((s && s.messages) || []).filter(function (m) { return m.sender === otherSender && !m.readAt; }).length;
  }
  function messageThreadPanel(s) {
    var wrap = el("div", { class: "msg-thread" });
    var msgs = (s && s.messages) || [];
    if (!msgs.length) { wrap.appendChild(el("p", { class: "no-link" }, "No messages yet. Say hello 👋")); return wrap; }
    msgs.forEach(function (m) {
      wrap.appendChild(el("div", { class: "msg msg--" + (m.sender === "coach" ? "coach" : "athlete") + (m.readAt ? "" : " is-unread") }, [
        el("div", { class: "msg-body" }, m.body),
        el("div", { class: "msg-meta" }, (m.sender === "coach" ? "Coach" : "Athlete") + " · " + fmtDate(m.createdAt))
      ]));
    });
    return wrap;
  }
  function composeRow(onSend) {
    var ta = el("textarea", { class: "msg-input", placeholder: "Write a message…" });
    var btn = el("button", { class: "btn btn--accent", onclick: function () {
      var v = ta.value.trim(); if (!v) { ta.focus(); return; } onSend(v);
    } }, "Send");
    return el("div", { class: "msg-compose" }, [ta, btn]);
  }

  // Athlete's "Messages" tab — their thread with their coach.
  function renderMessagesTab() {
    var panel = $("#messages-panel");
    if (!panel) return;
    panel.textContent = "";
    var s = activeStudent();
    if (!s) {
      panel.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No messages"),
        el("p", {}, "Ask your coach to set you up.")
      ]));
      return;
    }
    if (state.tab === "messages") markThreadRead(s);   // only when the tab is actually open
    var card = el("div", { class: "panel" });
    card.appendChild(el("h3", {}, "Messages with your coach"));
    card.appendChild(messageThreadPanel(s));
    card.appendChild(composeRow(function (v) { sendMessage(v); }));
    panel.appendChild(card);
  }

  // Coach's per-athlete private note + message thread (Students detail).
  function appendCoachComms(container, s) {
    container.appendChild(el("h3", { style: "margin:24px 0 12px" }, "Private note"));
    container.appendChild(el("p", { class: "field-hint" }, "Only you can see this — the athlete never does."));
    var note = el("textarea", { class: "msg-input", placeholder: "A private note about this athlete…" });
    note.value = s.coachNote || "";
    container.appendChild(note);
    container.appendChild(el("button", { class: "btn btn--sm", style: "margin-top:8px", onclick: function () { saveAthleteNote(s.id, note.value.trim()); } }, "Save note"));

    container.appendChild(el("h3", { style: "margin:24px 0 12px" }, "Messages"));
    if (state.tab === "students") markThreadRead(s);   // only when the Students tab is open
    container.appendChild(messageThreadPanel(s));
    container.appendChild(composeRow(function (v) { sendMessage(v); }));
  }

  function sendMessage(body) {
    var s = activeStudent(); if (!s) return;
    if (SERVER) {
      var payload = isAdminView() ? { athlete_id: s.id, body: body } : { body: body };
      api("/messages", { method: "POST", body: payload }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't send")); return; }
        refreshFromServer().then(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    s.messages = s.messages || [];
    s.messages.push({ id: "M-" + Date.now(), sender: isAdminView() ? "coach" : "athlete", body: body, createdAt: new Date().toISOString(), readAt: null });
    saveStore(); renderAll();
  }
  function saveAthleteNote(athleteId, note) {
    if (SERVER) {
      api("/athlete-note", { method: "POST", body: { athlete_id: athleteId, note: note } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save note")); return; }
        refreshFromServer().then(function () { renderAll(); toast("Note saved"); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    var s = students()[athleteId]; if (s) { s.coachNote = note; saveStore(); }
    toast("Note saved");
  }
  // Optimistically mark the OTHER party's messages read + tell the server. No re-render
  // here (it's called mid-render); the cleared state shows on the next natural render.
  function markThreadRead(s) {
    s = s || activeStudent(); if (!s || !s.messages) return;
    var other = isAdminView() ? "athlete" : "coach";
    var changed = false;
    s.messages.forEach(function (m) { if (m.sender === other && !m.readAt) { m.readAt = new Date().toISOString(); changed = true; } });
    if (!changed) return;
    if (SERVER) {
      api("/messages/read", { method: "POST", body: isAdminView() ? { athlete_id: s.id } : {} }).catch(function () {});
    } else { saveStore(); }
  }

  /* ----------------------------- Templates & bulk assign ----------------------------- */
  function saveTemplate(title, note, items) {
    if (!SERVER) { toast("Templates need the shared server"); return; }
    api("/templates", { method: "POST", body: { title: title, note: note, activity_ids: items } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't save template")); return; }
      refreshFromServer().then(function () { toast("Saved as template"); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  function deleteTemplate(id) {
    if (!SERVER) return;
    api("/templates/" + encodeURIComponent(id), { method: "DELETE" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
      refreshFromServer().then(function () { renderAll(); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  function bulkAssign(athleteIds, title, note, items, dueAt) {
    if (!SERVER) { toast("Bulk assign needs the shared server"); return; }
    api("/assignments/bulk", { method: "POST", body: { athlete_ids: athleteIds, title: title, note: note, activity_ids: items, due_at: dueAt || null } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't bulk assign")); return; }
      closeModal();
      var n = (res.data && res.data.created) || athleteIds.length;
      refreshFromServer().then(function () { renderAll(); toast("Assigned to " + n + " athlete" + (n === 1 ? "" : "s")); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  // Save the same workout to several athletes at once, from a reusable template.
  function openBulkAssignModal() {
    var sl = studentList();
    if (!sl.length) { toast("Add students first"); return; }
    var templates = state.templates || [];
    var title = el("input", { type: "text", placeholder: "e.g. Week 2 — Focus" });
    var note = el("textarea", { placeholder: "Optional note" });
    var due = el("input", { type: "date" });
    var chosenActs = {};
    var actSummary = el("p", { class: "field-hint" }, "Pick a template to choose the activities.");
    var tsel = el("select", {});
    tsel.appendChild(option("", templates.length ? "Choose a template…" : "No templates yet — save one from an assignment first"));
    templates.forEach(function (t) { tsel.appendChild(option(t.id, t.title + " (" + t.items.length + ")")); });
    tsel.addEventListener("change", function () {
      var t = templates.filter(function (x) { return x.id === tsel.value; })[0];
      chosenActs = {};
      if (t) {
        t.items.forEach(function (id) { chosenActs[id] = true; });
        if (!title.value) title.value = t.title;
        if (!note.value && t.note) note.value = t.note;
      }
      actSummary.textContent = Object.keys(chosenActs).length + " activities from this template";
    });
    var pickedAthletes = {};
    var athletesWrap = el("div", { class: "picker-list" });
    sl.forEach(function (s) {
      var cb = el("input", { type: "checkbox" });
      cb.addEventListener("change", function () { if (cb.checked) pickedAthletes[s.id] = true; else delete pickedAthletes[s.id]; });
      athletesWrap.appendChild(el("label", { class: "picker-row" }, [cb, el("span", { class: "p-name" }, s.name)]));
    });
    var selectAll = el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () {
      var boxes = $all("input[type=checkbox]", athletesWrap);
      var allOn = boxes.every(function (b) { return b.checked; });
      boxes.forEach(function (b, i) { b.checked = !allOn; if (!allOn) pickedAthletes[sl[i].id] = true; else delete pickedAthletes[sl[i].id]; });
    } }, "Toggle all");
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Template"), tsel]), actSummary,
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]),
      el("div", { class: "field" }, [el("label", {}, "Due date (optional)"), due]),
      el("div", { class: "field" }, [el("div", { class: "section-head" }, [el("label", {}, "Assign to"), selectAll]), athletesWrap])
    ]);
    openModal("Bulk assign from a template", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Assign to selected", accent: true, onClick: function () {
        var aids = Object.keys(pickedAthletes), ids = Object.keys(chosenActs);
        if (!ids.length) { toast("Pick a template first"); return; }
        if (!aids.length) { toast("Pick at least one athlete"); return; }
        bulkAssign(aids, title.value, note.value, ids, dueInputToIso(due.value));
      } }
    ]);
  }

  /* ----------------------------- Export / Import ----------------------------- */
  function exportTracking() {
    var date = new Date().toISOString().slice(0, 10);
    downloadFile("performancextra-data-" + date + ".json",
      JSON.stringify(state.tracking, null, 2), "application/json");
    toast("Data exported");
  }

  var pendingImportMode = "merge";
  function triggerImport(mode) { pendingImportMode = mode; $("#import-file").click(); }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = JSON.parse(reader.result); }
      catch (e) { toast("That file isn’t valid JSON"); return; }
      if (!incoming || !incoming.students || (incoming.version !== 1 && incoming.version !== 2)) {
        toast("Unrecognized backup file");
        return;
      }
      incoming = normalizeStore(incoming);   // upgrade v1 / fill missing fields
      function reflTs(entry) {
        if (!entry || !entry.updatedAt) return 0;
        var t = Date.parse(entry.updatedAt);
        return isNaN(t) ? 0 : t;
      }
      function mergeReflections(target, incomingMap) {
        var t = target && typeof target === "object" ? target : {};
        var inc = incomingMap && typeof incomingMap === "object" ? incomingMap : {};
        Object.keys(inc).forEach(function (k) {
          var incomingEntry = inc[k];
          if (!incomingEntry || !String(incomingEntry.text || "").trim()) return;
          var current = t[k];
          if (!current || reflTs(incomingEntry) >= reflTs(current)) {
            t[k] = {
              text: String(incomingEntry.text || "").trim(),
              updatedAt: incomingEntry.updatedAt || new Date().toISOString()
            };
          }
        });
        return t;
      }
      if (pendingImportMode === "replace") {
        // Keep the current passcode unless the backup carries one.
        if (!incoming.settings.passcodeHash) incoming.settings.passcodeHash = passcodeHash();
        state.tracking = incoming;
      } else {
        var cur = state.tracking;
        Object.keys(incoming.students).forEach(function (id) {
          var inc = incoming.students[id];
          if (!cur.students[id]) { cur.students[id] = inc; return; }
          var existing = cur.students[id];
          Object.keys(inc.completed).forEach(function (aid) {
            var a = inc.completed[aid], b = existing.completed[aid];
            // keep the earliest completion timestamp on conflict
            existing.completed[aid] = (!b || a < b) ? a : b;
          });
          // Merge assignments, skipping ones already present by id.
          var have = {};
          (existing.assignments || []).forEach(function (x) { have[x.id] = true; });
          (inc.assignments || []).forEach(function (x) { if (!have[x.id]) existing.assignments.push(x); });
          existing.reflections = mergeReflections(existing.reflections, inc.reflections);
        });
        if (!cur.activeStudentId && incoming.activeStudentId) cur.activeStudentId = incoming.activeStudentId;
        // Bring over custom activities the current device doesn't have.
        var haveAct = {};
        cur.customActivities.forEach(function (a) { haveAct[a.id] = true; });
        incoming.customActivities.forEach(function (a) { if (!haveAct[a.id]) cur.customActivities.push(a); });
        Object.keys(incoming.overrides).forEach(function (id) { if (!cur.overrides[id]) cur.overrides[id] = incoming.overrides[id]; });
        Object.keys(incoming.hidden).forEach(function (id) { cur.hidden[id] = incoming.hidden[id]; });
      }
      saveStore();
      rebuildData();
      refreshSelects();
      renderAll();
      toast("Data imported (" + pendingImportMode + ")");
    };
    reader.readAsText(file);
  }

  /* ----------------------------- Shared UI ----------------------------- */
  function fillSelect(sel, values, allLabel) {
    sel.textContent = "";
    sel.appendChild(option("", allLabel));
    values.forEach(function (v) { sel.appendChild(option(v, v)); });
  }
  // Repopulate a subtopic <select> with only the subtopics valid for the topic
  // currently chosen in topicSel, preserving a still-valid selection (or the
  // supplied `preferred` value) and otherwise resetting to "all".
  function syncSubtopicSelect(topicSel, subSel, allLabel, preferred) {
    var prev = (preferred != null) ? preferred : subSel.value;
    var opts = subtopicsForTopic(topicSel.value);
    fillSelect(subSel, opts, allLabel);
    subSel.value = (prev && opts.indexOf(prev) !== -1) ? prev : "";
  }

  // Append `text` to `node`, turning bare http(s) URLs into clickable links.
  // Builds real text + anchor nodes (never innerHTML), so it is XSS-safe even
  // for coach-authored notes.
  function linkifyInto(node, text) {
    var s = String(text == null ? "" : text);
    // Match a markdown [label](url) OR a bare http(s) URL. Markdown is tried first so
    // its URL isn't also caught as a bare URL. The markdown URL group requires an
    // http(s):// scheme, so anything else (e.g. javascript:) never becomes an anchor —
    // it falls through and is emitted as literal text. Everything is built from real
    // text/anchor nodes (never innerHTML), so coach-authored notes stay XSS-safe.
    var re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
    var last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) node.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1] != null) {
        // [label](url) — render the friendly label text.
        node.appendChild(el("a", { href: m[2], target: "_blank", rel: "noopener", class: "note-link" }, m[1]));
      } else {
        var url = m[3], trail = "";
        // Don't swallow trailing sentence punctuation into the link.
        while (/[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
        node.appendChild(el("a", { href: url, target: "_blank", rel: "noopener", class: "note-link" }, url));
        if (trail) node.appendChild(document.createTextNode(trail));
      }
      last = m.index + m[0].length;
    }
    if (last < s.length) node.appendChild(document.createTextNode(s.slice(last)));
    return node;
  }
  // A <div> (or given tag) whose text content has clickable links.
  function noteNode(text, cls, tag) {
    return linkifyInto(el(tag || "div", { class: cls || "assignment-note" }), text);
  }

  function renderStudentPicker() {
    var sel = $("#student-select");
    var label = $("#student-select-label");
    var nameTag = $("#student-name-tag");
    var all = studentList();
    if (isAdminView()) {
      // Coach gets a dropdown to switch the student they're working with.
      label.hidden = false; sel.hidden = false; nameTag.hidden = true;
      sel.textContent = "";
      if (!all.length) {
        sel.appendChild(option("", "No students yet"));
        sel.disabled = true;
      } else {
        sel.disabled = false;
        all.forEach(function (s) { sel.appendChild(option(s.id, s.name)); });
        sel.value = state.tracking.activeStudentId || "";
      }
    } else {
      // Student view: locked to the active student, no switching.
      var s = activeStudent();
      label.hidden = true; sel.hidden = true; nameTag.hidden = false;
      nameTag.textContent = s ? ("Hi, " + s.name) : "No student selected";
    }
    updateStudentCount();
  }

  function updateStudentCount() {
    var s = activeStudent();
    var c = $("#student-count");
    if (s) {
      // Always report progress out of what's assigned to this athlete, not the
      // whole catalogue — matches the progress bars in the detail views.
      var assigned = assignedActivityIds(s);
      var doneAssigned = assigned.filter(function (id) { return !!s.completed[id]; }).length;
      c.textContent = assigned.length
        ? (doneAssigned + " / " + assigned.length + " assigned done")
        : "Nothing assigned yet";
    } else { c.textContent = ""; }
  }

  /* ----------------------------- Tabs / role ----------------------------- */
  function currentTabs() {
    if (!isAdminView()) {
      var meS = activeStudent();
      var unread = meS ? threadUnread(meS, "coach") : 0;
      return [
        { id: "workouts", label: "My Workouts" },
        { id: "checkin", label: "Check-in" },
        { id: "messages", label: "Messages" + (unread ? " (" + unread + ")" : "") },
        { id: "progress", label: "My Progress" }
      ];
    }
    // Coach base tabs; each higher tier adds tabs so the set is a visible superset.
    var tabs = [
      { id: "repo", label: "Repository" },
      { id: "students", label: "Students" }, { id: "content", label: "Content" }
    ];
    if (isAtLeastAdmin()) tabs.push({ id: "manage", label: "Team" });
    if (isSuperadmin()) tabs.push({ id: "appearance", label: "Appearance" });
    tabs.push({ id: "settings", label: "Settings" });
    return tabs;
  }

  function renderTabs() {
    var nav = $("#tabs");
    nav.textContent = "";
    currentTabs().forEach(function (t) {
      nav.appendChild(el("button", { class: "tab", "data-tab": t.id, onclick: function () { setTab(t.id); } }, t.label));
    });
  }

  function setTab(tab) {
    var ids = currentTabs().map(function (t) { return t.id; });
    if (ids.indexOf(tab) === -1) tab = ids[0];
    state.tab = tab;
    // Global-library editing is scoped to the Content tab; leaving it returns the
    // CMS flows to private so Repository/other-tab edits never hit the global library.
    if (tab !== "content") currentCmsTarget = "private";
    // Render the tabs that aren't part of the always-present static markup on demand.
    if (tab === "manage" && isAtLeastAdmin()) renderManage();
    else if (tab === "appearance" && isSuperadmin()) renderAppearance();
    $all(".tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $all(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === "view-" + tab); });
    if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  }

  // Sync all role-dependent chrome (body flag, header buttons, badge, tabs) to
  // the current view + auth state.
  function applyRole() {
    document.body.setAttribute("data-role", isAdminView() ? "admin" : "student");
    var badge = $("#role-badge");
    badge.hidden = false;
    var picker = $(".student-picker");
    var helpBtn = $("#help-btn");

    if (SERVER) {
      // Real, server-trusted session: no client passcode, no coach "preview".
      var role = state.session ? state.session.role : "athlete";
      var name = state.session ? state.session.name : "";
      if (picker) picker.hidden = true;
      if (helpBtn) helpBtn.hidden = true;
      $("#admin-login-btn").hidden = true;
      $("#student-view-btn").hidden = true;
      $("#logout-btn").hidden = false;
      $("#preview-banner").hidden = true;
      if (role !== "athlete") {
        var tierLabel = role === "superadmin" ? "Super admin" : (role === "admin" ? "Admin" : "Coach");
        badge.textContent = name || tierLabel;
        badge.classList.remove("is-student");
      } else { badge.textContent = name || "Athlete"; badge.classList.add("is-student"); }
      applyServerChrome();
      renderTabs();
      setTab(state.tab);
      return;
    }

    var authed = isAuthed();
    var preview = authed && !isAdminView();
    // "Admin login" and "Log out" are mutually exclusive: you're either signed in or not.
    // The "Student view" preview toggle only makes sense while signed in and in admin view.
    $("#admin-login-btn").hidden = authed;
    $("#logout-btn").hidden = !authed;
    $("#student-view-btn").hidden = !(authed && isAdminView());
    $("#preview-banner").hidden = !preview;
    if (isAdminView()) { badge.textContent = "Coach"; badge.classList.remove("is-student"); }
    else { badge.textContent = preview ? "Student preview" : "Student"; badge.classList.add("is-student"); }
    renderTabs();
    setTab(state.tab);
    maybeDefaultPasscodeNudge();
  }

  // Toggle device/localStorage-specific chrome that doesn't apply once data is shared,
  // and surface the signed-in account in Settings.
  function applyServerChrome() {
    $all(".local-only").forEach(function (n) { n.hidden = true; });
    $all(".server-only").forEach(function (n) { n.hidden = false; });
    var info = $("#account-info");
    if (info && state.session) {
      info.textContent = "";
      var roleLabel = { superadmin: "super admin", admin: "admin", coach: "coach", athlete: "athlete" }[state.session.role] || state.session.role;
      info.appendChild(detailBlock("Signed in as", state.session.name + " · " + roleLabel));
    }
  }

  function goAdmin() { state.view = "admin"; state.tab = "students"; applyRole(); renderAll(); }
  function goStudent(preview) { state.view = "student"; state.tab = "workouts"; applyRole(); renderAll(); }
  function logout() {
    if (SERVER) {
      api("/logout", { method: "POST" }).then(function () { location.reload(); }).catch(function () { location.reload(); });
      return;
    }
    setAuthed(false); goStudent(); toast("Logged out — student view");
  }

  /* ----------------------------- Modal ----------------------------- */
  function closeModal() {
    var root = $("#modal-root");
    root.hidden = true; root.setAttribute("aria-hidden", "true"); root.textContent = ""; root.onclick = null;
    document.removeEventListener("keydown", modalKeydown);
  }
  function modalKeydown(e) { if (e.key === "Escape") closeModal(); }
  function openModal(title, bodyNode, actions) {
    var root = $("#modal-root");
    root.textContent = "";
    var modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title });
    modal.appendChild(el("div", { class: "modal-head" }, [
      el("h3", {}, title),
      el("button", { class: "modal-close", "aria-label": "Close", onclick: closeModal }, "×")
    ]));
    modal.appendChild(el("div", { class: "modal-body" }, bodyNode));
    var acts = (actions || []).filter(Boolean);
    if (acts.length) {
      var foot = el("div", { class: "modal-foot" });
      acts.forEach(function (a) {
        var cls = "btn" + (a.accent ? " btn--accent" : (a.primary ? " btn--primary" : "")) + (a.danger ? " btn--danger" : "");
        foot.appendChild(el("button", { class: cls, onclick: a.onClick }, a.label));
      });
      modal.appendChild(foot);
    }
    root.appendChild(modal);
    root.hidden = false; root.setAttribute("aria-hidden", "false");
    root.onclick = function (e) { if (e.target === root) closeModal(); };
    document.addEventListener("keydown", modalKeydown);
    return modal;
  }

  function openLoginModal() {
    var input = el("input", { type: "password", id: "login-pass", autocomplete: "current-password", placeholder: "Admin passcode" });
    var err = el("div", { class: "warn" }, "Incorrect passcode. Try again."); err.hidden = true;
    var hint = isUsingDefaultPasscode()
      ? el("p", { class: "field-hint" }, "Default passcode is “" + DEFAULT_PASSCODE + "”. Change it in Settings after you log in.")
      : null;
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", { for: "login-pass" }, "Enter the admin passcode to unlock coaching tools."), input]),
      err, hint
    ]);
    function submit() {
      if (checkPasscode(input.value)) { setAuthed(true); closeModal(); goAdmin(); toast("Welcome, coach"); maybeAutoTour(); }
      else { err.hidden = false; input.value = ""; input.focus(); }
    }
    openModal("Admin login", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Log in", primary: true, onClick: submit }
    ]);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    setTimeout(function () { input.focus(); }, 30);
  }

  function studentSelectNode(defaultId) {
    var sel = el("select", {});
    var all = studentList();
    all.forEach(function (s) { sel.appendChild(option(s.id, s.name)); });
    sel.value = defaultId || state.tracking.activeStudentId || (all[0] && all[0].id) || "";
    return sel;
  }

  // Assign a fixed set of activities (a generated workout, or one card) to a student.
  function openAssignModal(activityIds, defaultTitle) {
    activityIds = (activityIds || []).filter(function (id) { return BY_ID[id]; });
    if (!activityIds.length) { toast("Nothing to assign"); return; }
    if (!studentList().length) { toast("Add a student first (Students tab)"); return; }
    var sel = studentSelectNode();
    var title = el("input", { type: "text", value: defaultTitle || "Workout" });
    var note = el("textarea", { placeholder: "Optional note — why this matters, how often to do it…" });
    var due = el("input", { type: "date" });
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Assign to"), sel]),
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]),
      el("div", { class: "field" }, [el("label", {}, "Due date (optional)"), due]),
      el("p", { class: "field-hint" }, activityIds.length + " activit" + (activityIds.length === 1 ? "y" : "ies") + " will be assigned.")
    ]);
    openModal("Assign to student", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Assign", accent: true, onClick: function () {
        var sid = sel.value;
        if (!sid) { toast("Pick a student"); return; }
        var sname = students()[sid] ? students()[sid].name : "student";
        createAssignmentFlow(sid, title.value, note.value, activityIds, function () {
          closeModal(); renderAll(); toast("Assigned to " + sname);
        }, dueInputToIso(due.value));
      } }
    ]);
  }

  // Set/edit a per-student custom link for one activity in an assignment.
  // Lets a coach point a student at a doc/sheet in that student's private folder
  // without changing the activity's default link for everyone else.
  function openItemLinkModal(studentId, asg, activityId) {
    var a = BY_ID[activityId];
    var current = (asg.itemLinks && asg.itemLinks[activityId]) || "";
    var input = el("input", { type: "url", placeholder: "https://… (blank = use the default link)", style: "flex:1 1 auto; min-width:0;" });
    input.value = current;
    function validUrl(v) { return /^https:\/\//i.test(v); }
    // "Test" opens whatever's typed in a new tab, so the coach can confirm the
    // link loads (and that the student would be able to open it) before saving.
    var testBtn = el("button", { class: "btn btn--sm", type: "button", onclick: function () {
      var v = input.value.trim();
      if (!v) { toast("Enter a link first"); input.focus(); return; }
      if (!validUrl(v)) { toast("Enter a full https:// link"); input.focus(); return; }
      window.open(v, "_blank", "noopener");
    } }, "Test ↗");
    // Plain-language help so a coach who doesn't already know how to get a
    // shareable link can still succeed without asking anyone.
    var howto = el("details", { class: "detail", style: "margin-top:2px;" }, [
      el("summary", {}, "How do I get a link?"),
      el("ol", { class: "howto-list" }, [
        el("li", {}, "Open the document or sheet you want this student to use (for example in their Google Drive folder)."),
        el("li", {}, "Click Share → Copy link — or simply copy the address from your browser's address bar."),
        el("li", {}, "Make sure the file is shared with this student's own account, or it won't open for them."),
        el("li", {}, "Paste it below and press Test to confirm it opens.")
      ])
    ]);
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "This link is just for this student — handy for a document in their private folder. Set it once and it applies wherever this activity is assigned to them, replacing the activity's normal link for them."),
      (a && a.link) ? el("p", { class: "field-hint" }, "Default link (everyone else): " + a.link) : null,
      howto,
      el("div", { class: "field" }, [
        el("label", {}, "Custom link for this student"),
        el("div", { style: "display:flex; gap:8px; align-items:center;" }, [input, testBtn])
      ]),
      el("p", { class: "field-hint" }, "Tip: the student must be able to open this link with their own account. If they see “Request access,” share the file with them first.")
    ]);
    function commit(v) {
      setItemLinkFlow(studentId, asg.id, activityId, v, function () {
        closeModal(); renderAll(); toast(v ? "Custom link saved" : "Custom link removed");
      });
    }
    openModal("Custom link — " + (a ? a.name : "activity"), body, [
      { label: "Cancel", onClick: closeModal },
      current ? { label: "Remove", danger: true, onClick: function () { commit(""); } } : null,
      { label: "Save link", accent: true, onClick: function () {
        var v = input.value.trim();
        if (v && !validUrl(v)) { toast("Enter a full https:// link"); input.focus(); return; }
        commit(v);
      } }
    ]);
  }

  // Build an assignment for a specific student by searching + checking activities.
  function openAssignBuilderModal(studentId) {
    var s = students()[studentId];
    if (!s) return;
    var selected = {};
    var title = el("input", { type: "text", placeholder: "e.g. Week 1 — Confidence" });
    var note = el("textarea", { placeholder: "Optional note for the student" });
    var search = el("input", { type: "search", placeholder: "Search activities to add…" });
    var listWrap = el("div", { class: "picker-list" });
    var countEl = el("div", { class: "picker-count" }, "0 selected");

    function updateCount() { countEl.textContent = Object.keys(selected).length + " selected"; }
    function refresh() {
      var q = norm(search.value).trim();
      listWrap.textContent = "";
      var ranked = DATA.map(function (a) {
        return { a: a, score: q ? smartSearchScore(a, q) : 1 };
      }).filter(function (x) { return x.score > 0; });
      ranked.sort(function (x, y) { return y.score - x.score || x.a.name.localeCompare(y.a.name); });
      var matches = ranked.slice(0, 200).map(function (x) { return x.a; });
      if (!matches.length) { listWrap.appendChild(el("div", { class: "picker-row" }, "No activities match.")); return; }
      matches.forEach(function (a) {
        var cb = el("input", { type: "checkbox" });
        cb.checked = !!selected[a.id];
        cb.addEventListener("change", function () { if (cb.checked) selected[a.id] = true; else delete selected[a.id]; updateCount(); });
        listWrap.appendChild(el("label", { class: "picker-row" }, [
          cb,
          el("span", { class: "p-name" }, a.name),
          el("span", { class: "p-meta" }, (a.type || "") + (a.time ? (" · " + a.time) : ""))
        ]));
      });
    }

    // Generate-by-criteria: auto-pick a balanced set from the library (the old
    // standalone Workout Builder, folded into the assign flow), then let the coach
    // tweak the selection below before assigning.
    var genTopic = el("select", {}); fillSelect(genTopic, PRESENT.topic, "Any topic");
    var genType = el("select", {}); fillSelect(genType, PRESENT.type, "Any type");
    var genCount = el("input", { type: "number", min: "1", max: "30", value: "5" });
    var genExclude = el("input", { type: "checkbox" }); genExclude.checked = true;
    function generateInto() {
      var c = { scope: "any", month: null, week: null, topic: genTopic.value || "", subtopic: "",
                type: genType.value || "", mix: true, count: Math.max(1, Number(genCount.value) || 5),
                timeBudget: 0, excludeCompleted: false };
      var pool = candidatePool(c);
      if (genExclude.checked) {
        var done = (students()[studentId] && students()[studentId].completed) || {};
        pool = pool.filter(function (a) { return !done[a.id]; });
      }
      pool = pool.filter(function (a) { return !selected[a.id]; });   // keep current picks, add new ones
      var picks = selectWorkout(pool, c);
      if (!picks.length) { toast("No new activities match — try a broader topic/type"); return; }
      picks.forEach(function (a) { selected[a.id] = true; });
      if (!title.value) title.value = [c.topic, c.type].filter(Boolean).join(" · ") || "Workout";
      refresh(); updateCount();
      toast("Added " + picks.length + " activit" + (picks.length === 1 ? "y" : "ies"));
    }
    var generator = el("details", { class: "detail assign-generator" }, [
      el("summary", {}, "✦ Generate by criteria"),
      el("p", { class: "field-hint" }, "Auto-pick a balanced set from the library, then tweak the list below before assigning."),
      el("div", { class: "form-grid2" }, [
        el("div", { class: "field" }, [el("label", {}, "Topic"), genTopic]),
        el("div", { class: "field" }, [el("label", {}, "Content type"), genType])
      ]),
      el("div", { class: "form-grid2" }, [
        el("div", { class: "field" }, [el("label", {}, "How many"), genCount]),
        el("label", { class: "check" }, [genExclude, " Skip ones they've completed"])
      ]),
      el("button", { class: "btn btn--sm btn--accent", type: "button", onclick: generateInto }, "Generate")
    ]);

    var due = el("input", { type: "date" });
    var tmpls = state.templates || [];
    var tmplSel = el("select", {});
    tmplSel.appendChild(option("", "Start from a template…"));
    tmpls.forEach(function (t) { tmplSel.appendChild(option(t.id, t.title + " (" + t.items.length + ")")); });
    tmplSel.addEventListener("change", function () {
      var t = tmpls.filter(function (x) { return x.id === tmplSel.value; })[0];
      if (!t) return;
      t.items.forEach(function (id) { if (BY_ID[id]) selected[id] = true; });
      if (!title.value) title.value = t.title;
      if (!note.value && t.note) note.value = t.note;
      refresh(); updateCount(); toast("Loaded template");
    });
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]),
      el("div", { class: "field" }, [el("label", {}, "Due date (optional)"), due]),
      tmpls.length ? el("div", { class: "field" }, [el("label", {}, "Start from template"), tmplSel]) : null,
      generator,
      el("div", { class: "field" }, [el("label", {}, "Add activities"), search]),
      listWrap, countEl
    ]);
    search.addEventListener("input", refresh);
    openModal("New assignment for " + s.name, body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create assignment", accent: true, onClick: function () {
        var ids = Object.keys(selected);
        if (!ids.length) { toast("Pick at least one activity"); return; }
        createAssignmentFlow(studentId, title.value, note.value, ids, function () { closeModal(); renderAll(); toast("Assignment created"); }, dueInputToIso(due.value));
      } }
    ]);
    refresh();
  }

  // Add a new custom activity, or edit an existing one (built-in edits go to an override layer).
  function openActivityModal(id) {
    var editing = id ? cmsActivityById(id) : null;
    var f = {};
    function makeInput(key, attrs, isArea) {
      var node = isArea ? el("textarea", attrs || {}) : el("input", attrs || {});
      if (!isArea && !node.getAttribute("type")) node.type = "text";
      if (editing) {
        var val = key === "subtopics" ? (editing.subtopics || []).join(", ") : editing[key];
        if (val != null && val !== "") node.value = val;
      }
      f[key] = node;
      return node;
    }
    function field(label, key, attrs, isArea, hint) {
      var kids = [el("label", {}, label), makeInput(key, attrs, isArea)];
      if (hint) kids.push(el("div", { class: "field-hint" }, hint));
      return el("div", { class: "field" }, kids);
    }
    function dl(idv, values) {
      var d = el("datalist", { id: idv });
      values.forEach(function (v) { d.appendChild(option(v, "")); });
      return d;
    }
    var body = el("div", { class: "form-stack" }, [
      field("Name *", "name", { placeholder: "Activity name" }),
      el("div", { class: "form-grid2" }, [
        field("Topic", "topic", { list: "dl-topics" }),
        field("Content type", "type", { list: "dl-types" })
      ]),
      field("Subtopics", "subtopics", { list: "dl-subtopics", placeholder: "Calmness, Focus" }, false, "Separate multiple with commas."),
      el("div", { class: "form-grid2" }, [
        field("Progression", "progression", { list: "dl-progressions", placeholder: "Week 3 / Extra" }),
        field("Frequency", "frequency", { list: "dl-frequencies" })
      ]),
      el("div", { class: "form-grid2" }, [
        field("Week (number)", "week", { type: "number", min: "1", max: "20" }, false, "Optional — sets the month automatically."),
        field("Time (label)", "time", { placeholder: "5 min" })
      ]),
      el("div", { class: "form-grid2" }, [
        field("Time in minutes", "timeMinutes", { type: "number", min: "0" }, false, "Used by the time-budget feature."),
        field("Link", "link", { type: "url", placeholder: "https://…" })
      ]),
      field("Instructions", "instructions", { placeholder: "How to do it" }, true),
      field("Reflection prompt", "reflection", {}, true),
      dl("dl-topics", taxList("topic")), dl("dl-types", taxList("type")),
      dl("dl-subtopics", taxList("subtopic")),
      dl("dl-progressions", PRESENT.progression), dl("dl-frequencies", PRESENT.frequency)
    ]);
    function save() {
      var form = {};
      Object.keys(f).forEach(function (k) { form[k] = f[k].value; });
      if (!String(form.name || "").trim()) { toast("Name is required"); f.name.focus(); return; }
      if (editing) saveActivityEdit(id, form); else addCustomActivity(form);
      closeModal(); refreshSelects(); renderAll();
      toast(editing ? "Activity updated" : "Activity added");
    }
    openModal(editing ? "Edit activity" : "Add activity", body, [
      { label: "Cancel", onClick: closeModal },
      (editing && isCustom(id)) ? { label: "Delete", danger: true, onClick: function () {
        if (confirm("Delete this custom activity?")) { deleteCustomActivity(id); closeModal(); refreshSelects(); renderAll(); toast("Deleted"); }
      } } : null,
      { label: editing ? "Save" : "Add activity", accent: true, onClick: save }
    ]);
  }

  /* ----------------------------- Auth gate + invites (SERVER mode) ----------------------------- */
  function getQueryParam(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (e) { return null; }
  }
  function authHeader() {
    return el("div", { class: "auth-head" }, [
      el("div", { class: "brand-logo", "aria-hidden": "true" }, "PX"),
      el("div", {}, [
        el("div", { class: "brand-name" }, "PerformanceXtra"),
        el("div", { class: "brand-tag" }, "Mental Workout Repository")
      ])
    ]);
  }
  // Full-screen, non-dismissable gate shown when the backend is reachable but the
  // visitor has no session. Routes to an invite-accept form if ?invite= is present.
  function showAuthGate(offline) {
    if ($("#auth-gate")) return;
    var landing = el("div", { class: "auth-landing", id: "auth-landing", hidden: true });
    var card = el("div", { class: "auth-card" });
    var stack = el("div", { class: "auth-stack" }, [landing, card]);
    var root = el("div", { class: "auth-gate", id: "auth-gate", role: "dialog", "aria-modal": "true", "aria-label": "Sign in" }, stack);
    document.body.appendChild(root);
    var invite = getQueryParam("invite");
    if (invite) { renderAcceptForm(card, invite); return; }
    renderLoginForm(card, offline);
    if (!offline) renderLandingInto(landing);   // show the super-admin's published landing page above the form
  }
  // Render the published 'landing' builder page (if any) for signed-out visitors. The
  // endpoint is public and returns 404 when no published page exists, in which case the
  // sign-in card simply shows on its own.
  function renderLandingInto(mount) {
    api("/pages/landing").then(function (res) {
      if (res.ok && res.data && Array.isArray(res.data.blocks) && res.data.blocks.length) {
        renderPageBlocks(res.data.blocks, mount);
        mount.hidden = false;
      }
    }).catch(function () {});
  }
  function renderLoginForm(card, offline) {
    card.textContent = "";
    var email = el("input", { type: "email", id: "auth-email", placeholder: "you@email.com", autocomplete: "username" });
    var pass = el("input", { type: "password", id: "auth-pass", placeholder: "Password", autocomplete: "current-password" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var setupRow = el("p", { class: "field-hint", style: "text-align:center; margin-top:4px" });
    function submit() {
      errBox.hidden = true;
      var em = email.value.trim(), pw = pass.value;
      if (!em || !pw) { errBox.textContent = "Enter your email and password."; errBox.hidden = false; return; }
      api("/login", { method: "POST", body: { email: em, password: pw } }).then(function (res) {
        if (!res.ok) { errBox.textContent = apiError(res, "Invalid email or password."); errBox.hidden = false; pass.value = ""; pass.focus(); return; }
        location.reload();
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    card.appendChild(authHeader());
    card.appendChild(el("h3", { class: "auth-title" }, "Sign in"));
    card.appendChild(el("p", { class: "field-hint" }, "Coaches and athletes sign in here with their email and password. Athletes: use the email and passcode your coach sent you."));
    if (offline) {
      card.appendChild(el("div", { class: "warn" }, "Can’t reach the PerformanceXtra server right now, so sign-in is temporarily unavailable. Please try this link again in a moment."));
    }
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", { for: "auth-email" }, "Email"), email]),
      el("div", { class: "field" }, [el("label", { for: "auth-pass" }, "Password / passcode"), pass]),
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Sign in"),
      setupRow
    ]));
    [email, pass].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }); });
    setTimeout(function () { email.focus(); }, 30);
    if (offline) return;
    api("/setup-status").then(function (res) {
      setupRow.textContent = "";
      if (res.ok && res.data && res.data.needsSetup) {
        setupRow.appendChild(document.createTextNode("First time here? "));
        setupRow.appendChild(el("a", { href: "#", onclick: function (e) { e.preventDefault(); renderSetupForm(card); } }, "Create the admin account"));
      } else {
        setupRow.textContent = "Athletes: sign in with the email and passcode your coach sent you.";
      }
    }).catch(function () {});
  }
  function renderSetupForm(card) {
    card.textContent = "";
    var name = el("input", { type: "text", placeholder: "Your name", autocomplete: "name" });
    var email = el("input", { type: "email", placeholder: "you@email.com", autocomplete: "username" });
    var pass = el("input", { type: "password", placeholder: "Password (8+ characters)", autocomplete: "new-password" });
    var confirm = el("input", { type: "password", placeholder: "Confirm password", autocomplete: "new-password" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    function submit() {
      errBox.hidden = true;
      var nm = name.value.trim(), em = email.value.trim(), pw = pass.value;
      if (!nm || !em) { errBox.textContent = "Name and email are required."; errBox.hidden = false; return; }
      if (pw.length < 8) { errBox.textContent = "Use a password of at least 8 characters."; errBox.hidden = false; return; }
      if (pw !== confirm.value) { errBox.textContent = "Passwords don't match."; errBox.hidden = false; return; }
      api("/setup", { method: "POST", body: { name: nm, email: em, password: pw } }).then(function (res) {
        if (!res.ok) { errBox.textContent = apiError(res, "Couldn't complete setup."); errBox.hidden = false; return; }
        location.reload();
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    card.appendChild(authHeader());
    card.appendChild(el("h3", { class: "auth-title" }, "Create the admin account"));
    card.appendChild(el("p", { class: "field-hint" }, "This is the first account on this site — it becomes the super admin. You add coaches afterwards, and each coach manages their own athletes."));
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Name"), name]),
      el("div", { class: "field" }, [el("label", {}, "Email"), email]),
      el("div", { class: "field" }, [el("label", {}, "Password"), pass]),
      el("div", { class: "field" }, [el("label", {}, "Confirm password"), confirm]),
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Create account"),
      el("p", { class: "field-hint", style: "text-align:center" }, [
        el("a", { href: "#", onclick: function (e) { e.preventDefault(); renderLoginForm(card); } }, "← Back to sign in")
      ])
    ]));
    setTimeout(function () { name.focus(); }, 30);
  }
  function renderAcceptForm(card, token) {
    card.textContent = "";
    var pass = el("input", { type: "password", placeholder: "Choose a password (8+ characters)", autocomplete: "new-password" });
    var confirm = el("input", { type: "password", placeholder: "Confirm password", autocomplete: "new-password" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    function submit() {
      errBox.hidden = true;
      var pw = pass.value;
      if (pw.length < 8) { errBox.textContent = "Use a password of at least 8 characters."; errBox.hidden = false; return; }
      if (pw !== confirm.value) { errBox.textContent = "Passwords don't match."; errBox.hidden = false; return; }
      api("/athletes/accept", { method: "POST", body: { token: token, password: pw } }).then(function (res) {
        if (!res.ok) { errBox.textContent = apiError(res, "This invite is invalid or expired."); errBox.hidden = false; return; }
        // Drop the ?invite= param, then reload into the athlete's workouts.
        try { history.replaceState(null, "", location.pathname); } catch (e) {}
        location.href = location.pathname;
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    card.appendChild(authHeader());
    card.appendChild(el("h3", { class: "auth-title" }, "Set your password"));
    card.appendChild(el("p", { class: "field-hint" }, "Welcome! Pick a password to finish setting up your account. Next time you'll sign in with your email and this password."));
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Password"), pass]),
      el("div", { class: "field" }, [el("label", {}, "Confirm password"), confirm]),
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Set password & continue")
    ]));
    [pass, confirm].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }); });
    setTimeout(function () { pass.focus(); }, 30);
  }

  // Org-wide duplicate search shared by the create modals. Hits GET /api/lookup and returns
  // the matching accounts (or [] on any failure — dedupe is an aid, never a blocker).
  function dupeLookup(kind, q) {
    return api("/lookup?kind=" + encodeURIComponent(kind) + "&q=" + encodeURIComponent(q)).then(function (res) {
      return (res.ok && res.data && res.data.matches) || [];
    });
  }
  // Wire live "already in the system" matches onto a create modal's name + email inputs,
  // rendering into `panel`. Typing in either field (debounced) searches by that field's value;
  // an exact email or name match is flagged so the creator notices before clicking Create.
  function attachDupeSearch(kind, nameInput, emailInput, panel) {
    var timer = null;
    var TIER_LABEL = { athlete: "Student", coach: "Coach", admin: "Admin", superadmin: "Super admin" };
    function render(matches) {
      panel.textContent = "";
      if (!matches || !matches.length) { panel.hidden = true; return; }
      panel.hidden = false;
      var nm = lc(nameInput.value), em = lc(emailInput.value);
      panel.appendChild(el("div", { class: "dupe-head" }, "Already in the system — check before adding:"));
      matches.forEach(function (m) {
        var exactEmail = !!em && lc(m.email) === em;
        var exactName = !!nm && lc(m.name) === nm;
        var bits = [el("span", { class: "name" }, m.name), el("span", { class: "dupe-tier" }, TIER_LABEL[m.tier] || m.tier)];
        if (m.email) bits.push(el("span", { class: "student-email" }, m.email));
        if (m.coachName) bits.push(el("span", { class: "dupe-coach" }, "Coach: " + m.coachName));
        if (exactEmail) bits.push(el("span", { class: "dupe-flag dupe-flag--email" }, "Email in use"));
        else if (exactName) bits.push(el("span", { class: "dupe-flag" }, "Same name"));
        panel.appendChild(el("div", { class: "dupe-row" + (exactEmail ? " is-email" : (exactName ? " is-name" : "")) }, bits));
      });
    }
    function schedule(input) {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { panel.textContent = ""; panel.hidden = true; return; }
      timer = setTimeout(function () { dupeLookup(kind, q).then(render).catch(function () {}); }, 250);
    }
    nameInput.addEventListener("input", function () { schedule(nameInput); });
    emailInput.addEventListener("input", function () { schedule(emailInput); });
  }

  // Coach: add an athlete. The server generates a one-time passcode the coach emails them.
  function openAddAthleteModal(prefillName) {
    var name = el("input", { type: "text", value: prefillName || "", placeholder: "Athlete's name" });
    var email = el("input", { type: "email", placeholder: "their@email.com", autocomplete: "off" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var matchesPanel = el("div", { class: "dupe-matches" }); matchesPanel.hidden = true;
    var dupCheck = el("input", { type: "checkbox" });
    var dupConfirm = el("label", { class: "dupe-confirm" }, [dupCheck, el("span", {}, " This is a different person — create anyway")]); dupConfirm.hidden = true;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "We'll create the athlete and generate a random passcode for them. Email them their email address + that passcode — they sign in with those. Nothing to set up on their end."),
      el("div", { class: "field" }, [el("label", {}, "Name"), name]),
      el("div", { class: "field" }, [el("label", {}, "Email"), email]),
      matchesPanel,
      errBox,
      dupConfirm
    ]);
    attachDupeSearch("athlete", name, email, matchesPanel);
    function submit() {
      errBox.hidden = true;
      var nm = name.value.trim(), em = email.value.trim();
      if (!nm || !em) { errBox.textContent = "Name and email are both required."; errBox.hidden = false; return; }
      var payload = { name: nm, email: em };
      if (dupCheck.checked) payload.allowDuplicateName = true;
      api("/athletes", { method: "POST", body: payload }).then(function (res) {
        if (!res.ok) {
          errBox.textContent = apiError(res, "Couldn't add athlete."); errBox.hidden = false;
          if (res.data && res.data.code === "DUPLICATE_NAME") dupConfirm.hidden = false;
          return;
        }
        closeModal();
        refreshFromServer().then(function () { renderAll(); showCredentialsModal(res.data); });
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    openModal("Add athlete", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create & get passcode", accent: true, onClick: submit }
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }
  // Show the one-time login credentials (email + passcode) the coach emails to a student.
  function showCredentialsModal(data) {
    var athlete = (data && (data.athlete || data.coach || data.user)) || {};
    var who = athlete.name || "this person";
    var email = athlete.email || "";
    var passcode = (data && data.passcode) || "";
    var loginUrl = (data && data.loginUrl) || location.origin + "/";

    var creds = "Email: " + email + "\nPasscode: " + passcode + "\nSign in at: " + loginUrl;
    var emailField = el("input", { type: "text", value: email, readonly: true });
    var passField = el("input", { type: "text", value: passcode, readonly: true, style: "font-family:monospace; letter-spacing:0.5px" });
    [emailField, passField].forEach(function (i) { i.addEventListener("focus", function () { this.select(); }); });

    var subject = encodeURIComponent("Your PerformanceXtra login");
    var bodyText = encodeURIComponent(
      "Hi " + who + ",\n\nYou've been set up on PerformanceXtra. Sign in with:\n\n" +
      "Email: " + email + "\nPasscode: " + passcode + "\n\nSign in here: " + loginUrl +
      "\n\nYou can keep using this passcode to sign in.\n"
    );
    var mailto = "mailto:" + encodeURIComponent(email) + "?subject=" + subject + "&body=" + bodyText;

    var body = el("div", { class: "form-stack" }, [
      el("p", {}, "Send these sign-in details to " + who + ". This passcode is shown once — copy it now. If it's lost, use “Reset passcode” on their row to make a new one."),
      el("div", { class: "field" }, [el("label", {}, "Email"), emailField]),
      el("div", { class: "field" }, [el("label", {}, "Passcode"), passField]),
      el("a", { class: "btn btn--block", href: mailto }, "✉ Email " + who)
    ]);
    openModal("Sign-in details", body, [
      { label: "Copy details", primary: true, onClick: function () { copyText(creds).then(function (ok) { toast(ok ? "Login details copied" : "Couldn't copy — select them manually"); }); } },
      { label: "Done", onClick: closeModal }
    ]);
    setTimeout(function () { passField.focus(); passField.select(); }, 30);
  }
  function resetPasscode(s) {
    if (!confirm("Generate a new passcode for " + s.name + "? Their old passcode stops working.")) return;
    api("/athletes/" + encodeURIComponent(s.id) + "/reset-passcode", { method: "POST" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't reset passcode")); return; }
      refreshFromServer().then(function () { renderStudents(); });
      showCredentialsModal(res.data);
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  // Server-mode athlete delete (the offline-only deleteStudent() just mutates local state).
  // Removes the athlete and all of their data on the server, then refreshes the roster.
  function deleteAthleteServer(s) {
    if (!confirm("Permanently delete " + s.name + " and ALL their data (completions, check-ins, journal, messages)? This can't be undone.")) return;
    api("/athletes/" + encodeURIComponent(s.id), { method: "DELETE" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't delete athlete")); return; }
      refreshFromServer().then(function () { renderAll(); toast("Deleted " + s.name); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  /* ============================================================================
     Staff management (Coaches / Admins tabs) + Appearance (theme + page builder)
     These replace the old standalone super-admin screen: admins & super admins now
     use the same tabbed app, with extra tabs that grow with their rank.
     ============================================================================ */

  // Re-pull the staff rosters from the server, then re-render whichever staff tab is open.
  function refreshStaff() {
    return api("/bootstrap").then(function (res) {
      if (res.ok && res.data) {
        if (Array.isArray(res.data.coaches)) state.coaches = res.data.coaches;
        if (Array.isArray(res.data.admins)) state.admins = res.data.admins;
        if (Array.isArray(res.data.superadmins)) state.superadmins = res.data.superadmins;
      }
      if (state.tab === "manage") renderManage();
    }).catch(function () { toast("Couldn't refresh"); });
  }

  function staffPanel(title, addLabel, tier, rows) {
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, title),
      el("button", { class: "btn btn--sm btn--primary", onclick: function () { openAddStaffModal(tier); } }, addLabel)
    ]));
    var list = el("div", { class: "student-list" });
    panel.appendChild(list);
    renderStaffList(list, rows, tier);
    return panel;
  }

  function renderStaffList(list, rows, tier) {
    list.textContent = "";
    rows = rows || [];
    if (!rows.length) {
      var none = tier === "coach" ? "No coaches yet. Add your first coach to get started."
        : (tier === "admin" ? "No admins yet." : "Only the seeded super admin exists so far.");
      list.appendChild(el("p", { class: "no-link" }, none));
      return;
    }
    rows.forEach(function (c) {
      var bits = [];
      if (tier === "coach") bits.push(c.studentCount + " student" + (c.studentCount === 1 ? "" : "s"));
      if (!c.hasPassword) bits.push("no password set yet");
      var meta = bits.join(" · ");
      var nameKids = [el("span", { class: "name" }, c.name), el("span", { class: "student-email", title: "Signs in with this email" }, c.email)];
      var row = el("div", { class: "student-row" }, [el("span", { class: "name-wrap" }, nameKids)]);
      var actions = el("div", { class: "student-row-actions" });
      if (meta) actions.appendChild(el("span", { class: "student-row-meta" }, meta));
      // Coaches/admins can own athletes — let the admin above them view (and clear) that
      // roster, which is required before the staff account itself can be deleted.
      if (tier === "coach" || tier === "admin") {
        actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "View and manage this " + tier + "'s students", onclick: function () { openCoachStudentsModal(c, tier); } }, "View students"));
      }
      actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new passcode to send them", onclick: function () { resetStaffPasscode(c, tier); } }, "↻ Reset passcode"));
      // No delete on super admins (the top tier is never removable via the UI).
      if (tier !== "superadmin") {
        actions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this " + tier, "aria-label": "Delete " + c.name, onclick: function () { deleteStaff(c, tier); } }, "✕ Delete"));
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // One "Team" surface for all staff management. An admin sees the Coaches section
  // (they can create coaches); a super admin additionally sees the Admins and Super
  // admins sections, so adding any kind of account happens in one obvious place.
  function renderManage() {
    var view = $("#view-manage");
    if (!view) return;
    view.textContent = "";
    view.appendChild(el("div", { class: "view-intro" }, [
      el("h2", {}, "Team"),
      el("p", {}, isSuperadmin()
        ? "Manage everyone who runs the program. Coaches manage their own athletes; admins also create coaches; super admins can do everything, including the global library and site appearance. Each person signs in with their email and a one-time passcode you send them, then sets their own password."
        : "Create and manage coach accounts. Each coach signs in with their email and a one-time passcode you send them, then manages their own athletes.")
    ]));
    view.appendChild(staffPanel("Coaches", "+ Add coach", "coach", state.coaches || []));
    if (isSuperadmin()) {
      view.appendChild(staffPanel("Admins", "+ Add admin", "admin", state.admins || []));
      view.appendChild(staffPanel("Super admins", "+ Add super admin", "superadmin", state.superadmins || []));
    }
  }

  // Create a coach (POST /coaches) or an admin/super admin (POST /users {tier}).
  function openAddStaffModal(tier) {
    var who = { coach: "coach", admin: "admin", superadmin: "super admin" }[tier] || "user";
    var name = el("input", { type: "text", placeholder: "Full name" });
    var email = el("input", { type: "email", placeholder: "name@email.com", autocomplete: "off" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var matchesPanel = el("div", { class: "dupe-matches" }); matchesPanel.hidden = true;
    var dupCheck = el("input", { type: "checkbox" });
    var dupConfirm = el("label", { class: "dupe-confirm" }, [dupCheck, el("span", {}, " This is a different person — create anyway")]); dupConfirm.hidden = true;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "We'll create the " + who + " and generate a one-time passcode. Send them their email + that passcode — they sign in with those and can set their own password afterwards."),
      el("div", { class: "field" }, [el("label", {}, "Name"), name]),
      el("div", { class: "field" }, [el("label", {}, "Email"), email]),
      matchesPanel,
      errBox,
      dupConfirm
    ]);
    attachDupeSearch("staff", name, email, matchesPanel);
    function submit() {
      errBox.hidden = true;
      var nm = name.value.trim(), em = email.value.trim();
      if (!nm || !em) { errBox.textContent = "Name and email are both required."; errBox.hidden = false; return; }
      var path = tier === "coach" ? "/coaches" : "/users";
      var payload = tier === "coach" ? { name: nm, email: em } : { tier: tier, name: nm, email: em };
      if (dupCheck.checked) payload.allowDuplicateName = true;
      api(path, { method: "POST", body: payload }).then(function (res) {
        if (!res.ok) {
          errBox.textContent = apiError(res, "Couldn't add " + who + "."); errBox.hidden = false;
          if (res.data && res.data.code === "DUPLICATE_NAME") dupConfirm.hidden = false;
          return;
        }
        closeModal();
        refreshStaff().then(function () { showCredentialsModal(res.data); });
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    openModal("Add " + who, body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create & get passcode", accent: true, onClick: submit }
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }

  function resetStaffPasscode(c, tier) {
    if (!confirm("Generate a new passcode for " + c.name + "? Their old passcode stops working.")) return;
    var path = (tier === "coach" ? "/coaches/" : "/users/") + encodeURIComponent(c.id) + "/reset-passcode";
    api(path, { method: "POST" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't reset passcode")); return; }
      refreshStaff().then(function () { showCredentialsModal(res.data); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  // Delete a coach (admin+) or admin (super admin). The server refuses while the account
  // still has students (HAS_STUDENTS); when that happens we open their roster so the admin
  // can clear it first. Super admins are never deletable (no button is rendered for them).
  function deleteStaff(c, tier) {
    if (tier === "superadmin") return;
    if (!confirm("Permanently delete " + c.name + " (" + tier + ")? Their private content (custom activities, templates, taxonomy) will be removed. This can't be undone.")) return;
    var path = (tier === "coach" ? "/coaches/" : "/users/") + encodeURIComponent(c.id);
    api(path, { method: "DELETE" }).then(function (res) {
      if (!res.ok) {
        if (res.data && res.data.code === "HAS_STUDENTS") { toast(apiError(res, "Remove their students first")); openCoachStudentsModal(c, tier); return; }
        toast(apiError(res, "Couldn't delete")); return;
      }
      refreshStaff().then(function () { toast("Deleted " + c.name); });
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  // Admin/super-admin view of another staff member's athletes, each with a delete button.
  // Used to empty a coach/admin before deleting them. Re-fetches after each delete so the
  // list (and the Team roster's student counts, via refreshStaff) stays accurate.
  function openCoachStudentsModal(c, tier) {
    var listBox = el("div", { class: "student-list" });
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "Students belonging to " + c.name + ". Delete them here to free up this " + tier + " for removal."),
      listBox
    ]);
    function load() {
      listBox.textContent = "Loading…";
      api("/athletes?coachId=" + encodeURIComponent(c.id)).then(function (res) {
        listBox.textContent = "";
        var rows = (res.ok && res.data && res.data.athletes) || [];
        if (!rows.length) { listBox.appendChild(el("p", { class: "no-link" }, "No students — this " + tier + " can be deleted now.")); return; }
        rows.forEach(function (s) {
          var nameKids = [el("span", { class: "name" }, s.name)];
          if (s.email) nameKids.push(el("span", { class: "student-email" }, s.email));
          var row = el("div", { class: "student-row" }, [el("span", { class: "name-wrap" }, nameKids)]);
          row.appendChild(el("div", { class: "student-row-actions" }, [
            el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this athlete and all their data", "aria-label": "Delete " + s.name, onclick: function () {
              if (!confirm("Permanently delete " + s.name + " and ALL their data? This can't be undone.")) return;
              api("/athletes/" + encodeURIComponent(s.id), { method: "DELETE" }).then(function (r) {
                if (!r.ok) { toast(apiError(r, "Couldn't delete")); return; }
                toast("Deleted " + s.name); load(); refreshStaff();
              }).catch(function () { toast("Couldn't reach the server"); });
            } }, "✕ Delete")
          ]));
          listBox.appendChild(row);
        });
      }).catch(function () { listBox.textContent = ""; listBox.appendChild(el("p", { class: "no-link" }, "Couldn't load students.")); });
    }
    openModal(c.name + " · students", body, [{ label: "Done", primary: true, onClick: closeModal }]);
    load();
  }

  /* ----------------------------- Appearance: theme ----------------------------- */
  // Client mirror of the server's DEFAULT_THEME (used for "Reset to defaults").
  var DEFAULT_THEME_C = {
    accent: "#c9f24e", ember: "#ff6a3d", bg: "#0b0d12", surface: "#14171f",
    ink: "#f1f4f8", line: "rgba(255,255,255,.08)", danger: "#ff5d6c", warn: "#f5c451",
    radius: "14px", space: "16px",
    fontBody: "\"Hanken Grotesk\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
    fontDisplay: "\"Bricolage Grotesque\", \"Hanken Grotesk\", system-ui, sans-serif",
    fontScale: "1"
  };
  var THEME_VAR_MAP = {
    accent: "--accent", ember: "--ember", bg: "--bg", surface: "--surface",
    ink: "--ink", line: "--line", danger: "--danger", warn: "--warn",
    radius: "--radius", space: "--space", fontBody: "--font", fontDisplay: "--display"
  };
  // Apply saved theme tokens as CSS variables on :root (the new baseline). The light/dark
  // toggle, which sets vars on <body>, still layers on top for the light palette.
  function applySiteTheme(theme) {
    if (!theme) return;
    var r = document.documentElement;
    Object.keys(THEME_VAR_MAP).forEach(function (k) {
      if (theme[k] != null && theme[k] !== "") r.style.setProperty(THEME_VAR_MAP[k], theme[k]);
    });
    if (theme.fontScale != null && theme.fontScale !== "") r.style.setProperty("--font-scale", theme.fontScale);
    if (theme.accent) { r.style.setProperty("--brand", theme.accent); r.style.setProperty("--success", theme.accent); }
  }
  // Fetch the saved site theme/copy and apply it. Safe pre-login (the endpoint is public)
  // and tolerant of a missing/empty table (returns defaults, so it never blocks boot).
  function loadAndApplySiteTheme() {
    return api("/site").then(function (res) {
      if (res.ok && res.data && res.data.theme) { state.site = res.data; applySiteTheme(res.data.theme); }
    }).catch(function () {});
  }
  function toHex(v) { v = String(v || "").trim(); return /^#[0-9a-fA-F]{6}$/.test(v) ? v : ""; }
  function safeUrl(u) { u = String(u || "").trim(); return /^https:\/\//i.test(u) ? u : ""; }
  function safeMaxWidth(v) {
    v = String(v == null ? "" : v).trim();
    var m = v.match(/^((?:[0-9]{1,3}|1[0-9]{3}|2000))(px|%)$/);
    if (!m) return "";
    return String(Number(m[1])) + m[2];
  }

  function renderAppearance() {
    var view = $("#view-appearance");
    if (!view) return;
    // The theme may already be loaded at boot (loadAndApplySiteTheme), but the page list
    // is fetched lazily here. Load whichever is still missing before rendering.
    if (!state.site || !state.pages) {
      view.textContent = "";
      view.appendChild(el("p", { class: "field-hint" }, "Loading appearance…"));
      Promise.all([
        state.site ? Promise.resolve({ data: state.site }) : api("/site"),
        state.pages ? Promise.resolve({ data: { pages: state.pages } }) : api("/pages")
      ]).then(function (out) {
        var s = out[0] && out[0].data, p = out[1] && out[1].data;
        state.site = (s && s.theme) ? s : { theme: Object.assign({}, DEFAULT_THEME_C), site: {} };
        state.pages = (p && p.pages) ? p.pages : [];
        renderAppearance();
      }).catch(function () {
        state.site = state.site || { theme: Object.assign({}, DEFAULT_THEME_C), site: {} };
        state.pages = state.pages || [];
        renderAppearance();
      });
      return;
    }
    view.textContent = "";
    view.appendChild(el("div", { class: "view-intro" }, [
      el("h2", {}, "Appearance"),
      el("p", {}, "Change the site's colors, fonts and sizes, and build the landing page from content blocks. Changes are saved to the database and apply to everyone.")
    ]));
    view.appendChild(renderThemeEditor());
    view.appendChild(renderPageBuilder());
  }

  function renderThemeEditor() {
    var theme = Object.assign({}, DEFAULT_THEME_C, state.site.theme || {});
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Theme")]));

    var COLORS = [["accent", "Accent"], ["ember", "Secondary accent"], ["bg", "Background"], ["surface", "Surface / cards"], ["ink", "Text"], ["danger", "Danger"], ["warn", "Warning"]];
    var colorGrid = el("div", { class: "appearance-grid" });
    COLORS.forEach(function (pair) {
      var input = el("input", { type: "color", value: toHex(theme[pair[0]]) || "#000000" });
      input.addEventListener("input", function () { theme[pair[0]] = input.value; applySiteTheme(theme); });
      colorGrid.appendChild(el("label", { class: "appearance-field" }, [el("span", {}, pair[1]), input]));
    });
    panel.appendChild(colorGrid);

    var FONTS = [
      ["\"Hanken Grotesk\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif", "Hanken Grotesk"],
      ["\"Bricolage Grotesque\", \"Hanken Grotesk\", system-ui, sans-serif", "Bricolage Grotesque"],
      ["\"JetBrains Mono\", ui-monospace, Menlo, monospace", "JetBrains Mono"],
      ["system-ui, -apple-system, sans-serif", "System default"],
      ["Georgia, \"Times New Roman\", serif", "Georgia (serif)"]
    ];
    function fontSelect(key, label) {
      var sel = el("select", {});
      FONTS.forEach(function (o) { var op = el("option", { value: o[0] }, o[1]); if (lc(theme[key]) === lc(o[0])) op.selected = true; sel.appendChild(op); });
      sel.addEventListener("change", function () { theme[key] = sel.value; applySiteTheme(theme); });
      return el("label", { class: "appearance-field" }, [el("span", {}, label), sel]);
    }
    panel.appendChild(el("div", { class: "appearance-grid" }, [fontSelect("fontBody", "Body font"), fontSelect("fontDisplay", "Heading font")]));

    function slider(key, label, min, max, step, unit) {
      var cur = parseFloat(theme[key]); if (isNaN(cur)) cur = parseFloat(DEFAULT_THEME_C[key]) || 1;
      var out = el("span", { class: "appearance-val" }, cur + unit);
      var input = el("input", { type: "range", min: min, max: max, step: step, value: cur });
      input.addEventListener("input", function () { theme[key] = input.value + unit; out.textContent = input.value + unit; applySiteTheme(theme); });
      return el("label", { class: "appearance-field" }, [el("span", {}, label), el("div", { class: "appearance-slider" }, [input, out])]);
    }
    panel.appendChild(el("div", { class: "appearance-grid" }, [
      slider("fontScale", "Text size", 0.8, 1.4, 0.05, ""),
      slider("radius", "Corner radius", 0, 28, 1, "px"),
      slider("space", "Spacing", 8, 28, 1, "px")
    ]));

    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
        applySiteTheme(DEFAULT_THEME_C); state.site.theme = Object.assign({}, DEFAULT_THEME_C); renderAppearance();
      } }, "Reset to defaults"),
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { theme: theme } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          applySiteTheme(state.site.theme); toast("Appearance saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save appearance")
    ]));
    return panel;
  }

  /* ----------------------------- Appearance: page builder ----------------------------- */
  function newBlock(type) {
    var id = "b" + Math.random().toString(36).slice(2, 8);
    var props = {};
    if (type === "hero") props = { heading: "Headline", sub: "Supporting sentence goes here.", ctaLabel: "Get started", ctaHref: "", align: "center" };
    else if (type === "heading") props = { text: "Section heading", level: 2 };
    else if (type === "text") props = { text: "Write a paragraph of text here." };
    else if (type === "image") props = { src: "", alt: "", width: "" };
    else if (type === "cards") props = { items: [{ title: "Card title", body: "Card text", icon: "★" }] };
    else if (type === "button") props = { label: "Button", href: "", style: "primary" };
    else if (type === "spacer") props = { size: "md" };
    return { id: id, type: type, props: props };
  }
  function addBlock(type) { state.pageDraft.blocks.push(newBlock(type)); renderAppearance(); }
  function moveBlock(i, dir) {
    var b = state.pageDraft.blocks, j = i + dir;
    if (j < 0 || j >= b.length) return;
    var tmp = b[i]; b[i] = b[j]; b[j] = tmp; renderAppearance();
  }
  function blockSummary(b) {
    var p = b.props || {};
    if (b.type === "hero") return p.heading || "(hero)";
    if (b.type === "heading") return p.text || "(heading)";
    if (b.type === "text") return (p.text || "").slice(0, 60) || "(text)";
    if (b.type === "image") return p.src || "(no image)";
    if (b.type === "cards") return (p.items || []).length + " card" + ((p.items || []).length === 1 ? "" : "s");
    if (b.type === "button") return p.label || "(button)";
    if (b.type === "spacer") return p.size || "md";
    return "";
  }
  function renderPageBuilder() {
    if (!state.pageDraft) {
      var existing = (state.pages || []).filter(function (p) { return p.id === "landing"; })[0];
      state.pageDraft = existing
        ? { id: "landing", title: existing.title || "Landing", blocks: (existing.blocks || []).slice(), published: !!existing.published }
        : { id: "landing", title: "Landing", blocks: [], published: false };
    }
    var draft = state.pageDraft;
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Page builder"), el("span", { class: "cms-count" }, "Landing page")]));

    var titleInput = el("input", { type: "text", value: draft.title });
    titleInput.addEventListener("input", function () { draft.title = titleInput.value; });
    var pubCb = el("input", { type: "checkbox" }); pubCb.checked = !!draft.published;
    pubCb.addEventListener("change", function () { draft.published = pubCb.checked; });
    panel.appendChild(el("div", { class: "appearance-grid" }, [
      el("label", { class: "appearance-field" }, [el("span", {}, "Page title"), titleInput]),
      el("label", { class: "check" }, [pubCb, " Published (visible to visitors)"])
    ]));

    var palette = el("div", { class: "builder-palette" });
    [["hero", "Hero"], ["heading", "Heading"], ["text", "Text"], ["image", "Image"], ["cards", "Cards"], ["button", "Button"], ["spacer", "Spacer"]].forEach(function (pair) {
      palette.appendChild(el("button", { class: "btn btn--sm btn--ghost", onclick: function () { addBlock(pair[0]); } }, "+ " + pair[1]));
    });
    panel.appendChild(el("div", { class: "builder-section" }, [el("div", { class: "detail-label" }, "Add a block"), palette]));

    var canvas = el("div", { class: "builder-canvas" });
    if (!draft.blocks.length) canvas.appendChild(el("p", { class: "no-link" }, "No blocks yet. Add one above to start building the page."));
    draft.blocks.forEach(function (b, i) {
      canvas.appendChild(el("div", { class: "builder-block" }, [
        el("div", { class: "builder-block-head" }, [
          el("span", { class: "chip chip--accent" }, b.type),
          el("span", { class: "builder-block-summary" }, blockSummary(b))
        ]),
        el("div", { class: "cms-actions" }, [
          el("button", { class: "btn btn--sm", onclick: function () { openBlockModal(i); } }, "Edit"),
          el("button", { class: "btn btn--sm btn--ghost", disabled: i === 0, onclick: function () { moveBlock(i, -1); } }, "↑"),
          el("button", { class: "btn btn--sm btn--ghost", disabled: i === draft.blocks.length - 1, onclick: function () { moveBlock(i, 1); } }, "↓"),
          el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { draft.blocks.splice(i, 1); renderAppearance(); } }, "Delete")
        ])
      ]));
    });
    panel.appendChild(el("div", { class: "builder-section" }, [el("div", { class: "detail-label" }, "Blocks"), canvas]));

    var preview = el("div", { class: "builder-preview" });
    renderPageBlocks(draft.blocks, preview);
    panel.appendChild(el("div", { class: "builder-section" }, [el("div", { class: "detail-label" }, "Preview"), preview]));

    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: savePage }, "Save page")
    ]));
    return panel;
  }
  function renderCardsEditor(fields, p) {
    if (!Array.isArray(p.items)) p.items = [];
    var list = el("div", { class: "form-stack" });
    function draw() {
      list.textContent = "";
      p.items.forEach(function (it, idx) {
        var icon = el("input", { type: "text", placeholder: "Icon", value: it.icon || "", maxlength: "4", style: "max-width:64px" });
        icon.addEventListener("input", function () { it.icon = icon.value; });
        var title = el("input", { type: "text", placeholder: "Title", value: it.title || "" });
        title.addEventListener("input", function () { it.title = title.value; });
        var bodyI = el("input", { type: "text", placeholder: "Text", value: it.body || "" });
        bodyI.addEventListener("input", function () { it.body = bodyI.value; });
        var del = el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { p.items.splice(idx, 1); draw(); } }, "×");
        list.appendChild(el("div", { class: "builder-card-row" }, [icon, title, bodyI, del]));
      });
    }
    draw();
    fields.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Cards"), list,
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () { p.items.push({ title: "Card", body: "", icon: "★" }); draw(); } }, "+ Add card")
    ]));
  }
  function openBlockModal(i) {
    var b = state.pageDraft.blocks[i];
    if (!b) return;
    var p = Object.assign({}, b.props || {});
    var fields = el("div", { class: "form-stack" });
    function textField(key, label, ta) {
      var input = ta ? el("textarea", { rows: 3 }) : el("input", { type: "text" });
      input.value = p[key] != null ? p[key] : "";
      input.addEventListener("input", function () { p[key] = input.value; });
      fields.appendChild(el("div", { class: "field" }, [el("label", {}, label), input]));
    }
    function selectField(key, label, opts) {
      var sel = el("select", {});
      opts.forEach(function (o) { var op = el("option", { value: o[0] }, o[1]); if (String(p[key]) === String(o[0])) op.selected = true; sel.appendChild(op); });
      sel.addEventListener("change", function () { p[key] = sel.value; });
      fields.appendChild(el("div", { class: "field" }, [el("label", {}, label), sel]));
    }
    if (b.type === "hero") {
      textField("heading", "Heading"); textField("sub", "Subheading", true);
      textField("ctaLabel", "Button label"); textField("ctaHref", "Button link (https://…)");
      selectField("align", "Align", [["center", "Center"], ["left", "Left"], ["right", "Right"]]);
    } else if (b.type === "heading") {
      textField("text", "Text");
      selectField("level", "Size", [[1, "Large (H1)"], [2, "Medium (H2)"], [3, "Small (H3)"]]);
    } else if (b.type === "text") {
      textField("text", "Text", true);
    } else if (b.type === "image") {
      textField("src", "Image URL (https://…)"); textField("alt", "Alt text"); textField("width", "Max width (e.g. 480px)");
    } else if (b.type === "button") {
      textField("label", "Label"); textField("href", "Link (https://…)");
      selectField("style", "Style", [["primary", "Primary"], ["ember", "Secondary"], ["ghost", "Ghost"]]);
    } else if (b.type === "spacer") {
      selectField("size", "Size", [["sm", "Small"], ["md", "Medium"], ["lg", "Large"]]);
    } else if (b.type === "cards") {
      renderCardsEditor(fields, p);
    }
    openModal("Edit " + b.type, fields, [
      { label: "Cancel", onClick: closeModal },
      { label: "Done", accent: true, onClick: function () {
        if (b.type === "heading") p.level = parseInt(p.level, 10) || 2;
        b.props = p; closeModal(); renderAppearance();
      } }
    ]);
  }
  function savePage() {
    var draft = state.pageDraft;
    api("/pages/" + encodeURIComponent(draft.id), { method: "POST", body: { title: draft.title, blocks: draft.blocks, published: draft.published } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't save page")); return; }
      var d = res.data || {};
      state.pageDraft = { id: d.id || draft.id, title: d.title || draft.title, blocks: d.blocks || [], published: !!d.published };
      var found = false;
      state.pages = (state.pages || []).map(function (pg) {
        if (pg.id === state.pageDraft.id) { found = true; return Object.assign({}, pg, state.pageDraft); }
        return pg;
      });
      if (!found) state.pages.push(Object.assign({}, state.pageDraft));
      renderAppearance(); toast("Page saved");
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  // Render an ordered list of sanitized content blocks into a mount node. All text is
  // set via textContent (never innerHTML) and links/images are forced to https, so
  // rendering builder content can't inject script.
  function renderPageBlocks(blocks, mount) {
    mount.textContent = "";
    (blocks || []).forEach(function (b) {
      var fn = BLOCK_RENDERERS[b && b.type];
      if (!fn) return;
      var node = fn(b.props || {});
      if (node) mount.appendChild(node);
    });
  }
  var BLOCK_RENDERERS = {
    hero: function (p) {
      var kids = [el("h1", { class: "pb-hero-h" }, p.heading || "")];
      if (p.sub) kids.push(el("p", { class: "pb-hero-sub" }, p.sub));
      var href = safeUrl(p.ctaHref);
      if (p.ctaLabel && href) kids.push(el("a", { class: "btn btn--primary", href: href }, p.ctaLabel));
      return el("section", { class: "pb-hero", style: "text-align:" + (p.align === "left" || p.align === "right" ? p.align : "center") }, kids);
    },
    heading: function (p) {
      var tag = p.level === 1 || p.level === "1" ? "h1" : (p.level === 3 || p.level === "3" ? "h3" : "h2");
      return el(tag, { class: "pb-heading" }, p.text || "");
    },
    text: function (p) { return el("p", { class: "pb-text" }, p.text || ""); },
    image: function (p) {
      var src = safeUrl(p.src);
      if (!src) return null;
      var width = safeMaxWidth(p.width);
      return el("img", { class: "pb-image", src: src, alt: p.alt || "", style: width ? ("max-width:" + width) : "" });
    },
    cards: function (p) {
      var grid = el("div", { class: "pb-cards" });
      (p.items || []).forEach(function (it) {
        grid.appendChild(el("div", { class: "pb-card" }, [
          it.icon ? el("div", { class: "pb-card-icon" }, it.icon) : null,
          el("h3", {}, it.title || ""),
          el("p", {}, it.body || "")
        ]));
      });
      return grid;
    },
    button: function (p) {
      if (!p.label) return null;
      var cls = "btn " + (p.style === "ghost" ? "btn--ghost" : (p.style === "ember" ? "btn--ember" : "btn--primary"));
      return el("div", { class: "pb-button" }, [el("a", { class: cls, href: safeUrl(p.href) || "#" }, p.label)]);
    },
    spacer: function (p) {
      var h = p.size === "sm" ? 16 : (p.size === "lg" ? 64 : 32);
      return el("div", { style: "height:" + h + "px" });
    }
  };

  // Coach: pull an old exported localStorage backup into the shared database (T6).
  function handleServerImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = JSON.parse(reader.result); } catch (e) { toast("That file isn't valid JSON"); return; }
      if (!incoming || !incoming.students) { toast("Unrecognized backup file"); return; }
      toast("Importing…");
      api("/import", { method: "POST", body: incoming }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Import failed")); return; }
        refreshFromServer().then(function () {
          renderAll();
          var sm = res.data && res.data.summary;
          toast("Imported " + ((sm && sm.athletes) || 0) + " athletes, " + ((sm && sm.assignments) || 0) + " assignments");
        });
      }).catch(function () { toast("Couldn't reach the server"); });
    };
    reader.readAsText(file);
  }

  /* ----------------------------- Onboarding tour (T2) ----------------------------- */
  var TOUR_SEEN_PREFIX = "performancextra.tour.seen.";
  function tourSeen(role) { try { return localStorage.getItem(TOUR_SEEN_PREFIX + role) === "1"; } catch (e) { return false; } }
  function markTourSeen(role) { try { localStorage.setItem(TOUR_SEEN_PREFIX + role, "1"); } catch (e) {} }

  var TOUR_ADMIN = [
    { sel: ".brand", title: "Welcome, coach", text: "This is your PerformanceXtra coaching hub. Here's a 20-second tour of where everything lives." },
    { sel: "[data-tab=\"repo\"]", title: "Activity Repository", text: "Every mental-training activity, searchable and filterable. You can edit, hide, or assign any of them." },
    { sel: ".filter-bar", title: "Filter to what you need", text: "Narrow by topic, content type, progression week, or frequency to find the right activity fast." },
    { sel: "[data-tab=\"builder\"]", title: "Workout Builder", text: "Auto-assemble a session from criteria like “Month 1, Confidence”, then assign it to an athlete." },
    { sel: "[data-tab=\"students\"]", title: "Your athletes", text: "Add athletes, build them tailored assignments, and track each one's progress." },
    { sel: "#student-select", title: "Active athlete", text: "Pick who you're working with — assignments and progress follow this selection." },
    { sel: "[data-tab=\"settings\"]", title: "Settings", text: "Manage your account and back up or import data here." }
  ];
  var TOUR_STUDENT = [
    { sel: ".brand", title: "Welcome!", text: "This is your personal training space. Here's a quick tour." },
    { sel: "[data-tab=\"workouts\"]", title: "My Workouts", text: "The activities your coach assigned you. Work through them and tick each one done." },
    { sel: ".assign-item details.detail", title: "Read the instructions", text: "Open this to see the activity's instructions and reflection prompt — no need to leave the page." },
    { sel: "[data-tab=\"progress\"]", title: "My Progress", text: "See how much you've completed, broken down by topic and by week." }
  ];

  // Layout-independent visibility test: the element exists, isn't hidden/display:none,
  // and isn't inside an inactive tab panel. (Avoids relying on offsetParent.)
  function tourVisible(elm) {
    if (!elm || elm.hidden) return false;
    var cs = window.getComputedStyle(elm);
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    var p = elm;
    while (p && p !== document.body && p.nodeType === 1) {
      if (p.hidden) return false;
      if (p.classList && p.classList.contains("view") && !p.classList.contains("is-active")) return false;
      p = p.parentNode;
    }
    return true;
  }
  var tourState = null;
  function startTour(steps, force) {
    endTour();
    var avail = (steps || []).filter(function (s) { return tourVisible(document.querySelector(s.sel)); });
    if (!avail.length) { if (force) toast("Nothing to tour on this screen yet"); return; }
    tourState = { steps: avail, i: 0 };
    var backdrop = el("div", { class: "tour-backdrop", id: "tour-backdrop" });
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) endTour(); });
    document.body.appendChild(backdrop);
    document.body.appendChild(el("div", { class: "tour-tip", id: "tour-tip", role: "dialog", "aria-live": "polite", "aria-label": "Tour step" }));
    document.addEventListener("keydown", tourKeydown);
    showTourStep();
  }
  function tourKeydown(e) {
    if (!tourState) return;
    if (e.key === "Escape") endTour();
    else if (e.key === "ArrowRight") tourNext();
    else if (e.key === "ArrowLeft") tourPrev();
  }
  function endTour() {
    tourState = null;
    $all(".tour-highlight").forEach(function (n) { n.classList.remove("tour-highlight"); });
    var b = $("#tour-backdrop"); if (b) b.parentNode.removeChild(b);
    var t = $("#tour-tip"); if (t) t.parentNode.removeChild(t);
    document.removeEventListener("keydown", tourKeydown);
  }
  function tourNext() { if (!tourState) return; if (tourState.i >= tourState.steps.length - 1) { endTour(); return; } tourState.i++; showTourStep(); }
  function tourPrev() { if (!tourState) return; if (tourState.i <= 0) return; tourState.i--; showTourStep(); }
  function showTourStep() {
    if (!tourState) return;
    $all(".tour-highlight").forEach(function (n) { n.classList.remove("tour-highlight"); });
    var step = tourState.steps[tourState.i];
    var target = document.querySelector(step.sel);
    if (!target) { tourNext(); return; }
    target.classList.add("tour-highlight");
    try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    var tip = $("#tour-tip");
    tip.textContent = "";
    tip.appendChild(el("div", { class: "tour-counter" }, (tourState.i + 1) + " / " + tourState.steps.length));
    tip.appendChild(el("h4", { class: "tour-title" }, step.title));
    tip.appendChild(el("p", { class: "tour-text" }, step.text));
    var nav = el("div", { class: "tour-nav" });
    nav.appendChild(el("button", { class: "btn btn--sm btn--ghost", onclick: endTour }, "Skip"));
    if (tourState.i > 0) nav.appendChild(el("button", { class: "btn btn--sm", onclick: tourPrev }, "Back"));
    var last = tourState.i >= tourState.steps.length - 1;
    nav.appendChild(el("button", { class: "btn btn--sm btn--primary", onclick: tourNext }, last ? "Done" : "Next"));
    tip.appendChild(nav);
    // Position after layout so we can measure the tooltip.
    setTimeout(function () { positionTip(tip, target); }, 0);
  }
  function positionTip(tip, target) {
    var r = target.getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight, gap = 12;
    var top = r.bottom + gap;
    if (top + th > window.innerHeight - 8) {
      var above = r.top - th - gap;
      top = above > 8 ? above : Math.max(8, (window.innerHeight - th) / 2);
    }
    var left = r.left;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    if (left < 8) left = 8;
    tip.style.top = (top + window.pageYOffset) + "px";
    tip.style.left = (left + window.pageXOffset) + "px";
  }
  function maybeAutoTour() {
    var r = isAdminView() ? "admin" : "student";
    // The built-in tour is coach/athlete oriented ("Welcome, coach"); admins & super
    // admins have a different (and larger) tab set, so skip the auto-tour for them.
    if (r === "admin" && isAtLeastAdmin()) return;
    if (tourSeen(r)) return;
    markTourSeen(r);
    setTimeout(function () { startTour(r === "admin" ? TOUR_ADMIN : TOUR_STUDENT, true); }, 650);
  }

  /* ----------------------------- Default-passcode nudge (T3, LOCAL only) ----------------------------- */
  function maybeDefaultPasscodeNudge() {
    var b = $("#default-pass-banner");
    if (!b) return;
    b.hidden = !(!SERVER && isAdminView() && isUsingDefaultPasscode());
  }

  /* ----------------------------- Shared select refresh ----------------------------- */
  function refreshSelects() {
    var f = state.filters;
    fillSelect($("#f-topic"), PRESENT.topic, "All topics"); $("#f-topic").value = f.topic;
    syncSubtopicSelect($("#f-topic"), $("#f-subtopic"), "All subtopics", f.subtopic); f.subtopic = $("#f-subtopic").value;
    fillSelect($("#f-type"), PRESENT.type, "All types"); $("#f-type").value = f.type;
    fillSelect($("#f-progression"), PRESENT.progression, "All progressions"); $("#f-progression").value = f.progression;
    fillSelect($("#f-frequency"), PRESENT.frequency, "All frequencies"); $("#f-frequency").value = f.frequency;
  }

  function renderCatalogCount() {
    var node = $("#total-count");
    if (!node) return;
    node.textContent = ALL.length;
  }

  /* ----------------------------- Content / CMS (admin) ----------------------------- */
  function renderContent() {
    if (!isAdminView()) return;
    var nav = $("#cms-subnav");
    if (!nav) return;
    // Scope switch (super admin only): curate the shared Global library that every
    // coach/athlete sees, or your own private content. Coaches and admins only ever
    // edit their private content, so the switch stays hidden for them.
    var scopeWrap = $("#cms-scope");
    if (scopeWrap) {
      if (isSuperadmin()) {
        if (state.cmsScope !== "global") state.cmsScope = "private";
        scopeWrap.hidden = false;
        scopeWrap.textContent = "";
        [["private", "My content"], ["global", "Global library"]].forEach(function (pair) {
          var input = el("input", { type: "radio", name: "cms-scope", value: pair[0] });
          if (state.cmsScope === pair[0]) input.checked = true;
          input.addEventListener("change", function () { if (!input.checked) return; state.cmsScope = pair[0]; renderContent(); });
          scopeWrap.appendChild(el("label", {}, [input, el("span", {}, pair[1])]));
        });
      } else {
        scopeWrap.hidden = true;
        state.cmsScope = "private";
      }
    }
    currentCmsTarget = (isSuperadmin() && state.cmsScope === "global") ? "global" : "private";
    // Global scope edits the shared library only — fetch a global-only snapshot so the
    // lists below never include the editor's own private items (which would otherwise be
    // written back into the shared library when saving/renaming).
    if (cmsGlobal() && state.globalTracking == null) {
      state.globalTracking = { loading: true, customActivities: [], overrides: {}, hidden: {}, taxonomy: { topic: [], subtopic: [], type: [] } };
      loadGlobalTracking().then(function () { if (state.tab === "content") renderContent(); });
    }
    var sub = state.cmsTab === "taxonomy" ? "taxonomy" : "activities";
    nav.textContent = "";
    [["activities", "Activities"], ["taxonomy", "Topics & types"]].forEach(function (pair) {
      var input = el("input", { type: "radio", name: "cms-sub", value: pair[0] });
      if (sub === pair[0]) input.checked = true;
      input.addEventListener("change", function () {
        if (!input.checked) return;
        state.cmsTab = input.value || pair[0];
        renderContent();
      });
      var lbl = el("label", {}, [input, el("span", {}, pair[1])]);
      nav.appendChild(lbl);
    });
    $("#cms-activities").hidden = sub !== "activities";
    $("#cms-taxonomy").hidden = sub !== "taxonomy";
    if (cmsGlobal() && state.globalTracking && state.globalTracking.loading) {
      var pane = sub === "activities" ? $("#cms-activities") : $("#cms-taxonomy");
      pane.textContent = ""; pane.appendChild(el("p", { class: "no-link" }, "Loading the global library…"));
      return;
    }
    if (sub === "activities") renderCmsActivities(); else renderCmsTaxonomy();
  }

  function renderCmsActivities() {
    var wrap = $("#cms-activities");
    wrap.textContent = "";
    wrap.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Activity library"),
      el("button", { class: "btn btn--sm btn--accent", onclick: function () { openActivityModal(); } }, "+ Add activity")
    ]));
    var search = el("input", { type: "search", class: "cms-search", placeholder: "Search activities…" });
    search.value = state.cmsSearch || "";
    var hiddenCb = el("input", { type: "checkbox" });
    hiddenCb.checked = !!state.cmsShowHidden;
    hiddenCb.addEventListener("change", function () { state.cmsShowHidden = hiddenCb.checked; renderCmsActivities(); });
    wrap.appendChild(el("div", { class: "cms-toolbar" }, [
      search,
      el("label", { class: "check" }, [hiddenCb, " Show hidden"])
    ]));
    var tableWrap = el("div", { class: "cms-table-wrap" });
    wrap.appendChild(tableWrap);

    function draw() {
      var q = norm(search.value || "").trim();
      tableWrap.textContent = "";
      var rows = cmsActivityRows(state.cmsShowHidden);
      if (q) rows = rows.filter(function (a) { return smartSearchScore(a, q) > 0; });
      rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      tableWrap.appendChild(el("div", { class: "cms-count" }, rows.length + " activit" + (rows.length === 1 ? "y" : "ies")));
      if (!rows.length) { tableWrap.appendChild(el("p", { class: "no-link" }, "No activities match.")); return; }
      var table = el("div", { class: "cms-table" });
      rows.forEach(function (a) {
        var hid = cmsHidden(a.id);
        var tags = [];
        if (isCustom(a.id)) tags.push(el("span", { class: "chip chip--accent" }, "Custom"));
        if (hid) tags.push(el("span", { class: "chip" }, "Hidden"));
        table.appendChild(el("div", { class: "cms-row" + (hid ? " is-hidden" : "") }, [
          el("div", { class: "cms-cell cms-cell--name" }, [
            el("strong", {}, a.name),
            el("div", { class: "cms-meta" }, [a.topic, a.type, a.progression].filter(Boolean).join(" · ") || "—")
          ]),
          el("div", { class: "cms-cell cms-tags" }, tags),
          el("div", { class: "cms-cell cms-actions" }, [
            el("button", { class: "btn btn--sm", onclick: function () { openActivityModal(a.id); } }, "Edit"),
            el("button", { class: "btn btn--sm btn--ghost", onclick: function () { setHidden(a.id, !hid); renderAll(); } }, hid ? "Unhide" : "Hide"),
            isCustom(a.id) ? el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () {
              if (confirm("Delete this custom activity?")) { deleteCustomActivity(a.id); renderAll(); toast("Deleted"); }
            } }, "Delete") : null
          ])
        ]));
      });
      tableWrap.appendChild(table);
    }
    var timer;
    search.addEventListener("input", function () { state.cmsSearch = search.value; clearTimeout(timer); timer = setTimeout(draw, 120); });
    draw();
  }

  function renderCmsTaxonomy() {
    var wrap = $("#cms-taxonomy");
    wrap.textContent = "";
    wrap.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Topics, subtopics & content types"),
      el("span", { class: "cms-count" }, "Drive every filter, the builder and activity tags")
    ]));
    [["topic", "Topics"], ["subtopic", "Subtopics"], ["type", "Content types"]].forEach(function (pair) {
      wrap.appendChild(renderTaxGroup(pair[0], pair[1]));
    });
  }
  function singular(label) { return label.toLowerCase().replace(/s$/, ""); }
  function renderTaxGroup(kind, label) {
    var values = cmsTaxList(kind);
    var usage = cmsTaxUsage(kind);
    var group = el("div", { class: "cms-tax-group" });
    group.appendChild(el("div", { class: "detail-label" }, label + " (" + values.length + ")"));
    // Add box sits at the top so adding never requires scrolling past the whole list. The
    // list itself stays alphabetical (cmsTaxList -> alpha()), so a new item lands in place.
    var input = el("input", { type: "text", placeholder: "Add a " + singular(label) });
    function add() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      taxonomyFlow(kind, "add", { value: v }, function () { renderContent(); toast("Added “" + v + "”"); });
    }
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });
    group.appendChild(el("div", { class: "cms-tax-add" }, [input, el("button", { class: "btn btn--sm btn--accent", onclick: add }, "+ Add")]));
    var list = el("div", { class: "cms-tax-list" });
    if (!values.length) list.appendChild(el("p", { class: "no-link" }, "No items yet."));
    values.forEach(function (v) {
      var n = usage[lc(v)] || 0;
      list.appendChild(el("div", { class: "cms-tax-row" }, [
        el("span", { class: "cms-tax-name" }, v),
        el("span", { class: "cms-tax-usage" }, n + " activit" + (n === 1 ? "y" : "ies")),
        el("div", { class: "cms-actions" }, [
          el("button", { class: "btn btn--sm", onclick: function () { openTaxRenameModal(kind, label, v); } }, "Rename"),
          el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { openTaxRemoveModal(kind, label, v, n); } }, "Remove")
        ])
      ]));
    });
    group.appendChild(list);
    return group;
  }
  function openTaxRenameModal(kind, label, from) {
    var input = el("input", { type: "text" }); input.value = from;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "Rename “" + from + "” everywhere. Every activity tagged with it is updated. Renaming to a name that already exists merges the two."),
      el("div", { class: "field" }, [el("label", {}, "New name"), input])
    ]);
    openModal("Rename " + singular(label), body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Rename", accent: true, onClick: function () {
        var to = input.value.trim();
        if (!to) { input.focus(); return; }
        if (lc(to) === lc(from)) { closeModal(); return; }
        taxonomyFlow(kind, "rename", { from: from, to: to }, function () { closeModal(); renderContent(); toast("Renamed"); });
      } }
    ]);
  }
  function openTaxRemoveModal(kind, label, value, n) {
    var body = el("div", { class: "form-stack" }, [
      el("p", {}, "Remove “" + value + "” from your " + label.toLowerCase() + "?"),
      el("p", { class: "field-hint" }, n
        ? ("It's currently on " + n + " activit" + (n === 1 ? "y" : "ies") + ". Those activities stay, but lose this tag.")
        : "Nothing is tagged with it.")
    ]);
    openModal("Remove " + value, body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Remove", danger: true, onClick: function () {
        taxonomyFlow(kind, "remove", { value: value }, function () { closeModal(); renderContent(); toast("Removed"); });
      } }
    ]);
  }

  function renderAll() {
    renderCatalogCount();
    renderStudentPicker();
    renderRepo();
    if (isAdminView()) {
      renderStudents();
      renderContent();
      if (state.tab === "manage" && isAtLeastAdmin()) renderManage();
      if (state.tab === "appearance" && isSuperadmin()) renderAppearance();
    } else {
      renderWorkoutsTab();
      renderCheckinTab();
      renderMessagesTab();
      renderProgressTab();
    }
  }

  /* ----------------------------- Init ----------------------------- */
  function init() {
    if (!storageOK) $("#storage-warning").hidden = false;
    applyTheme(detectTheme());
    renderCatalogCount();

    // Resume the admin role if this browser session already authenticated.
    state.view = isAuthed() ? "admin" : "student";

    // Repository filters
    fillSelect($("#f-topic"), PRESENT.topic, "All topics");
    fillSelect($("#f-subtopic"), PRESENT.subtopic, "All subtopics");
    fillSelect($("#f-type"), PRESENT.type, "All types");
    fillSelect($("#f-progression"), PRESENT.progression, "All progressions");
    fillSelect($("#f-frequency"), PRESENT.frequency, "All frequencies");

    var searchTimer;
    $("#f-search").addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      var v = e.target.value;
      searchTimer = setTimeout(function () { state.filters.search = v; renderRepo(); }, 150);
    });
    [["subtopic", "f-subtopic"], ["type", "f-type"], ["progression", "f-progression"], ["frequency", "f-frequency"]]
      .forEach(function (pair) {
        $("#" + pair[1]).addEventListener("change", function (e) { state.filters[pair[0]] = e.target.value; renderRepo(); });
      });
    // Topic drives the subtopic list: narrow it to subtopics that exist under
    // the chosen topic so no filter combination comes back empty.
    $("#f-topic").addEventListener("change", function (e) {
      state.filters.topic = e.target.value;
      syncSubtopicSelect($("#f-topic"), $("#f-subtopic"), "All subtopics");
      state.filters.subtopic = $("#f-subtopic").value;
      renderRepo();
    });
    $("#clear-filters").addEventListener("click", clearFilters);
    $("#filters-toggle").addEventListener("click", function () {
      var bar = $("#filter-bar");
      var collapsed = bar.classList.toggle("is-collapsed");
      this.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

    // Students
    $("#student-select").addEventListener("change", function (e) { setActiveStudent(e.target.value); renderAll(); });
    $("#add-student-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("#new-student-name");
      if (SERVER) { openAddAthleteModal(input.value.trim()); input.value = ""; return; }
      var id = addStudent(input.value);
      if (id) { input.value = ""; renderAll(); toast("Student added"); }
    });
    $("#export-btn").addEventListener("click", exportTracking);
    var rosterBtn = $("#export-roster-btn");
    if (rosterBtn) rosterBtn.addEventListener("click", exportRosterCSV);
    var bulkBtn = $("#bulk-assign-btn");
    if (bulkBtn) bulkBtn.addEventListener("click", openBulkAssignModal);
    $("#import-merge-btn").addEventListener("click", function () { triggerImport("merge"); });
    $("#import-replace-btn").addEventListener("click", function () { triggerImport("replace"); });
    $("#import-file").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) {
        if (SERVER) handleServerImportFile(e.target.files[0]);
        else handleImportFile(e.target.files[0]);
      }
      e.target.value = "";
    });
    var serverImportBtn = $("#import-server-btn");
    if (serverImportBtn) serverImportBtn.addEventListener("click", function () { triggerImport("server"); });

    // Role controls (header + preview banner)
    var themeBtn = $("#theme-toggle");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    $("#admin-login-btn").addEventListener("click", openLoginModal);
    $("#student-view-btn").addEventListener("click", function () { goStudent(true); });
    $("#logout-btn").addEventListener("click", logout);
    $("#back-to-admin-btn").addEventListener("click", goAdmin);
    var acctLogout = $("#account-logout-btn");
    if (acctLogout) acctLogout.addEventListener("click", logout);
    var gotoPass = $("#goto-passcode-btn");
    if (gotoPass) gotoPass.addEventListener("click", function () { setTab("settings"); var np = $("#new-passcode"); if (np) np.focus(); });

    // Repository admin tools
    $("#add-activity-btn").addEventListener("click", function () { openActivityModal(null); });
    $("#show-hidden").addEventListener("change", function (e) { state.showHidden = e.target.checked; renderRepo(); });

    // Settings — change admin passcode
    $("#passcode-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var a = $("#new-passcode").value, b = $("#confirm-passcode").value;
      if (!a || a.length < 4) { toast("Use at least 4 characters"); return; }
      if (a !== b) { toast("Passcodes don’t match"); return; }
      setPasscode(a);
      $("#new-passcode").value = ""; $("#confirm-passcode").value = "";
      toast("Passcode updated");
    });

    // Settings — change password (server mode)
    var changePwdForm = $("#change-password-form");
    if (changePwdForm) {
      changePwdForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var current = $("#current-password").value;
        var newPwd = $("#new-password").value;
        var confirm = $("#confirm-password").value;
        var errBox = $("#change-password-error");
        errBox.hidden = true;
        
        if (!current || !newPwd || !confirm) {
          errBox.textContent = "All fields are required.";
          errBox.hidden = false;
          return;
        }
        if (newPwd.length < 8) {
          errBox.textContent = "New password must be at least 8 characters.";
          errBox.hidden = false;
          return;
        }
        if (newPwd !== confirm) {
          errBox.textContent = "New passwords don't match.";
          errBox.hidden = false;
          return;
        }
        
        api("/change-password", {
          method: "POST",
          body: { current_password: current, new_password: newPwd }
        }).then(function (res) {
          if (!res.ok) {
            errBox.textContent = apiError(res, "Couldn't update password.");
            errBox.hidden = false;
            return;
          }
          $("#current-password").value = "";
          $("#new-password").value = "";
          $("#confirm-password").value = "";
          toast("Password updated successfully");
        }).catch(function () {
          errBox.textContent = "Couldn't reach the server.";
          errBox.hidden = false;
        });
      });
    }

    // Help button replays the onboarding tour for the current role on demand (T2).
    var helpBtn = $("#help-btn");
    if (helpBtn) helpBtn.addEventListener("click", function () { startTour(isAdminView() ? TOUR_ADMIN : TOUR_STUDENT, true); });

    // Pick up an initial tab from the URL hash (validated against the role).
    var initial = (location.hash || "").replace("#", "");
    if (initial) state.tab = initial;

    boot();
  }

  // Decide LOCAL vs SERVER mode, then render. Probing GET /api/me tells us whether a
  // real PerformanceXtra backend is present. A plain static host (GitHub Pages, a bare
  // file://) has no /api, so it answers 404 or throws — both mean "run offline".
  function boot() {
    api("/me").then(function (res) {
      if (res.ok && res.data && res.data.id) {
        // Authenticated session — route by the server-trusted role.
        SERVER = true;
        return loadBaseActivities().then(loadServerSnapshot).then(loadAndApplySiteTheme).then(function () {
          // Coach, admin and super admin all use the tabbed app; the tab set grows with
          // rank. Only athletes get the student view.
          var staff = state.session.role !== "athlete";
          state.view = staff ? "admin" : "student";
          if (!location.hash) {
            state.tab = state.session.role === "superadmin" ? "appearance"
              : (state.session.role === "admin" ? "manage" : (staff ? "students" : "workouts"));
          }
          refreshSelects();
          applyRole();
          renderAll();
          maybeAutoTour();
        });
      }
      if (res.status === 401) {
        // The API is live but we're signed out → show the login / invite gate.
        SERVER = true;
        loadAndApplySiteTheme();
        showAuthGate();
        return;
      }
      // Some other status (e.g. 404 from static hosting) → no backend here.
      runLocalMode();
    }).catch(runLocalMode);   // network error → offline/static
  }
  function runLocalMode() {
    // No backend reachable. Rather than dropping into a confusing "everything visible,
    // fake-passcode" state, keep the experience login-first: show the sign-in gate with a
    // clear notice. A real deployment (Cloudflare Worker + D1) makes the backend reachable
    // and this path is never taken.
    SERVER = false;
    showAuthGate(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
