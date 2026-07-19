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
        // Restore the coach's pinned workspace athlete (persisted by setActiveStudent);
        // fall back to the first athlete only when nothing valid is pinned.
        var pinned = null;
        try { pinned = localStorage.getItem(activeStudentStorageKey()); } catch (e) {}
        state.tracking.activeStudentId = (pinned && state.tracking.students[pinned])
          ? pinned
          : (Object.keys(state.tracking.students)[0] || null);
      }
      rebuildData();
      return d;
    });
  }
  // Re-pull server state, then refresh dependent dropdowns. Callers re-render after.
  function refreshFromServer(quiet) {
    state.allStudents = null;   // roster may have changed; re-fetch the org directory on next view
    return loadServerSnapshot().then(function () { refreshSelects(); })
      .catch(function () { if (!quiet) toast("Couldn't refresh from the server"); });
  }

  // A stable, order-independent fingerprint of the content a coach sees: their merged
  // custom activities, per-activity overrides, hidden flags, and taxonomy. When a super
  // admin edits the SHARED library, those changes land in this coach's merged content on
  // the next bootstrap, so a change here means "the repository/content view is now stale."
  function contentSig() {
    var t = state.tracking || {};
    function keys(o) { return Object.keys(o || {}).sort(); }
    var ca = (t.customActivities || []).map(function (a) { return a && a.id; }).sort();
    var ov = t.overrides || {};
    var tax = t.taxonomy || {};
    return [
      "c:" + ca.join(","),
      "o:" + keys(ov).map(function (k) { try { return k + "=" + JSON.stringify(ov[k]); } catch (e) { return k; } }).join("|"),
      "h:" + keys(t.hidden).join(","),
      "t:" + ["topic", "subtopic", "type"].map(function (k) { return (tax[k] || []).join(","); }).join(";")
    ].join("§");
  }

  // Background sync for staff (coach/admin/super admin). The app has no live push, so a coach
  // who gets an athlete reassigned — or whose shared content library a super admin just edited —
  // would otherwise only see it after a manual reload. This quietly re-pulls bootstrap on tab
  // focus/visibility and on a slow interval, and re-renders when the roster membership OR the
  // merged content actually changed — so it never disrupts a coach mid-task (guarded against
  // open modals, focused inputs, and rapid repeats).
  var lastAutoRefresh = 0;
  function autoRefreshRoster() {
    if (!SERVER || !isAdminView()) return;
    if (document.visibilityState === "hidden") return;
    var mr = $("#modal-root"); if (mr && !mr.hidden) return;
    var ae = document.activeElement; if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    var t = Date.now(); if (t - lastAutoRefresh < 8000) return; lastAutoRefresh = t;
    var before = Object.keys(students()).sort().join(",");
    var beforeContent = contentSig();
    refreshFromServer(true).then(function () {
      if (Object.keys(students()).sort().join(",") !== before || contentSig() !== beforeContent) renderAll();
    });
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
      // The completed map is keyed "assignmentId::activityId" (like reflections; ''
      // assignment = no context). Migrate legacy activity-only keys forward so old
      // localStorage stores keep working.
      Object.keys(st.completed).forEach(function (k) {
        if (k.indexOf("::") === -1) {
          st.completed["::" + k] = st.completed[k];
          delete st.completed[k];
        }
      });
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
  function isWorkspaceOnlyStudent(s) { return !!(s && s._workspaceOnly); }
  function studentList() {
    return Object.keys(students()).map(function (id) { return students()[id]; })
      .filter(function (s) { return !isWorkspaceOnlyStudent(s); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function activeStudent() {
    var id = state.tracking.activeStudentId;
    return id && students()[id] ? students()[id] : null;
  }
  function canManageStudentWorkspace(s) {
    if (!s) return false;
    if (!SERVER) return true;
    if (isAtLeastAdmin()) return true;
    return !s._viewerOnly;
  }
  /* Completions are keyed "assignmentId::activityId" — the same shape as reflections
   * ('' assignment = completed with no assignment context) — so the SAME activity
   * re-assigned in a new set starts fresh instead of showing as already done. */
  function completionKey(assignmentId, activityId) {
    return String(assignmentId || "") + "::" + String(activityId || "");
  }
  // The completion timestamp for an activity WITHIN an assignment. A completion
  // recorded with no assignment context counts everywhere (legacy data, repo marks).
  function completionAt(student, assignmentId, activityId) {
    var m = (student && student.completed) || {};
    return m[completionKey(assignmentId, activityId)] || m[completionKey("", activityId)] || null;
  }
  // Any completion of this activity in any context (repository cards, topic rollups).
  function completionAny(student, activityId) {
    var m = (student && student.completed) || {};
    var bare = m[completionKey("", activityId)];
    if (bare) return bare;
    var suffix = "::" + activityId;
    var keys = Object.keys(m);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].length >= suffix.length && keys[i].slice(-suffix.length) === suffix) return m[keys[i]];
    }
    return null;
  }
  // Distinct activity ids the student has completed at least once (for rollups).
  function completedActivityIds(student) {
    var m = (student && student.completed) || {};
    var out = {};
    Object.keys(m).forEach(function (k) {
      var i = k.indexOf("::");
      var aid = i === -1 ? k : k.slice(i + 2);
      if (aid) out[aid] = true;
    });
    return Object.keys(out);
  }

  // Mark/unmark an activity done for a student. Optimistically updates the in-memory
  // map (so the UI flips instantly), then persists: to the server (athlete only) in
  // SERVER mode, or to localStorage in LOCAL mode.
  function setCompletion(student, activityId, done, assignmentId) {
    if (!student) return;
    var key = completionKey(assignmentId, activityId);
    var effectiveAsg = assignmentId || null;
    // Un-marking when the visible "done" actually comes from a no-context completion
    // (legacy/repo mark): clear THAT record instead, mirroring the server's delete.
    if (!done && !student.completed[key] && student.completed[completionKey("", activityId)]) {
      key = completionKey("", activityId);
      effectiveAsg = null;
    }
    if (done) student.completed[key] = new Date().toISOString();
    else delete student.completed[key];
    if (SERVER) {
      api("/completions", {
        method: "POST",
        body: {
          activity_id: activityId,
          assignment_id: effectiveAsg,
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
    asg.items.forEach(function (id) { if (completionAt(s, asg.id, id)) done++; });
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
      // Publishing mode composes with the CURRENT shared-library state (cmsHidden);
      // writing before the snapshot has loaded could clobber an existing shared edit.
      if (!globalSnapshotReady()) { toast("Still loading the shared library — try again in a moment"); return; }
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
      // in Global scope read the global override, not the merged/private one). Requires
      // the loaded snapshot — an empty in-flight/failed one would erase that payload.
      if (!globalSnapshotReady()) { toast("Still loading the shared library — try again in a moment"); return; }
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
    if (SERVER && !globalSnapshotReady()) { toast("Still loading the shared library — try again in a moment"); return; }
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
  // The chosen workspace athlete survives reloads: in SERVER mode the bootstrap doesn't
  // carry it (saveTracking is a no-op there), so it's pinned per-user in localStorage
  // and restored by loadServerSnapshot.
  function activeStudentStorageKey() { return "px.activeStudent." + ((state.session && state.session.id) || "local"); }
  function setActiveStudent(id) {
    state.tracking.activeStudentId = id || null;
    var s = id ? students()[id] : null;
    try { if (SERVER && id && !isWorkspaceOnlyStudent(s)) localStorage.setItem(activeStudentStorageKey(), id); } catch (e) {}
    saveTracking();
  }

  function computeProgress(student) {
    var ids = Object.keys(student.completed);
    var byTopic = {}, byWeek = {};
    ids.forEach(function (aid) {
      var a = BY_ID[aid];
      if (!a) return;
      if (a.topic) byTopic[a.topic] = (byTopic[a.topic] || 0) + 1;
      var wk = a.week ? "Week " + a.week : "Advanced";
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
    globalTracking: null,   // global-library-only snapshot, lazy-loaded for the super-admin Content "Global" scope
    studentTab: "mine",     // Students subtab: "mine" (own roster) | "all" (org-wide directory)
    allStudents: null,      // org-wide student directory, lazy-loaded for the "All students" subtab
    content: {},            // site-copy overrides from content_slots (key -> text); defaults live in CONTENT_DEFAULTS
    navPages: []            // published builder pages with a nav label: [{id,label,order}]
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
  // (/custom-activities, /overrides, /taxonomy); "global" -> the shared library a
  // super admin curates (/global/*). For a SUPER ADMIN the default is the SHARED library
  // — publishing is what a super admin almost always means (their early edits silently
  // landed in a private scope no coach could see; migration 0014 repaired that) — with
  // an explicit, persisted "Only me" opt-out. Coaches/admins always write private.
  // The choice applies on every tab (Repository edits included) and survives reloads.
  function cmsScopeStorageKey() { return "px.cmsScope." + ((state.session && state.session.id) || "anon"); }
  function cmsScope() {
    if (!isSuperadmin()) return "private";
    if (state.cmsScope !== "global" && state.cmsScope !== "private") {
      var saved = null;
      try { saved = localStorage.getItem(cmsScopeStorageKey()); } catch (e) {}
      state.cmsScope = (saved === "private") ? "private" : "global";   // default: publish
    }
    return state.cmsScope;
  }
  function setCmsScope(scope, quiet) {
    state.cmsScope = scope === "global" ? "global" : "private";
    try { localStorage.setItem(cmsScopeStorageKey(), state.cmsScope); } catch (e) {}
    if (state.cmsScope === "global" && state.globalTracking == null && SERVER) loadGlobalTracking();
    if (!quiet) {
      toast(state.cmsScope === "global"
        ? "Publishing — edits now go to the shared library every coach & athlete sees"
        : "Private — edits now stay in your own library only");
    }
  }
  function cmsGlobal() { return isSuperadmin() && cmsScope() === "global"; }
  function cmsRoute(p) { return cmsGlobal() ? ("/global" + p) : p; }

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
      // All three must have answered OK: a partial/failed snapshot must never
      // masquerade as "the shared library is empty" — a later edit/hide would then
      // POST a null/base payload and erase an existing shared-library edit.
      if (!(rs[0] && rs[0].ok && rs[1] && rs[1].ok && rs[2] && rs[2].ok)) throw new Error("global snapshot incomplete");
      var ca = (rs[0].data && rs[0].data.customActivities) || [];
      var ov = rs[1].data || {};
      var tx = (rs[2].data && rs[2].data.taxonomy) || {};
      state.globalTracking = {
        loaded: true,
        customActivities: ca,
        overrides: ov.overrides || {},
        hidden: ov.hidden || {},
        taxonomy: { topic: tx.topic || [], subtopic: tx.subtopic || [], type: tx.type || [] }
      };
    }).catch(function () {
      state.globalTracking = { failed: true, customActivities: [], overrides: {}, hidden: {}, taxonomy: { topic: [], subtopic: [], type: [] } };
    });
  }
  // Shared-library writes may only proceed once the global snapshot actually loaded —
  // never while it's still in flight, and never off the empty failure placeholder.
  function globalSnapshotReady() {
    return !cmsGlobal() || !!(state.globalTracking && state.globalTracking.loaded);
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
  // After a CMS write, refresh the merged catalog; in Global scope also re-pull the
  // global-only snapshot right away (Repository-tab flows read it too — e.g. setHidden
  // preserves the existing global edit payload — so it can't be left stale or null).
  function afterCmsWrite(cb) {
    return refreshFromServer().then(function () {
      if (cmsGlobal()) return loadGlobalTracking().then(function () { if (cb) cb(); });
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
    // Ownership chip: only a coach's OWN addition is called out ("Added by you").
    // Items published to the shared library (scope 'global') get no chip — to everyone
    // browsing, shared content IS library content, even though its id starts CUST-.
    if (isCustom(a.id) && a.scope !== "global" && isAdminView()) {
      chips.appendChild(el("span", { class: "tag-custom" }, "Added by you"));
    }
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
    if (a.link) {
      var foot = el("div", { class: "card-foot" });
      foot.appendChild(el("a", { class: "btn btn--sm btn--primary", href: a.link, target: "_blank", rel: "noopener" }, "Open resource ↗"));
      card.appendChild(foot);
    }

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
    var repoView = $("#view-repo");
    var oldRepoTip = $("#repo-global-tip");
    if (oldRepoTip && oldRepoTip.parentNode) oldRepoTip.parentNode.removeChild(oldRepoTip);
    if (repoView && isSuperadmin()) {
      // Live scope indicator: says exactly where an edit made on this tab will land,
      // with a one-click switch. (Replaces the old passive "tip" that still let super
      // admin edits strand in a private scope nobody else could see.)
      var isGlobalNow = cmsGlobal();
      var switchLink = el("a", { href: "#", onclick: function (e) {
        e.preventDefault();
        setCmsScope(isGlobalNow ? "private" : "global");
        renderRepo();
      } }, isGlobalNow ? "Switch to private editing" : "Switch to publishing");
      var repoTip = el("div", { class: "note-banner", id: "repo-global-tip" }, [
        el("strong", {}, isGlobalNow ? "Publishing: " : "Private edits: "),
        el("span", {}, isGlobalNow
          ? "edits you make here go to the shared library — every coach and athlete sees them. "
          : "edits you make here stay in your own library — coaches will NOT see them. "),
        switchLink
      ]);
      var filtersToggle = $("#filters-toggle");
      repoView.insertBefore(repoTip, filtersToggle || grid);
    }
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

  function repoAdvancedFilterKeys() {
    return ["subtopic", "progression", "frequency"];
  }

  function repoHasAdvancedFilters() {
    return repoAdvancedFilterKeys().some(function (key) { return !!(state.filters && state.filters[key]); });
  }

  function syncRepoFilterDensity() {
    var bar = $("#filter-bar");
    var toggle = $("#filters-toggle");
    if (!bar || !toggle) return;
    if (state.repoFiltersExpanded == null) state.repoFiltersExpanded = repoHasAdvancedFilters();
    bar.classList.toggle("is-condensed", !state.repoFiltersExpanded);
    toggle.textContent = state.repoFiltersExpanded ? "Fewer filters" : "More filters";
    toggle.setAttribute("aria-expanded", state.repoFiltersExpanded ? "true" : "false");
  }

  function configureRepoFilterDensity() {
    [["f-search", "primary"], ["f-topic", "primary"], ["f-type", "primary"], ["f-subtopic", "advanced"], ["f-progression", "advanced"], ["f-frequency", "advanced"]]
      .forEach(function (pair) {
        var input = $("#" + pair[0]);
        if (!input || !input.parentNode) return;
        input.parentNode.setAttribute("data-filter-tier", pair[1]);
      });
    syncRepoFilterDensity();
  }

  function clearFilters() {
    state.filters = { search: "", topic: "", subtopic: "", type: "", progression: "", frequency: "" };
    $("#f-search").value = "";
    ["topic", "subtopic", "type", "progression", "frequency"].forEach(function (k) { $("#f-" + k).value = ""; });
    // Topic is now empty, so restore the full subtopic list.
    syncSubtopicSelect($("#f-topic"), $("#f-subtopic"), "All subtopics");
    state.repoFiltersExpanded = false;
    syncRepoFilterDensity();
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
      var s = activeStudent();
      pool = pool.filter(function (a) { return !completionAny(s, a.id); });
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
      lines.push("   Status: " + (completionAt(student, asg.id, id) ? "Completed" : "Pending"));
      var txtLink = itemLink(asg, id);
      if (txtLink) lines.push("   Link: " + txtLink);
      if (a.instructions) lines.push("   Instructions: " + a.instructions.replace(/\n/g, "\n      "));
      if (a.reflection) lines.push("   Reflection prompt: " + a.reflection.replace(/\n/g, "\n      "));

      lines.push("");
    });
    var asgRefl = getReflectionEntry(student, asg.id, "__assignment__");
    if (asgRefl && asgRefl.text && asgRefl.text.trim()) {
      lines.push("ASSIGNMENT REFLECTION (from an earlier version):");
      lines.push(asgRefl.text.trim().replace(/\n/g, "\n   "));
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
      var doneAt = completionAt(student, asg.id, id);
      var done = !!doneAt;
      var doneText = done ? ("Completed on " + fmtDate(doneAt)) : "Not marked completed";
      var itemTitle = (idx + 1) + ". " + a.name;
      var meta = [
        a.type || "Activity",
        a.topic || null,
        (a.subtopics || []).length ? ("Subtopics: " + a.subtopics.join(", ")) : null,
        a.progression || null,
        a.frequency || null,
        a.time || null
      ].filter(Boolean).join("  |  ");
      var pdfLink = itemLink(asg, id);
      var instructionText = a.instructions || "No additional instructions provided.";
      var existing = getReflectionEntry(student, asg.id, id);
      var submittedLines = (existing && existing.text && existing.text.trim())
        ? doc.splitTextToSize("Existing reflection: " + existing.text.trim(), headerWidth - 42)
        : [];

      var itemTitleLines = doc.splitTextToSize(itemTitle, headerWidth - 42);
      var metaLines = doc.splitTextToSize(meta, headerWidth - 42);
      var statusLines = doc.splitTextToSize("Status: " + doneText, headerWidth - 42);
      var linkLines = pdfLink ? doc.splitTextToSize("Resource link: " + pdfLink, headerWidth - 42) : [];
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
      if (linkLines.length) ty = textBlock(linkLines, marginX + 12, ty, { font: "normal", size: 8.5, color: [37, 99, 235] });
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

    // Legacy whole-set reflection: athletes now answer per activity (each item above has
    // its own writing box), so this block only appears when old data exists — no more
    // permanently-empty "Assignment-level reflection" box on every export.
    var asgReflection = getReflectionEntry(student, asg.id, "__assignment__");
    var asgReflectionText = (asgReflection && asgReflection.text && asgReflection.text.trim())
      ? doc.splitTextToSize("From an earlier version: " + asgReflection.text.trim(), headerWidth - 24)
      : [];
    if (asgReflectionText.length) {
      var assignmentBoxH = 30 + asgReflectionText.length * lineH + 12;
      ensureSpace(assignmentBoxH + 10);
      var ay = yRef.value;
      doc.setDrawColor(251, 146, 60);
      doc.setFillColor(255, 247, 237);
      doc.roundedRect(marginX, ay, headerWidth, assignmentBoxH, 8, 8, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.8);
      doc.text("Assignment-level reflection", marginX + 12, ay + 16);
      textBlock(asgReflectionText, marginX + 12, ay + 30, { font: "normal", size: 8.5, color: [124, 45, 18] });
      yRef.value = ay + assignmentBoxH + 14;
    }

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
      li.appendChild(el("div", { class: "pa-name" }, a.name + (a.time ? " (" + a.time + ")" : "") + (completionAt(student, asg.id, id) ? "  ✓ done" : "")));
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

  /* ----------------------------- CSV import (activity library) -----------------------------
   * Bulk-add activities from a spreadsheet: parse the CSV here in the browser, preview
   * what will happen (valid / duplicate / broken rows), then POST the rows as JSON to
   * /custom-activities/bulk (or the /global variant via cmsRoute, so the Shared/Private
   * switch decides who sees them). No upload handling, no dependencies. */

  // Minimal spec-correct CSV parser: quoted cells, "" escapes, embedded commas and
  // newlines, CRLF/CR/LF endings, leading BOM. Returns rows of cells; fully empty
  // rows (trailing newlines, spacer lines) are dropped.
  function parseCSV(text) {
    var rows = [], row = [], cell = "", inQuotes = false;
    var s = String(text || "");
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell); cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        rows.push(row); row = [];
      } else {
        cell += ch;
      }
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  }

  // Recognized CSV headers (case-insensitive) → activity fields. Friendly aliases match
  // how the columns are usually labelled in a spreadsheet.
  var CSV_HEADER_MAP = {
    "name": "name", "activity": "name", "activity name": "name", "title": "name",
    "topic": "topic",
    "subtopic": "subtopics", "subtopics": "subtopics", "sub-topic": "subtopics", "sub-topics": "subtopics", "sub topics": "subtopics",
    "type": "type", "content type": "type",
    "progression": "progression",
    "week": "week",
    "month": "month",
    "frequency": "frequency",
    "time": "time",
    "timeminutes": "timeMinutes", "time in minutes": "timeMinutes", "minutes": "timeMinutes",
    "link": "link", "url": "link",
    "instructions": "instructions",
    "reflection": "reflection", "reflection prompt": "reflection"
  };

  function downloadActivityCsvTemplate() {
    var headers = ["name", "topic", "subtopics", "type", "progression", "week", "frequency", "time", "timeMinutes", "link", "instructions", "reflection"];
    var examples = [
      ["Wheel of Excellence — Commitment", "Mental Toughness", "Commitment, Focus", "Reading", "Week 1", "1", "Once", "10 min", "10", "https://example.com/reading", "Read the chapter, then note the two ideas that apply to your sport.", "Which commitment habit will you practice this week?"],
      ["Journal: Best Performance", "Self-Awareness", "Reflection", "Journal Prompt", "Advanced", "", "Weekly", "5 min", "5", "", "Think back to your best performance this season.", "What did you do before and during it that you can repeat?"]
    ];
    var csv = [headers].concat(examples).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    downloadFile("performancextra-activities-template.csv", csv, "text/csv");
    toast("Template downloaded — fill it in, then use Import CSV");
  }

  // Parse a picked CSV file into { activities, errors, unknownHeaders } using the header
  // map + normalizeActivity (the same coercion the one-at-a-time form uses).
  function csvToActivities(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) return { error: rows.length ? "The file only has a header row — add at least one activity row." : "The file is empty." };
    var headers = rows[0].map(function (h) { return CSV_HEADER_MAP[String(h || "").trim().toLowerCase()] || null; });
    if (headers.indexOf("name") === -1) return { error: "No “name” column found. Download the CSV template to see the expected headings." };
    var unknown = rows[0].filter(function (h, i) { return String(h).trim() && !headers[i]; });
    var activities = [], errors = [];
    rows.slice(1).forEach(function (r, idx) {
      var obj = {};
      headers.forEach(function (field, i) { if (field && r[i] != null) obj[field] = String(r[i]); });
      var a = normalizeActivity(obj, null);
      delete a.id;
      if (!a.name) { errors.push({ row: idx + 2, error: "Missing name" }); return; }   // +2: 1-based + header row
      activities.push(a);
    });
    return { activities: activities, errors: errors, unknownHeaders: unknown };
  }

  // The import dialog: pick a file → see what will happen → import. Duplicates (same
  // name as an existing activity, or repeated within the file) are skipped unless the
  // user opts in.
  function openCsvImportModal() {
    if (cmsGlobal() && !globalSnapshotReady()) { toast("Still loading the shared library — try again in a moment"); return; }
    var fileI = el("input", { type: "file", accept: ".csv,text/csv" });
    var preview = el("div", { class: "form-stack" });
    var dupCheck = el("input", { type: "checkbox" });
    var dupLabel = el("label", { class: "check" }, [dupCheck, " Also import duplicates as copies"]); dupLabel.hidden = true;
    var parsed = null;   // { activities, errors, dupes }

    var existingNames = {};
    cmsActivityRows(true).forEach(function (a) { if (a.name) existingNames[String(a.name).trim().toLowerCase()] = true; });

    function refreshPreview() {
      preview.textContent = "";
      dupLabel.hidden = true;
      if (!parsed) return;
      if (parsed.error) { preview.appendChild(el("div", { class: "warn" }, parsed.error)); return; }
      var seen = {};
      var fresh = [], dupes = [];
      parsed.activities.forEach(function (a) {
        var key = a.name.toLowerCase();
        if (existingNames[key] || seen[key]) dupes.push(a); else fresh.push(a);
        seen[key] = true;
      });
      parsed.fresh = fresh; parsed.dupes = dupes;
      var bits = [fresh.length + " new activit" + (fresh.length === 1 ? "y" : "ies") + " ready to import"];
      if (dupes.length) bits.push(dupes.length + " duplicate name" + (dupes.length === 1 ? "" : "s") + " (skipped unless you tick the box)");
      if (parsed.errors.length) bits.push(parsed.errors.length + " row" + (parsed.errors.length === 1 ? "" : "s") + " with problems");
      preview.appendChild(el("p", {}, bits.join(" · ") + "."));
      if (dupes.length) {
        var dl = el("details", { class: "detail" }, el("summary", {}, "Duplicate names"));
        dupes.slice(0, 30).forEach(function (a) { dl.appendChild(el("div", { class: "field-hint" }, a.name)); });
        if (dupes.length > 30) dl.appendChild(el("div", { class: "field-hint" }, "…and " + (dupes.length - 30) + " more"));
        preview.appendChild(dl);
        dupLabel.hidden = false;
      }
      if (parsed.errors.length) {
        var elx = el("details", { class: "detail", open: true }, el("summary", {}, "Rows with problems (won't import)"));
        parsed.errors.slice(0, 30).forEach(function (e2) { elx.appendChild(el("div", { class: "field-hint" }, "Row " + e2.row + ": " + e2.error)); });
        preview.appendChild(elx);
      }
      if (parsed.unknownHeaders && parsed.unknownHeaders.length) {
        preview.appendChild(el("p", { class: "field-hint" }, "Ignored column" + (parsed.unknownHeaders.length === 1 ? "" : "s") + ": " + parsed.unknownHeaders.join(", ")));
      }
      if (fresh.length || dupes.length) {
        var sample = el("details", { class: "detail" }, el("summary", {}, "Preview first rows"));
        (fresh.concat(dupes)).slice(0, 5).forEach(function (a) {
          sample.appendChild(el("div", { class: "field-hint" }, a.name + " — " + [a.topic, a.type, a.progression].filter(Boolean).join(" · ")));
        });
        preview.appendChild(sample);
      }
    }

    fileI.addEventListener("change", function () {
      var f = fileI.files && fileI.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { parsed = csvToActivities(String(reader.result || "")); refreshPreview(); };
      reader.onerror = function () { parsed = { error: "Couldn't read that file." }; refreshPreview(); };
      reader.readAsText(f);
    });

    var scopeNote = cmsGlobal()
      ? "Importing into the Shared library — every coach and athlete will see these."
      : "Importing into My library — private to you. Use the scope switch above the activity list to publish for everyone instead.";
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, scopeNote + " Need the column headings? "),
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: downloadActivityCsvTemplate }, "⬇ Download CSV template"),
      el("div", { class: "field" }, [el("label", {}, "CSV file"), fileI]),
      preview,
      dupLabel
    ]);

    function submit() {
      if (!parsed || parsed.error) { toast("Pick a CSV file first"); return; }
      var send = dupCheck.checked ? parsed.fresh.concat(parsed.dupes) : parsed.fresh;
      if (!send.length) { toast("Nothing to import" + (parsed.dupes.length ? " — every row already exists" : "")); return; }
      if (send.length > 500) { toast("Max 500 rows per import — split the file and import in parts"); return; }
      api(cmsRoute("/custom-activities/bulk"), { method: "POST", body: { activities: send, skipDuplicates: !dupCheck.checked } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't import")); return; }
        closeModal();
        var d = res.data || {};
        var msg = "Imported " + (d.created || 0) + " activit" + (d.created === 1 ? "y" : "ies");
        if (d.skipped) msg += " · " + d.skipped + " duplicate" + (d.skipped === 1 ? "" : "s") + " skipped";
        if (d.errors && d.errors.length) msg += " · " + d.errors.length + " failed";
        afterCmsWrite(function () { renderAll(); toast(msg); });
      }).catch(function () { toast("Couldn't reach the server"); });
    }

    openModal("Import activities from CSV", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Import", accent: true, onClick: submit }
    ]);
  }

  /* ----------------------------- Students ----------------------------- */
  function renderStudents() {
    // Subtab: "My students" (this coach's roster) vs "All students" (org-wide directory,
    // SERVER only). The toggle just swaps which pane is shown; the org list is lazy-loaded.
    renderStudentsSubnav();
    var showAll = SERVER && state.studentTab === "all";
    var myLayout = $("#my-students-layout"); if (myLayout) myLayout.hidden = showAll;
    var allPane = $("#all-students-pane"); if (allPane) allPane.hidden = !showAll;
    var na = $("#needs-attention"); if (na) na.hidden = showAll;
    if (showAll) { renderAllStudents(); return; }

    renderStudentsGuide();

    var list = $("#student-list");
    list.textContent = "";
    var all = studentList();
    // Manual refresh: the background sync deliberately skips while an input is focused
    // or a modal is open, so give staff an explicit way to pull the latest roster and
    // shared-library changes on demand.
    if (SERVER) {
      var refreshBtn = el("button", { class: "btn btn--sm btn--ghost roster-refresh", title: "Pull the latest students, assignments and library changes from the server", onclick: function () {
        refreshBtn.disabled = true; refreshBtn.textContent = "Refreshing…";
        refreshFromServer().then(function () { renderAll(); toast("Up to date"); })
          .catch(function () {})
          .then(function () { refreshBtn.disabled = false; refreshBtn.textContent = "↻ Refresh"; });
      } }, "↻ Refresh");
      list.appendChild(el("div", { class: "roster-refresh-row" }, refreshBtn));
    }
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
      (s.assignments || []).forEach(function (a) { (a.items || []).forEach(function (id) { totalI++; if (completionAt(s, a.id, id)) doneI++; }); });
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
        class: "btn btn--sm btn--ghost",
        title: active ? "This athlete's workspace is open (it stays selected next time you sign in)" : "Open this athlete's workspace — assignments, progress and messages all point at them",
        "aria-pressed": active ? "true" : "false",
        onclick: function () { setActiveStudent(s.id); renderAll(); }
      }, active ? "Working here" : "Open workspace"));
      if (SERVER) {
        rowActions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new sign-in code to share with this athlete", "aria-label": "Reset sign-in code for " + s.name, onclick: function () { resetPasscode(s); } }, "↻ Reset sign-in code"));
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

  function renderStudentsGuide() {
    var host = $("#students-guide");
    if (!host) return;
    host.textContent = "";
    var panel = buildStudentsGuidePanel(studentList(), activeStudent());
    if (panel) host.appendChild(panel);
  }

  function buildStudentsGuidePanel(all, active) {
    all = all || [];
    var title = "";
    var copy = "";
    var steps = [];
    var actions = [];

    if (!all.length) {
      title = "Start your athlete roster";
      copy = "Add the first athlete here, send their sign-in details, then come back to assign their first focused set of work.";
      steps = [
        "Add one athlete with name and email.",
        "Send them the sign-in code PerformanceXtra generates.",
        "Create their first assignment once they appear in this list."
      ];
      actions.push(el("button", { class: "btn btn--accent", type: "button", onclick: function () {
        if (SERVER) openAddAthleteModal("");
        else {
          var input = $("#new-student-name");
          if (input) input.focus();
        }
      } }, SERVER ? "Add first athlete" : "Add first student"));
      actions.push(el("button", { class: "btn btn--ghost", type: "button", onclick: function () { setTab("repo"); } }, "Preview the library"));
    } else if (!active) {
      title = "Pick one athlete to work on next";
      copy = "Your roster is ready. Choose one athlete as the current workspace so assignments, progress, and messages all point to the same person.";
      steps = [
        "Pick an athlete from the list on the left.",
        "Use their detail pane to create or review assignments.",
        "Switch the current athlete any time from this view or the header picker."
      ];
      actions.push(el("button", { class: "btn btn--primary", type: "button", onclick: function () {
        setActiveStudent(all[0].id);
        renderAll();
      } }, "Open first athlete"));
    } else if (!studentAssignments(active).length) {
      title = "Give " + active.name + " a first assignment";
      copy = "The roster is in place. The next useful step is to turn the library into one clear assignment for this athlete so progress and reflections can start.";
      steps = [
        "Create one short assignment from the library or a template.",
        "Keep the title specific so the athlete knows what this set is for.",
        "Return here to review progress, reflections, and coach communication in one place."
      ];
      actions.push(el("button", { class: "btn btn--accent", type: "button", onclick: function () { openAssignBuilderModal(active.id); } }, "Create first assignment"));
      actions.push(el("button", { class: "btn btn--ghost", type: "button", onclick: function () { setTab("repo"); } }, "Browse activities first"));
    } else {
      return null;
    }

    return el("div", { class: "panel students-guide-panel" }, [
      el("div", { class: "students-guide-kicker" }, "First-run path"),
      el("div", { class: "students-guide-head" }, [
        el("h3", {}, title),
        el("p", {}, copy)
      ]),
      el("ol", { class: "students-guide-list" }, steps.map(function (step) {
        return el("li", { class: "students-guide-step" }, step);
      })),
      el("div", { class: "students-guide-actions" }, actions)
    ]);
  }

  // Segmented "My students / All students" control. SERVER-only (the org directory needs the
  // backend); hidden in LOCAL mode so the offline app is unchanged.
  function renderStudentsSubnav() {
    var nav = $("#students-subnav");
    if (!nav) return;
    if (!SERVER) { nav.hidden = true; state.studentTab = "mine"; return; }
    if (state.studentTab !== "all") state.studentTab = "mine";
    nav.hidden = false;
    nav.textContent = "";
    [["mine", "My students"], ["all", "All students"]].forEach(function (pair) {
      var input = el("input", { type: "radio", name: "students-sub", value: pair[0] });
      if (state.studentTab === pair[0]) input.checked = true;
      input.addEventListener("change", function () {
        if (!input.checked) return;
        state.studentTab = input.value || pair[0];
        renderStudents();
      });
      nav.appendChild(el("label", {}, [input, el("span", {}, pair[1])]));
    });
  }

  // Org-wide student directory (GET /all-athletes), lazy-loaded into state.allStudents and
  // filtered client-side by the search box. All staff can open a student's workspace; admin+
  // additionally get assign/reassign/delete controls.
  function renderAllStudents() {
    var listBox = $("#all-students-list");
    if (!listBox) return;
    if (state.allStudents == null) {
      listBox.textContent = "";
      listBox.appendChild(el("p", { class: "no-link" }, "Loading…"));
      api("/all-athletes").then(function (res) {
        state.allStudents = (res.ok && res.data && res.data.athletes) || [];
        if (state.tab === "students" && state.studentTab === "all") renderAllStudents();
      }).catch(function () {
        listBox.textContent = ""; listBox.appendChild(el("p", { class: "no-link" }, "Couldn't load students."));
      });
      return;
    }
    var countEl = $("#all-students-count");
    var searchEl = $("#all-students-search");
    var q = norm(searchEl ? searchEl.value : "").trim();
    var rows = state.allStudents.slice();
    if (q) rows = rows.filter(function (s) {
      return norm(s.name).indexOf(q) >= 0 || norm(s.email).indexOf(q) >= 0 || norm(s.coachName || "").indexOf(q) >= 0;
    });
    if (countEl) countEl.textContent = state.allStudents.length ? (rows.length + " of " + state.allStudents.length + " student" + (state.allStudents.length === 1 ? "" : "s")) : "";
    listBox.textContent = "";
    if (!rows.length) { listBox.appendChild(el("p", { class: "no-link" }, state.allStudents.length ? "No students match." : "No students yet.")); return; }
    rows.forEach(function (s) {
      var nameKids = [el("span", { class: "name" }, s.name)];
      if (s.email) nameKids.push(el("span", { class: "student-email", title: "Signs in with this email" }, s.email));
      if (s.coachName) nameKids.push(el("span", { class: "dupe-coach" }, "Coach: " + s.coachName));
      var stat = s.completedCount + " completed · " + s.assignmentCount + " assignment" + (s.assignmentCount === 1 ? "" : "s");
      nameKids.push(el("span", { class: "student-stat" }, stat));
      var row = el("div", { class: "student-row" }, [el("span", { class: "name-wrap" }, nameKids)]);
      var actions = [
        el("button", { class: "btn btn--sm btn--ghost", title: "Preview this student's workspace", "aria-label": "Preview workspace for " + s.name, onclick: function () { openStudentWorkspaceFromDirectory(s); } }, "Open workspace")
      ];
      if (isAtLeastAdmin()) {
        actions.push(el("button", { class: "btn btn--sm btn--ghost", title: "Assign work to this athlete", "aria-label": "Assign work to " + s.name, onclick: function () { openAssignForAnyStudent(s); } }, "Assign…"));
        actions.push(el("button", { class: "btn btn--sm btn--ghost", title: "Move this athlete to a different coach, or unassign them", "aria-label": "Move " + s.name, onclick: function () { openReassignStudent(s); } }, "Move…"));
        actions.push(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this athlete and all their data", "aria-label": "Delete " + s.name, onclick: function () { deleteAllStudent(s); } }, "✕ Delete"));
      }
      row.appendChild(el("div", { class: "student-row-actions" }, actions));
      listBox.appendChild(row);
    });
  }

  function openStudentWorkspaceFromDirectory(s, opts) {
    opts = opts || {};
    api("/athletes/" + encodeURIComponent(s.id) + "/detail").then(function (res) {
      if (!res.ok || !res.data || !res.data.athlete) { toast(apiError(res, "Couldn't load this student")); return; }
      var a = res.data.athlete;
      if (!a.completed || typeof a.completed !== "object") a.completed = {};
      if (!Array.isArray(a.assignments)) a.assignments = [];
      if (!a.reflections || typeof a.reflections !== "object") a.reflections = {};
      if (!Array.isArray(a.checkins)) a.checkins = [];
      if (!Array.isArray(a.journal)) a.journal = [];
      if (!Array.isArray(a.messages)) a.messages = [];
      if (typeof a.coachNote !== "string") a.coachNote = "";
      var canManage = !!(SERVER && res.data && res.data.canManage);

      // Assign flow (admin/super admin action) still opens the builder, but never flips
      // the current workspace tab or active-student selection.
      if (opts.assign) {
        if (!canManage) { toast("This student can only be viewed here"); return; }
        a._viewerOnly = false;
        a._workspaceOnly = true;
        state.tracking.students[s.id] = a;
        openAssignBuilderModal(s.id);
        return;
      }

      // Preview modal: read-only, dismissible, and side-effect free.
      var body = el("div", { class: "form-stack" }, [
        el("p", { class: "field-hint" }, (s.coachName ? ("Coach: " + s.coachName + " · ") : "") + "Read-only preview. Closing this window does not change your active workspace."),
        el("h3", { style: "margin:4px 0 8px" }, a.name + " — Assignments")
      ]);
      appendAssignmentList(body, a, { admin: false, review: true });
      body.appendChild(el("h3", { style: "margin:18px 0 10px" }, "Progress"));
      appendProgress(body, a);
      appendWellbeing(body, a);
      openModal("Student workspace preview", body, [
        { label: "Close", primary: true, onClick: closeModal }
      ]);
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  // Assign work to a student who isn't on your own roster (admin+). Coaches assign from their
  // own panel; admins/super admins can assign to ANY athlete. Loads the athlete's detail on
  // demand (GET /athletes/:id/detail — server allows admin+ to fetch any athlete), injects it
  // into the local store so the shared assign builder can use it, then opens that builder.
  // Modal-scoped, so the background roster sync stays paused while the dialog is open.
  function openAssignForAnyStudent(s) {
    openStudentWorkspaceFromDirectory(s, { assign: true });
  }

  // Move an athlete to a different coach from the All-students directory (admin+). This
  // is also how an athlete who somehow lost their coach (legacy data) gets re-homed.
  // A target coach is required — the server rejects unassigning.
  function openReassignStudent(s) {
    var sel = coachSelectNode(s.coachId || "", null);
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "Move " + s.name + " to a different coach. Every student needs a coach so they always show up in a roster."),
      el("div", { class: "field" }, [el("label", {}, "Coach"), sel])
    ]);
    function submit() {
      if (!sel.value) { toast("Pick a coach first"); return; }
      api("/athletes/" + encodeURIComponent(s.id) + "/reassign", { method: "POST", body: { coachId: sel.value } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't move")); return; }
        closeModal();
        toast("Moved " + s.name);
        state.allStudents = null;
        refreshFromServer().then(function () { renderAll(); });
        refreshStaff();
      }).catch(function () { toast("Couldn't reach the server"); });
    }
    openModal("Move " + s.name, body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Move", primary: true, onClick: submit }
    ]);
  }

  // Delete an athlete from the All-students directory (admin+). Invalidates the cache and
  // re-syncs the coach's own roster so both views stay accurate.
  function deleteAllStudent(s) {
    if (!confirm("Permanently delete " + s.name + (s.coachName ? " (coach " + s.coachName + ")" : "") + " and ALL their data? This can't be undone.")) return;
    api("/athletes/" + encodeURIComponent(s.id), { method: "DELETE" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
      toast("Deleted " + s.name);
      state.allStudents = null;
      refreshFromServer().then(function () { renderAll(); });
    }).catch(function () { toast("Couldn't reach the server"); });
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
      // Config-aware concern flags: a normal dimension near its floor, or an inverted one
      // (higher = worse) near its ceiling.
      if (latest) checkinDims().forEach(function (d) {
        var v = checkinScore(latest, d.key);
        if (v == null) return;
        if (d.invert) { if (v >= d.max - 1) reasons.push("high " + d.label.toLowerCase()); }
        else if (v <= d.min + 1) reasons.push("low " + d.label.toLowerCase());
      });
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
    // athlete views alike. Completion keys are "assignmentId::activityId"; collapse
    // them to distinct assigned activities (latest timestamp wins) for the rollups.
    var doneByActivity = {};
    Object.keys(s.completed || {}).forEach(function (k) {
      var sep = k.indexOf("::");
      var aid = sep === -1 ? k : k.slice(sep + 2);
      if (!aid || !assignedMap[aid]) return;
      var ts = s.completed[k];
      if (!doneByActivity[aid] || String(ts || "") > String(doneByActivity[aid] || "")) doneByActivity[aid] = ts;
    });
    var p = computeProgress({ completed: doneByActivity });

    var denom = assigned.length;
    if (!denom) {
      container.appendChild(el("p", { class: "no-link" }, "No activities assigned yet. Progress will appear here once this athlete has a workout."));
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
        Object.keys(doneByActivity)
          .sort(function (a, b) { return String(doneByActivity[b] || "").localeCompare(String(doneByActivity[a] || "")); })
          .forEach(function (aid) {
            var a = BY_ID[aid];
            if (!a) return;
            // Undo here only for a no-context completion; assignment-scoped ones are
            // undone from the workout itself (so the right assignment is cleared).
            var undoable = canUndo && !!s.completed[completionKey("", aid)];
            cl.appendChild(el("div", { class: "completed-row" }, [
              el("span", { class: "badge", "data-type": a.type || "" }, a.type || "—"),
              el("span", { class: "c-name" }, a.name),
              undoable ? el("button", { class: "btn btn--sm btn--ghost", title: "Un-complete", onclick: function () {
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

  // Render a student's assignments for the COACH view (opts.admin adds the delete /
  // template / link / mark-done controls and read-only reflection views). The athlete's
  // own actionable view is the workout spine (appendWorkoutSpine), not this list.
  function appendAssignmentList(container, s, opts) {
    opts = opts || {};
    var canManage = !!opts.admin;
    var canReview = !!opts.review || canManage;
    var list = studentAssignments(s);
    if (!list.length) {
      var emptyMsg = canManage
        ? "No assignments yet. Create one to give this student a focused set of activities."
        : (canReview
          ? "No assignments yet for this student."
          : "No workouts assigned yet. Ask your coach for your next set.");
      container.appendChild(el("p", { class: "no-link" }, emptyMsg));
      return;
    }
    function buildAssignmentCard(asg) {
      var prog = assignmentProgress(s, asg);
      var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
      var complete = prog.total > 0 && prog.done === prog.total;
      var card = el("div", { class: "assignment" });

      var actions = el("div", { class: "assignment-actions" });
      if (canManage) {
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
        var times = asg.items.map(function (id) { return completionAt(s, asg.id, id); }).filter(Boolean).sort();
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
        var done = !!completionAt(s, asg.id, id);
        var item = el("div", { class: "assign-item" + (done ? " is-done" : "") });
        item.appendChild(el("span", { class: "ai-name" }, [
          el("strong", {}, a.name), a.time ? (" · " + a.time) : "", a.type ? (" · " + a.type) : ""
        ]));
        var link = itemLink(asg, id);
        if (link) item.appendChild(el("a", { class: "btn btn--sm" + (itemHasCustomLink(asg, id) ? " has-custom-link" : ""), href: link, target: "_blank", rel: "noopener", title: itemHasCustomLink(asg, id) ? "Custom link for this student" : "" }, "Open ↗"));
        if (canManage) {
          var hasCustom = itemHasCustomLink(asg, id);
          item.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: hasCustom ? "Edit this student's custom link" : "Set a custom link for this student", onclick: function () {
            openItemLinkModal(s.id, asg, id);
          } }, hasCustom ? "🔗 Edit link" : "🔗 Custom link"));
        }
        if (canManage) {
          var btn = el("button", { class: "btn btn--sm done-btn", "aria-pressed": done ? "true" : "false", onclick: function () {
            setCompletion(s, id, !completionAt(s, asg.id, id), asg.id);
            renderAll();
          } }, done ? "✓ Done" : "Mark done");
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
        // Coach read-only view of the athlete's per-activity reflection / observation.
        if (canReview) {
          var itemRefl = getReflectionEntry(s, asg.id, id);
          if (itemRefl && itemRefl.text && itemRefl.text.trim()) {
            item.appendChild(el("div", { class: "reflection-read", style: "width:100%; margin-top:6px;" }, [
              el("div", { class: "detail-label" }, "Student reflection"),
              el("div", { class: "detail-text" }, itemRefl.text),
              itemRefl.updatedAt ? el("div", { class: "assignment-meta", style: "margin-top:4px" }, "Updated " + fmtDateTime(itemRefl.updatedAt)) : null
            ]));
          }
        }

        card.appendChild(item);
      });

      // Legacy assignment-level reflection (the old end-of-set textbox, replaced by the
      // per-activity fields above). Shown read-only to the coach ONLY when an athlete
      // actually wrote one back then \u2014 no empty "not submitted" noise on new work \u2014
      // and only when the text isn't already covered by a per-activity answer above
      // (athletes sometimes re-typed the old note into the new boxes).
      var ASSIGN_REFL_KEY = "__assignment__";
      if (canReview) {
        var asgReflAdmin = getReflectionEntry(s, asg.id, ASSIGN_REFL_KEY);
        var legacyText = asgReflAdmin && asgReflAdmin.text ? asgReflAdmin.text.trim() : "";
        var duplicated = legacyText && asg.items.some(function (id) {
          var r = getReflectionEntry(s, asg.id, id);
          return r && r.text && r.text.trim() === legacyText;
        });
        if (legacyText && !duplicated) {
          card.appendChild(el("div", { class: "reflection-read assignment-reflection" }, [
            el("div", { class: "detail-label" }, "Student reflection (from an earlier version)"),
            el("div", { class: "detail-text" }, legacyText),
            asgReflAdmin.updatedAt ? el("div", { class: "assignment-meta", style: "margin-top:6px" }, "Updated " + fmtDateTime(asgReflAdmin.updatedAt)) : null
          ]));
        }
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
    if (canReview) {
      var activeAsgs = list.filter(function (asg) { return !isAssignmentComplete(asg); });
      var doneAsgs = list.filter(isAssignmentComplete);
      if (!activeAsgs.length) {
        container.appendChild(el("p", { class: "no-link" }, "No assignments in progress \u2014 everything assigned is complete."));
      }
      activeAsgs.forEach(function (asg) { container.appendChild(buildAssignmentCard(asg)); });
      if (doneAsgs.length) {
        var doneTimes = [];
        doneAsgs.forEach(function (asg) {
          (asg.items || []).forEach(function (id) { var t = completionAt(s, asg.id, id); if (t) doneTimes.push(t); });
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

  /* ----------------------------- Athlete "Today" — tempo-spine workout home -----------------------------
     A focus-first redesign of the athlete My Workouts surface: today's work as a calm
     descent. The next undone item is the hero ("now", ember); finished work goes quiet
     (lime, checked); the rest waits ahead. The spine encodes sequence + time + progress.
     Uses the app's own two-signal palette (lime = done, ember = live) so it stays on-theme.
     Coach view keeps appendAssignmentList; this path is athlete-only. */
  function appendWorkoutSpine(panel, s) {
    var all = studentAssignments(s);
    if (!all.length) {
      panel.appendChild(el("div", { class: "wk-empty" }, [
        el("div", { class: "wk-flag", "aria-hidden": "true" }),
        el("div", {}, [
          el("h3", {}, "Nothing assigned right now"),
          el("p", {}, "When your coach sends your next set, it shows up here — one focused thing at a time.")
        ])
      ]));
      return;
    }
    function isComplete(asg) { var p = assignmentProgress(s, asg); return p.total > 0 && p.done === p.total; }
    var active = all.filter(function (a) { return !isComplete(a); });
    var finished = all.filter(isComplete);

    // status across active sets: how much is done, roughly how much work is left
    var totItems = 0, totDone = 0, minsLeft = 0, haveMins = false;
    active.forEach(function (asg) {
      asg.items.forEach(function (id) {
        if (!BY_ID[id]) return;
        totItems++;
        if (completionAt(s, asg.id, id)) { totDone++; return; }
        var m = BY_ID[id].timeMinutes;
        if (m != null && m !== "" && !isNaN(+m)) { minsLeft += +m; haveMins = true; }
      });
    });
    var statusParts;
    if (active.length) {
      statusParts = [el("span", {}, [el("b", {}, String(totDone)), " of ", el("b", {}, String(totItems)), " done"])];
      if (haveMins && minsLeft > 0) {
        statusParts.push(el("span", { class: "wk-sep", "aria-hidden": "true" }, "/"));
        statusParts.push(el("span", {}, ["about ", el("b", {}, String(minsLeft)), " min of work left"]));
      }
    } else {
      statusParts = [el("span", {}, "You're all caught up — nice work. Your finished sets are below.")];
    }
    panel.appendChild(el("p", { class: "wk-status" }, statusParts));

    function metaRow(a) {
      var parts = [];
      if (a.time) parts.push(el("span", {}, a.time));
      if (a.type) {
        if (parts.length) parts.push(el("span", { "aria-hidden": "true" }, "·"));
        parts.push(el("span", { class: "wk-type" }, a.type));
      }
      return el("div", { class: "wk-time" }, parts.length ? parts : el("span", {}, "Activity"));
    }

    function buildRep(asg, id, a, stateName) {
      var rep = el("div", { class: "wk-rep wk-" + stateName });
      rep.appendChild(el("div", { class: "wk-node", "aria-hidden": "true" }));
      var body = el("div", { class: "wk-body" });
      var link = itemLink(asg, id);
      var openBtn = link ? el("a", { class: "btn btn--sm wk-open", href: link, target: "_blank", rel: "noopener" }, "Open ↗") : null;

      function markBtn(primary) {
        return el("button", { class: "btn btn--sm wk-mark" + (primary ? " btn--accent" : ""), onclick: function () {
          setCompletion(s, id, !completionAt(s, asg.id, id), asg.id); renderAll();
        } }, "Mark done");
      }
      function instrDetail() {
        if (!a.reflection && !a.instructions) return null;
        var det = el("details", { class: "detail wk-detail" }, el("summary", {}, a.reflection ? "Instructions & reflection prompt" : "Instructions"));
        if (a.instructions) det.appendChild(detailBlock("How to do it", a.instructions));
        if (a.reflection) det.appendChild(detailBlock("Reflection prompt", a.reflection));
        return det;
      }
      // Per-activity reflection / observation field. The coach's prompt (if any) shows above
      // it; the athlete's answer autosaves keyed to (assignment, activity) and the coach reads
      // it back.
      function reflectBox() {
        var entry = getReflectionEntry(s, asg.id, id);
        var ta = el("textarea", {
          class: "wk-reflect-input wk-reflect-input--item",
          placeholder: a.reflection ? "Answer the prompt, or jot an observation…" : "Notes or observations (optional)…",
          "aria-label": "Your reflection for " + a.name
        });
        ta.value = entry && entry.text ? entry.text : "";
        var status = el("div", { class: "wk-reflect-status" }, entry && entry.updatedAt
          ? ("Saved " + fmtDateTime(entry.updatedAt))
          : "Saves to your coach · only the two of you can see it");
        ta.addEventListener("input", function () {
          var k = [s.id, asg.id, id].join("::");
          clearTimeout(state.reflectionTimers[k]);
          status.textContent = "Saving…";
          state.reflectionTimers[k] = setTimeout(function () {
            saveReflectionFlow(s, asg.id, id, ta.value, function (ok, msg) {
              if (ok) {
                var latest = getReflectionEntry(s, asg.id, id);
                status.textContent = latest && latest.updatedAt ? ("Saved " + fmtDateTime(latest.updatedAt)) : "Saved";
              } else {
                status.textContent = msg || "Could not save";
                toast(msg || "Couldn't save reflection");
              }
            });
          }, 450);
        });
        return el("div", { class: "wk-reflect wk-reflect--item" }, [
          el("div", { class: "wk-reflect-label" }, a.reflection ? "Your reflection" : "Your notes"),
          a.reflection ? el("p", { class: "wk-reflect-prompt" }, a.reflection) : null,
          ta, status
        ]);
      }

      if (stateName === "now") {
        body.appendChild(el("div", { class: "wk-eyebrow" }, "Up next"));
        body.appendChild(el("div", { class: "wk-name" }, a.name));
        body.appendChild(metaRow(a));
        if (a.instructions) body.appendChild(el("p", { class: "wk-blurb" }, a.instructions));
        body.appendChild(el("div", { class: "wk-actions" }, [markBtn(true), openBtn]));
        body.appendChild(reflectBox());
      } else if (stateName === "done") {
        body.appendChild(metaRow(a));
        body.appendChild(el("div", { class: "wk-name" }, a.name));
        body.appendChild(el("div", { class: "wk-doneline" }, [
          el("span", { class: "wk-logged" }, "Logged"),
          openBtn,
          el("button", { class: "wk-undo", onclick: function () { setCompletion(s, id, false, asg.id); renderAll(); } }, "undo")
        ]));
        body.appendChild(reflectBox());
      } else { // upcoming
        body.appendChild(metaRow(a));
        body.appendChild(el("div", { class: "wk-name" }, a.name));
        if (a.instructions) body.appendChild(el("p", { class: "wk-blurb" }, a.instructions));
        body.appendChild(el("div", { class: "wk-actions" }, [markBtn(false), openBtn, instrDetail()]));
        // The answer field is available on every item, not just the current/done ones —
        // athletes work ahead, revisit prompts, or jot observations before marking done.
        body.appendChild(reflectBox());
      }
      rep.appendChild(body);
      return rep;
    }

    function buildSet(asg) {
      var validIds = asg.items.filter(function (id) { return BY_ID[id]; });
      var firstUndone = validIds.findIndex(function (id) { return !completionAt(s, asg.id, id); });
      var complete = isComplete(asg);
      var set = el("section", { class: "wk-set" });

      var dueState = assignmentDueState(s, asg);
      var dueChip = dueState === "overdue" ? el("span", { class: "due-chip due-chip--overdue" }, "Overdue")
        : (dueState === "soon" ? el("span", { class: "due-chip due-chip--soon" }, "Due soon") : null);
      var metaParts = ["Assigned " + fmtDate(asg.createdAt)];
      if (asg.dueAt) metaParts.push("Due " + fmtDate(asg.dueAt));
      set.appendChild(el("div", { class: "wk-set-head" }, [
        el("h3", { class: "wk-set-title" }, [asg.title, dueChip]),
        el("div", { class: "wk-set-meta" }, metaParts.join(" · "))
      ]));
      if (asg.note) set.appendChild(el("div", { class: "wk-coachnote-wrap" }, [
        el("div", { class: "wk-coachnote-from" }, "From your coach"),
        noteNode(asg.note, "wk-coachnote")
      ]));

      var spine = el("div", { class: "wk-spine" });
      spine.appendChild(el("p", { class: "wk-spine-head" }, complete ? "The set" : "The set · in order"));
      if (!validIds.length) {
        spine.appendChild(el("p", { class: "no-link", style: "margin-left:56px" }, "This set has no activities yet."));
      }
      validIds.forEach(function (id, i) {
        var stateName = completionAt(s, asg.id, id) ? "done" : (i === firstUndone ? "now" : "upcoming");
        spine.appendChild(buildRep(asg, id, BY_ID[id], stateName));
      });
      set.appendChild(spine);
      return set;
    }

    var wrap = el("div", { class: "wk" });
    active.forEach(function (asg) { wrap.appendChild(buildSet(asg)); });
    panel.appendChild(wrap);

    if (finished.length) {
      var det = el("details", { class: "completed-assignments wk-done-sets" });
      det.appendChild(el("summary", { class: "completed-assignments-summary" }, [
        el("span", { class: "ca-title" }, "Finished sets"),
        el("span", { class: "ca-meta" }, String(finished.length) + (finished.length === 1 ? " set" : " sets"))
      ]));
      var body = el("div", { class: "completed-assignments-body wk" });
      finished.forEach(function (asg) { body.appendChild(buildSet(asg)); });
      det.appendChild(body);
      panel.appendChild(det);
    }
  }

  function renderStudentDetail() {
    var detail = $("#student-detail");
    detail.textContent = "";
    var s = activeStudent();
    if (!s) {
      detail.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, studentList().length ? "Choose an athlete to open their workspace" : "No athlete selected yet"),
        el("p", {}, studentList().length
          ? "Pick one athlete from the list so assignments, progress, and messages all stay in one place."
          : "Add an athlete first, then this panel becomes the place to assign work and review progress."),
        studentList().length ? el("button", { class: "btn btn--primary", type: "button", onclick: function () {
          setActiveStudent(studentList()[0].id);
          renderAll();
        } }, "Open first athlete") : null
      ]));
      return;
    }
    var canManage = canManageStudentWorkspace(s);
    var headActions = el("div", { class: "section-head-actions" }, [
      el("button", { class: "btn btn--sm", title: "Download all assignments as .pdf", onclick: function () { downloadAllAssignmentsPdf(s); } }, "⬇ Download all as PDF"),
      el("button", { class: "btn btn--sm", title: "Download all assignments as .txt", onclick: function () { downloadAllAssignmentsTxt(s); } }, "⬇ Download all as TXT"),
      canManage ? el("button", { class: "btn btn--sm btn--accent", onclick: function () { openAssignBuilderModal(s.id); } }, "+ New assignment") : null
    ]);
    detail.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, s.name + " — Assignments"),
      headActions
    ]));
    if (!canManage) {
      detail.appendChild(el("div", { class: "note-banner" }, "Read-only workspace: you can review assignments, progress, and reflections, but editing is limited to the student's coach (or admin/super admin)."));
    }
    if (!studentAssignments(s).length && canManage) {
      detail.appendChild(el("div", { class: "note-banner students-next-step" }, [
        el("strong", {}, "Next step:"),
        el("span", {}, " Create the first assignment for " + s.name + " so progress, reflections, and check-ins have a clear starting point."),
        el("button", { class: "btn btn--sm btn--accent", type: "button", onclick: function () { openAssignBuilderModal(s.id); } }, "Create first assignment")
      ]));
    }
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
    appendAssignmentList(detail, s, { admin: canManage, review: true });

    detail.appendChild(el("h3", { style: "margin:24px 0 14px" }, "Progress"));
    appendProgress(detail, s);
    appendWellbeing(detail, s);
    if (canManage) appendCoachComms(detail, s);
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
    appendWorkoutSpine(panel, s);
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
  // Client mirror of the server DEFAULT_CHECKIN (used until a super admin customizes the
  // check-in via the CMS). The effective config arrives in state.site.checkin (/site payload).
  var DEFAULT_CHECKIN_C = { dimensions: [
    { key: "mood", label: "Mood", low: "Tough", high: "Great", min: 1, max: 5, active: true, invert: false },
    { key: "energy", label: "Energy", low: "Drained", high: "Energized", min: 1, max: 5, active: true, invert: false },
    { key: "stress", label: "Stress", low: "Calm", high: "Stressed", min: 1, max: 5, active: true, invert: true }
  ] };
  function checkinConfig() {
    var c = state.site && state.site.checkin;
    return (c && Array.isArray(c.dimensions) && c.dimensions.length) ? c : DEFAULT_CHECKIN_C;
  }
  function checkinDims() { return checkinConfig().dimensions.filter(function (d) { return d.active !== false; }); }
  // Read a dimension's value from a check-in row: prefer the flexible `scores` map, then
  // fall back to the three legacy columns for rows written before migration 0021.
  function checkinScore(c, key) {
    if (!c) return null;
    if (c.scores && c.scores[key] != null) return c.scores[key];
    if ((key === "mood" || key === "energy" || key === "stress") && c[key] != null) return c[key];
    return null;
  }
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
    var out = {};
    checkinDims().forEach(function (d) {
      var vals = list.map(function (c) { return checkinScore(c, d.key); }).filter(function (v) { return v != null; });
      out[d.key] = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(1) : "—";
    });
    return out;
  }
  function checkinRow(c) {
    var parts = checkinDims().map(function (d) { return d.label + " " + scoreText(checkinScore(c, d.key)); }).join(" · ");
    return el("div", { class: "checkin-history-row" }, [
      el("span", { class: "ch-date" }, fmtDay(c.day)),
      el("span", { class: "ch-scores" }, parts),
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
    var dims = checkinDims();
    var picked = {};
    dims.forEach(function (d) { picked[d.key] = today ? checkinScore(today, d.key) : null; });

    var card = el("div", { class: "panel checkin-card" });
    card.appendChild(el("h3", {}, today ? "Update today’s check-in" : "How are you today?"));
    dims.forEach(function (dim) {
      var scale = el("div", { class: "checkin-scale" });
      var range = [];
      for (var v = dim.min; v <= dim.max; v++) range.push(v);
      range.forEach(function (n) {
        // An "inverted" dimension (higher = worse, e.g. Stress) shouldn't light its top end
        // in the celebratory lime — the high end gets a warm, calm tone instead.
        var warm = dim.invert && n >= dim.max - 1 ? " checkin-dot--warm" : "";
        var btn = el("button", { type: "button", class: "checkin-dot" + warm + (picked[dim.key] === n ? " is-on" : ""), "aria-label": dim.label + " " + n + " of " + dim.max, "aria-pressed": picked[dim.key] === n ? "true" : "false", onclick: function () {
          picked[dim.key] = (picked[dim.key] === n ? null : n);
          $all(".checkin-dot", scale).forEach(function (b) { var bn = parseInt(b.textContent, 10); var on = picked[dim.key] === bn; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
        } }, String(n));
        scale.appendChild(btn);
      });
      card.appendChild(el("div", { class: "checkin-dim" }, [
        el("div", { class: "checkin-dim-head" }, [
          el("span", { class: "checkin-dim-label" }, dim.label),
          (dim.low || dim.high) ? el("span", { class: "checkin-dim-ends" }, (dim.low || "") + " → " + (dim.high || "")) : null
        ]),
        scale
      ]));
    });
    var note = el("textarea", { class: "checkin-note", placeholder: "Anything on your mind? (optional)" });
    if (today && today.note) note.value = today.note;
    card.appendChild(el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]));
    card.appendChild(el("button", { class: "btn btn--accent", onclick: function () {
      saveCheckin({ scores: picked, note: note.value.trim() });
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
      var wbDims = checkinDims();
      var latestStr = wbDims.map(function (d) { return d.label + " " + scoreText(checkinScore(latest, d.key)); }).join(" · ");
      var avgStr = wbDims.map(function (d) { return d.label + " " + avg[d.key]; }).join(" · ");
      var head = el("div", { class: "wellbeing-summary" }, [
        el("span", { class: "wb-chip" }, "Latest " + fmtDay(latest.day) + ": " + latestStr),
        el("span", { class: "wb-chip" }, "14-day average: " + avgStr),
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

  function saveCheckin(payload) {
    var s = activeStudent(); if (!s) return;
    var day = todayKey();
    var scores = payload.scores || {};
    if (SERVER) {
      api("/checkins", { method: "POST", body: { day: day, scores: scores, note: payload.note } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save check-in")); return; }
        refreshFromServer().then(function () { renderAll(); toast("Check-in saved. Thanks for checking in."); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    s.checkins = (s.checkins || []).filter(function (c) { return c.day !== day; });
    // Store the scores map; mirror the three canonical dims into flat fields for any legacy reader.
    s.checkins.unshift({ day: day, scores: scores, mood: scores.mood != null ? scores.mood : null, energy: scores.energy != null ? scores.energy : null, stress: scores.stress != null ? scores.stress : null, note: payload.note, updatedAt: new Date().toISOString() });
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
    container.appendChild(el("p", { class: "field-hint" }, "Only you can see this. The athlete never will."));
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
    var title = el("input", { type: "text", placeholder: "e.g. Week 2: Focus" });
    var note = el("textarea", { placeholder: "Optional note" });
    var due = el("input", { type: "date" });
    var chosenActs = {};
    var actSummary = el("p", { class: "field-hint" }, "Pick a template to choose the activities.");
    var tsel = el("select", {});
    tsel.appendChild(option("", templates.length ? "Choose a template…" : "No templates yet. Save one from an assignment first."));
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
      if (label) label.textContent = "Current athlete";
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
    if (!c) return;
    if (isAdminView() && !s) {
      c.textContent = studentList().length ? "Choose an athlete to keep working." : "Add an athlete to get started.";
      return;
    }
    if (s) {
      // Always report progress out of what's assigned to this athlete, not the
      // whole catalogue — matches the progress bars in the detail views.
      var assigned = assignedActivityIds(s);
      var doneAssigned = assigned.filter(function (id) { return !!completionAny(s, id); }).length;
      c.textContent = assigned.length
        ? (doneAssigned + " / " + assigned.length + " assigned done")
        : "Nothing assigned yet";
    } else { c.textContent = ""; }
  }

  /* ----------------------------- Tabs / role ----------------------------- */
  function currentTabs() {
    // The explicit menu (or, as a fallback, published pages with a nav label) appears as
    // extra tabs for everyone — page tabs switch views; custom links open in a new tab.
    function withNavPages(tabs) {
      (state.navPages || []).forEach(function (p) {
        if (p.href) tabs.push({ id: "ext:" + p.href, label: p.label, href: p.href });
        else tabs.push({ id: "page:" + p.id, label: p.label });
      });
      return tabs;
    }
    if (!isAdminView()) {
      var meS = activeStudent();
      var unread = meS ? threadUnread(meS, "coach") : 0;
      return withNavPages([
        { id: "workouts", label: slot("nav.workouts") },
        { id: "checkin", label: slot("nav.checkin") },
        { id: "messages", label: slot("nav.messages") + (unread ? " (" + unread + ")" : "") },
        { id: "progress", label: slot("nav.progress") }
      ]);
    }
    // Coach base tabs; each higher tier adds tabs so the set is a visible superset.
    var tabs = [
      { id: "repo", label: slot("nav.repo") },
      { id: "students", label: slot("nav.students") }, { id: "content", label: slot("nav.content") }
    ];
    if (isAtLeastAdmin() && !soloMode()) tabs.push({ id: "manage", label: slot("nav.team") });
    if (isSuperadmin() || (isAtLeastAdmin() && adminCmsAccess())) tabs.push({ id: "appearance", label: slot("nav.cms") });
    tabs.push({ id: "settings", label: slot("nav.settings") });
    return withNavPages(tabs);
  }

  function renderTabs() {
    var nav = $("#tabs");
    nav.textContent = "";
    currentTabs().forEach(function (t) {
      if (t.href) {
        nav.appendChild(el("a", { class: "tab", href: safeUrl(t.href) || "#", target: "_blank", rel: "noopener noreferrer" }, t.label));
      } else {
        nav.appendChild(el("button", { class: "tab", "data-tab": t.id, onclick: function () { setTab(t.id); } }, t.label));
      }
    });
  }

  function setTab(tab) {
    // Builder pages: any "page:<slug>" id renders into the shared #view-page section.
    // Direct #/p/<slug> links work even when the page isn't in the nav.
    if (tab && tab.indexOf("page:") === 0) {
      var slug = tab.slice(5);
      state.tab = tab;
      var pv = ensurePageView();
      renderPublicPage(slug, pv);
      $all(".tab").forEach(function (b) {
        var on = b.getAttribute("data-tab") === tab;
        b.classList.toggle("is-active", on);
        if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
      });
      $all(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === "view-page"); });
      if (location.hash !== "#/p/" + slug) history.replaceState(null, "", "#/p/" + slug);
      return;
    }
    var ids = currentTabs().map(function (t) { return t.id; });
    if (ids.indexOf(tab) === -1) tab = ids[0];
    state.tab = tab;
    // Render the tabs that aren't part of the always-present static markup on demand.
    if (tab === "manage" && isAtLeastAdmin()) renderManage();
    else if (tab === "appearance" && isAtLeastAdmin()) renderAppearance();
    $all(".tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $all(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === "view-" + tab); });
    // The CMS tab keeps its open section in the hash (#cms/<section>) so it deep-links
    // and survives a reload; every other tab is just "#<id>".
    var targetHash = tab === "appearance" ? ("#cms/" + cmsSection()) : ("#" + tab);
    if (location.hash !== targetHash) history.replaceState(null, "", targetHash);
  }

  // Sync all role-dependent chrome (body flag, header buttons, badge, tabs) to
  // the current view + auth state.
  function applyRole() {
    document.body.setAttribute("data-role", isAdminView() ? "admin" : "student");
    decorateSlotEditing();   // refresh inline ✎ copy-edit buttons on role/view changes
    var addBtn = $("#add-student-form button"); if (addBtn) addBtn.textContent = SERVER ? "Add athlete" : "Add student";
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
    setAuthed(false); goStudent(); toast("Logged out. Back in student view.");
  }

  /* ----------------------------- Modal ----------------------------- */
  var modalReturnFocus = null;
  var modalOnClose = null;
  function modalFocusables(container) {
    return $all('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter(function (n) { return n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement; });
  }
  function closeModal() {
    var root = $("#modal-root");
    var onClose = modalOnClose; modalOnClose = null;
    if (typeof onClose === "function") { try { onClose(); } catch (e) {} }
    root.hidden = true; root.setAttribute("aria-hidden", "true"); root.textContent = ""; root.onclick = null;
    document.removeEventListener("keydown", modalKeydown);
    // Return focus to whatever opened the modal (WCAG 2.4.3 / keyboard-first).
    var ret = modalReturnFocus; modalReturnFocus = null;
    if (ret && typeof ret.focus === "function") { try { ret.focus(); } catch (e) {} }
  }
  function modalKeydown(e) {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key !== "Tab") return;
    // Trap Tab focus inside the dialog so keyboard users can't fall into the page behind it.
    var modal = $("#modal-root .modal");
    if (!modal) return;
    var f = modalFocusables(modal);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !modal.contains(active)) { e.preventDefault(); last.focus(); }
    } else if (active === last || !modal.contains(active)) {
      e.preventDefault(); first.focus();
    }
  }
  function openModal(title, bodyNode, actions, onClose) {
    var root = $("#modal-root");
    modalReturnFocus = document.activeElement;
    modalOnClose = typeof onClose === "function" ? onClose : null;
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
    // Move focus into the dialog: first real field, else the close button. Callers that
    // want a specific field still focus it after this returns (their call wins).
    var f = modalFocusables(modal);
    var target = f.filter(function (n) { return !/modal-close/.test(n.className); })[0] || f[0];
    if (target) setTimeout(function () { try { target.focus(); } catch (e) {} }, 30);
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

  // A coach picker for admins reassigning a student. Every athlete must have a coach —
  // an unassigned athlete vanishes from every roster — so there is no "unassign" option;
  // the placeholder ("") just means "not chosen yet" and the server rejects it.
  // Admins and super admins are valid targets too (an admin+ who takes a student simply
  // coaches them directly — in solo mode they're the only possible target).
  // excludeId drops one coach (e.g. the student's current one); selectedId pre-selects.
  function coachSelectNode(selectedId, excludeId) {
    var sel = el("select", {});
    sel.appendChild(option("", "— Pick a coach —"));
    var targets = (state.coaches || []).map(function (c) { return { id: c.id, name: c.name }; })
      .concat((state.admins || []).map(function (c) { return { id: c.id, name: c.name + " (admin)" }; }))
      .concat((state.superadmins || []).map(function (c) { return { id: c.id, name: c.name + " (super admin)" }; }))
      .filter(function (c) { return c.id !== excludeId; });
    targets.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
    targets.forEach(function (c) { sel.appendChild(option(c.id, c.name)); });
    sel.value = (selectedId != null ? selectedId : "");
    return sel;
  }

  // Assign a fixed set of activities (a generated workout, or one card) to a student.
  function openAssignModal(activityIds, defaultTitle) {
    activityIds = (activityIds || []).filter(function (id) { return BY_ID[id]; });
    if (!activityIds.length) { toast("Nothing to assign"); return; }
    if (!studentList().length) { toast("Add a student first (Students tab)"); return; }
    var sel = studentSelectNode();
    var title = el("input", { type: "text", value: defaultTitle || "Workout" });
    var note = el("textarea", { placeholder: "Optional note: why this matters, or how often to do it…" });
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
        el("li", {}, "Click Share → Copy link, or simply copy the address from your browser's address bar."),
        el("li", {}, "Make sure the file is shared with this student's own account, or it won't open for them."),
        el("li", {}, "Paste it below and press Test to confirm it opens.")
      ])
    ]);
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "This link is only for this student. It's useful for a document in their private folder. Set it once and it applies anywhere this activity is assigned to them, replacing the default link."),
      (a && a.link) ? el("p", { class: "field-hint" }, "Default link (everyone else): " + a.link) : null,
      howto,
      el("div", { class: "field" }, [
        el("label", {}, "Custom link for this student"),
        el("div", { style: "display:flex; gap:8px; align-items:center;" }, [input, testBtn])
      ]),
      el("p", { class: "field-hint" }, "Tip: the student needs access with their own account. If they see “Request access,” share the file with them first.")
    ]);
    function commit(v) {
      setItemLinkFlow(studentId, asg.id, activityId, v, function () {
        closeModal(); renderAll(); toast(v ? "Custom link saved" : "Custom link removed");
      });
    }
    openModal("Custom link: " + (a ? a.name : "activity"), body, [
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
    var title = el("input", { type: "text", placeholder: "e.g. Week 1: Confidence" });
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
      if (!picks.length) { toast("No new activities match. Try a broader topic or type."); return; }
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
        field("Progression", "progression", { list: "dl-progressions", placeholder: "Week 3 / Advanced" }),
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
        el("div", { class: "brand-name", "data-slot": "brand.name" }, slot("brand.name")),
        el("div", { class: "brand-tag", "data-slot": "brand.tag" }, slot("brand.tag"))
      ])
    ]);
  }
  // Floating light/dark switch for the signed-out gate. The header toggle is hidden
  // pre-auth, so this gives visitors a way to flip themes on the landing page itself.
  function buildAuthThemeToggle() {
    var btn = el("button", {
      class: "auth-theme-toggle",
      type: "button",
      title: "Switch between light and dark",
      "aria-label": "Switch between light and dark theme"
    });
    function sync() {
      var cur = document.body.getAttribute("data-theme") || detectTheme();
      btn.textContent = cur === "dark" ? "\u2600\uFE0E Light" : "\u263E\uFE0E Dark";
    }
    btn.addEventListener("click", function () { toggleTheme(); sync(); });
    sync();
    return btn;
  }
  // Full-screen, non-dismissable gate shown when the backend is reachable but the
  // visitor has no session. Routes to an invite-accept form if ?invite= is present.
  function showAuthGate(offline) {
    if ($("#auth-gate")) return;
    document.body.setAttribute("data-auth-shell", "signed-out");
    var customLanding = el("div", { class: "auth-landing-custom", id: "auth-landing", hidden: true });
    var hero = buildSignedOutHero(customLanding);
    var card = el("div", { class: "auth-card" });
    var top = el("div", { class: "auth-shell-top" }, [hero, card]);
    var preview = buildSignedOutPreview();
    var stack = el("div", { class: "auth-stack auth-stack--hybrid" }, [top, preview]);
    var root = el("div", { class: "auth-gate", id: "auth-gate", role: "dialog", "aria-modal": "true", "aria-label": "Sign in" }, stack);
    root.appendChild(buildAuthThemeToggle());
    document.body.appendChild(root);
    var invite = getQueryParam("invite");
    if (invite) { renderAcceptForm(card, invite); return; }
    renderLoginForm(card, offline);
    if (!offline) renderLandingInto(customLanding);
  }

  function buildSignedOutHero(customLanding) {
    return el("section", { class: "signedout-hero", "aria-labelledby": "signedout-hero-title" }, [
      el("div", { class: "signedout-brand" }, [authHeader()]),
      el("div", { class: "signedout-kicker", "data-slot": "hero.kicker" }, slot("hero.kicker")),
      el("h1", { class: "signedout-title", id: "signedout-hero-title", "data-slot": "hero.title" }, slot("hero.title")),
      el("p", { class: "signedout-copy", "data-slot": "hero.copy" }, slot("hero.copy")),
      buildSignedOutMoment(),
      el("div", { class: "signedout-roles", "aria-label": "Who this is for" }, [
        el("span", { class: "signedout-role", "data-slot": "hero.role1" }, slot("hero.role1")),
        el("span", { class: "signedout-role", "data-slot": "hero.role2" }, slot("hero.role2")),
        el("span", { class: "signedout-role", "data-slot": "hero.role3" }, slot("hero.role3"))
      ]),
      buildSignedOutStartGuide(),
      el("div", { class: "signedout-actions" }, [
        el("button", { class: "btn btn--primary", type: "button", onclick: focusAuthCard }, "Go to sign in"),
        el("button", { class: "btn btn--ghost", type: "button", onclick: focusPreviewSection }, "See sample activities")
      ]),
      el("div", { class: "signedout-note" }, [
        el("strong", { "data-slot": "hero.note_title" }, slot("hero.note_title")),
        " ",
        el("span", { "data-slot": "hero.note_copy" }, slot("hero.note_copy"))
      ]),
      customLanding
    ]);
  }

  function buildSignedOutMoment() {
    // Time-of-day flavor line; each period's copy is its own editable slot.
    var hour = new Date().getHours();
    var period = hour < 11 ? "morning" : (hour < 17 ? "midday" : "evening");
    return el("div", { class: "signedout-moment", "aria-label": "Current training moment" }, [
      el("span", { class: "signedout-moment-label", "data-slot": "moment." + period + "_label" }, slot("moment." + period + "_label")),
      el("span", { class: "signedout-moment-copy", "data-slot": "moment." + period + "_copy" }, slot("moment." + period + "_copy"))
    ]);
  }

  function buildSignedOutStartGuide() {
    function step(n) {
      return el("li", { class: "signedout-guide-step" }, [
        el("strong", { "data-slot": "guide.step" + n + "_title" }, slot("guide.step" + n + "_title")),
        " ",
        el("span", { "data-slot": "guide.step" + n + "_copy" }, slot("guide.step" + n + "_copy"))
      ]);
    }
    return el("section", { class: "signedout-guide", "aria-labelledby": "signedout-guide-title" }, [
      el("div", { class: "signedout-guide-head" }, [
        el("h2", { class: "signedout-guide-title", id: "signedout-guide-title", "data-slot": "guide.title" }, slot("guide.title")),
        el("span", { class: "signedout-guide-meta", "data-slot": "guide.meta" }, slot("guide.meta"))
      ]),
      el("ol", { class: "signedout-guide-list" }, [step(1), step(2), step(3)])
    ]);
  }

  function focusAuthCard() {
    var card = document.querySelector("#auth-gate .auth-card");
    if (!card) return;
    try { card.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    var target = card.querySelector("input, button, a");
    if (target && typeof target.focus === "function") setTimeout(function () { target.focus(); }, 120);
  }

  function focusPreviewSection() {
    var preview = document.querySelector("#auth-gate .signedout-preview");
    if (!preview) return;
    try { preview.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
  }

  function buildSignedOutPreview() {
    var sample = pickSignedOutPreviewActivities();
    var list = el("div", { class: "signedout-preview-grid" });
    sample.forEach(function (a) { list.appendChild(createSignedOutPreviewCard(a)); });
    return el("section", { class: "signedout-preview", "aria-labelledby": "signedout-preview-title" }, [
      el("div", { class: "signedout-preview-head" }, [
        el("div", {}, [
          el("div", { class: "signedout-preview-kicker", "data-slot": "preview.kicker" }, slot("preview.kicker")),
          el("h2", { id: "signedout-preview-title", "data-slot": "preview.title" }, slot("preview.title")),
            el("p", { class: "signedout-preview-copy", "data-slot": "preview.copy" }, slot("preview.copy"))
        ]),
        el("div", { class: "signedout-preview-meta" }, sample.length + " sample activities")
      ]),
      list
    ]);
  }

  function pickSignedOutPreviewActivities() {
    var picked = [];
    var seenTopics = {};
    (BASE || []).forEach(function (a) {
      if (!a || picked.length >= 4) return;
      var topic = a.topic || "General";
      if (seenTopics[topic]) return;
      seenTopics[topic] = true;
      picked.push(a);
    });
    if (picked.length < 4) {
      (BASE || []).forEach(function (a) {
        if (!a || picked.length >= 4) return;
        if (picked.indexOf(a) === -1) picked.push(a);
      });
    }
    return picked;
  }

  function createSignedOutPreviewCard(a) {
    var summary = (a.instructions || a.reflection || "A guided mental performance activity.").replace(/\s+/g, " ").trim();
    if (summary.length > 160) summary = summary.slice(0, 157).trim() + "...";
    var tags = [];
    var cue = signedOutPreviewCue(a, tags.length);
    if (a.topic) tags.push(el("span", { class: "signedout-preview-chip signedout-preview-chip--topic" }, a.topic));
    if (a.type) tags.push(el("span", { class: "signedout-preview-chip" }, a.type));
    if (a.time) tags.push(el("span", { class: "signedout-preview-chip signedout-preview-chip--meta" }, a.time));
    return el("article", { class: "signedout-preview-card" }, [
      el("div", { class: "signedout-preview-card-head" }, [
        el("h3", { class: "signedout-preview-card-title" }, a.name || "Activity"),
        a.progression ? el("span", { class: "signedout-preview-week" }, a.progression) : null
      ]),
      cue.eyebrow ? el("div", { class: "signedout-preview-eyebrow" }, cue.eyebrow) : null,
      el("div", { class: "signedout-preview-chips" }, tags),
      el("p", { class: "signedout-preview-summary" }, summary),
      el("div", { class: "signedout-preview-footer" }, [
        el("span", { class: "signedout-preview-hint" }, cue.hint),
        el("span", { class: "signedout-preview-lock", "aria-hidden": "true" }, cue.badge)
      ])
    ]);
  }

  function signedOutPreviewCue(a) {
    var type = String(a && a.type || "").toLowerCase();
    var topic = String(a && a.topic || "").toLowerCase();
    if (type === "video") {
      return { eyebrow: "Watch, then reflect", hint: "A quick visual reset before the full workspace opens.", badge: "Sample" };
    }
    if (type === "exercise") {
      return { eyebrow: "Do this in the moment", hint: "Open your workspace to track it as part of an assignment.", badge: "Try first" };
    }
    if (topic.indexOf("focus") !== -1) {
      return { eyebrow: "Good before practice", hint: "Keep this kind of focus work attached to your coach plan.", badge: "Focus cue" };
    }
    return { eyebrow: "Built for steady reps", hint: "Sign in to save progress, reflections, and follow-up from coaches.", badge: "Preview" };
  }
  // Render builder-page content for signed-out visitors: the published 'landing' page by
  // default, or whichever page a "#/p/<slug>" link points at, plus nav links for every
  // published page that opted into the nav. Both endpoints are public; when neither a
  // page nor nav links exist the sign-in card simply shows on its own.
  function renderLandingInto(mount, slugOverride) {
    var h = (location.hash || "").replace("#", "");
    var slug = slugOverride || (h.indexOf("/p/") === 0 ? h.slice(3) : "landing");
    Promise.all([api("/pages/" + encodeURIComponent(slug)), api("/nav")]).then(function (out) {
      var pageRes = out[0];
      var nav = (out[1].ok && out[1].data && out[1].data.nav) || [];
      var hasPage = pageRes.ok && pageRes.data && Array.isArray(pageRes.data.blocks) && pageRes.data.blocks.length;
      if (!hasPage && !nav.length) return;
      mount.textContent = "";
      if (nav.length) {
        var row = el("nav", { class: "landing-nav", "aria-label": "Pages" });
        nav.forEach(function (p) {
          row.appendChild(el("a", {
            class: "landing-nav-link" + (p.id === slug ? " is-active" : ""),
            href: "#/p/" + p.id
          }, p.label));
        });
        mount.appendChild(row);
      }
      if (hasPage) {
        var wrap = el("div", { class: "pb-page" });
        renderPageBlocks(pageRes.data.blocks, wrap);
        mount.appendChild(wrap);
      }
      mount.hidden = false;
    }).catch(function () {});
  }
  function renderLoginForm(card, offline) {
    card.textContent = "";
    var email = el("input", { type: "email", id: "auth-email", placeholder: "you@email.com", autocomplete: "username" });
    var pass = el("input", { type: "password", id: "auth-pass", placeholder: "Password", autocomplete: "current-password" });
    var newPass = el("input", { type: "password", id: "auth-new-pass", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var setupRow = el("p", { class: "field-hint", style: "text-align:center; margin-top:4px" });
    // Revealed only when the server answers FORCE_PASSWORD_CHANGE: the account's
    // original password was published, so a replacement must be chosen to sign in.
    var newPassField = el("div", { class: "field" }, [
      el("label", { for: "auth-new-pass" }, "Choose a new password"),
      newPass,
      el("p", { class: "field-hint" }, "For security, pick a new password before continuing — the original one for this account needs to be retired.")
    ]);
    newPassField.hidden = true;
    function submit() {
      errBox.hidden = true;
      var em = email.value.trim(), pw = pass.value;
      if (!em || !pw) { errBox.textContent = "Enter your email and password."; errBox.hidden = false; return; }
      var body = { email: em, password: pw };
      if (!newPassField.hidden) {
        var np = newPass.value;
        if (np.length < 8) { errBox.textContent = "The new password needs at least 8 characters."; errBox.hidden = false; newPass.focus(); return; }
        body.new_password = np;
      }
      api("/login", { method: "POST", body: body }).then(function (res) {
        if (!res.ok) {
          if (res.data && res.data.code === "FORCE_PASSWORD_CHANGE") {
            if (newPassField.hidden) { newPassField.hidden = false; setTimeout(function () { newPass.focus(); }, 30); }
            errBox.textContent = apiError(res, "Pick a new password to continue.");
            errBox.hidden = false;
            return;
          }
          errBox.textContent = apiError(res, "Invalid email or password."); errBox.hidden = false; pass.value = ""; pass.focus(); return;
        }
        location.reload();
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    card.appendChild(el("div", { class: "auth-card-kicker" }, "Sign in to continue"));
    card.appendChild(el("h3", { class: "auth-title" }, "Sign in"));
    card.appendChild(el("p", { class: "field-hint" }, "Sign in with your email and password. Athletes should use the email and sign-in code their coach shared with them."));
    card.appendChild(buildAuthFlowGuide("signin"));
    if (offline) {
      card.appendChild(el("div", { class: "warn" }, "We can't reach the PerformanceXtra server right now, so sign-in is temporarily unavailable. Try this link again in a moment."));
    }
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", { for: "auth-email" }, "Email"), email]),
      el("div", { class: "field" }, [el("label", { for: "auth-pass" }, "Password / sign-in code"), pass]),
      newPassField,
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Sign in"),
      setupRow
    ]));
    [email, pass, newPass].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }); });
    setTimeout(function () { email.focus(); }, 30);
    if (offline) return;
    api("/setup-status").then(function (res) {
      setupRow.textContent = "";
      if (res.ok && res.data && res.data.needsSetup) {
        setupRow.appendChild(document.createTextNode("First time here? "));
        setupRow.appendChild(el("a", { href: "#", onclick: function (e) { e.preventDefault(); renderSetupForm(card); } }, "Create the admin account"));
      } else {
        setupRow.textContent = "Athletes should sign in with the email and sign-in code their coach shared with them.";
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
    card.appendChild(el("div", { class: "auth-card-kicker" }, "First-time setup"));
    card.appendChild(el("h3", { class: "auth-title" }, "Create the admin account"));
    card.appendChild(el("p", { class: "field-hint" }, "This first account becomes the super admin. After that, you can add coaches, and each coach manages their own athletes."));
    card.appendChild(buildAuthFlowGuide("setup"));
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
    card.appendChild(el("div", { class: "auth-card-kicker" }, "Finish your account"));
    card.appendChild(el("h3", { class: "auth-title" }, "Set your password"));
    card.appendChild(el("p", { class: "field-hint" }, "Welcome! Pick a password to finish setting up your account. Next time you'll sign in with your email and this password."));
    card.appendChild(buildAuthFlowGuide("accept"));
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Password"), pass]),
      el("div", { class: "field" }, [el("label", {}, "Confirm password"), confirm]),
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Set password & continue")
    ]));
    [pass, confirm].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }); });
    setTimeout(function () { pass.focus(); }, 30);
  }

  function buildAuthFlowGuide(kind) {
    var config = {
      signin: {
        title: "What happens next",
        items: [
          "Athletes use the email and sign-in code shared by their coach.",
          "Coaches, admins, and super admins use their staff password.",
          "After sign-in, PerformanceXtra opens the workspace that matches your role."
        ]
      },
      setup: {
        title: "First-time setup flow",
        items: [
          "Create one super admin account for the workspace.",
          "Sign in, then add coaches and team members from the management area.",
          "You can refine content, branding, and landing copy after access is live."
        ]
      },
      accept: {
        title: "After you set your password",
        items: [
          "You'll use your email and this password next time you sign in.",
          "Your assigned workouts and check-ins appear right away.",
          "If something looks missing, your coach controls what shows up in your workspace."
        ]
      }
    };
    var flow = config[kind];
    if (!flow) return null;
    return el("section", { class: "auth-flow-guide", "aria-label": flow.title }, [
      el("div", { class: "auth-flow-guide-title" }, flow.title),
      el("ol", { class: "auth-flow-guide-list" }, flow.items.map(function (item) {
        return el("li", { class: "auth-flow-guide-step" }, item);
      }))
    ]);
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

  // Coach: add an athlete. The server generates a one-time passcode the coach shares with them.
  function openAddAthleteModal(prefillName) {
    var name = el("input", { type: "text", value: prefillName || "", placeholder: "Athlete's name" });
    var email = el("input", { type: "email", placeholder: "their@email.com", autocomplete: "off" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var matchesPanel = el("div", { class: "dupe-matches" }); matchesPanel.hidden = true;
    var dupCheck = el("input", { type: "checkbox" });
    var dupConfirm = el("label", { class: "dupe-confirm" }, [dupCheck, el("span", {}, " This is a different person — create anyway")]); dupConfirm.hidden = true;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "We'll create the athlete and generate a one-time sign-in code. Share the email and code with them — they can use it right away to enter the shared workspace."),
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
        state.allStudents = null;   // the All-students directory and Users screen re-fetch
        refreshFromServer().then(function () { renderAll(); showCredentialsModal(res.data); });
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    openModal("Add athlete", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create & get sign-in code", accent: true, onClick: submit }
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }
  // Show the one-time login credentials (email + sign-in code) the coach shares with a student.
  function showCredentialsModal(data) {
    var athlete = (data && (data.athlete || data.coach || data.user)) || {};
    var who = athlete.name || "this person";
    var email = athlete.email || "";
    var passcode = (data && data.passcode) || "";
    var loginUrl = (data && data.loginUrl) || location.origin + "/";

    var creds = "Email: " + email + "\nSign-in code: " + passcode + "\nSign in at: " + loginUrl;
    var emailField = el("input", { type: "text", value: email, readonly: true });
    var passField = el("input", { type: "text", value: passcode, readonly: true, style: "font-family:monospace; letter-spacing:0.5px" });
    [emailField, passField].forEach(function (i) { i.addEventListener("focus", function () { this.select(); }); });

    var body = el("div", { class: "form-stack" }, [
      el("p", {}, "Share these sign-in details with " + who + ". This sign-in code is shown once, so copy it now. If it is lost, use “Reset sign-in code” on their row to create a new one."),
      el("div", { class: "field" }, [el("label", {}, "Email"), emailField]),
      el("div", { class: "field" }, [el("label", {}, "Sign-in code"), passField])
    ]);
    openModal("Sign-in details", body, [
      { label: "Copy details", primary: true, onClick: function () { copyText(creds).then(function (ok) { toast(ok ? "Login details copied" : "Couldn't copy — select them manually"); }); } },
      { label: "Done", onClick: closeModal }
    ]);
    setTimeout(function () { passField.focus(); passField.select(); }, 30);
  }
  function resetPasscode(s) {
    if (!confirm("Generate a new sign-in code for " + s.name + "? Their old code stops working.")) return;
    api("/athletes/" + encodeURIComponent(s.id) + "/reset-passcode", { method: "POST" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't reset sign-in code")); return; }
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
      else if (state.tab === "appearance") renderAppearance();   // the CMS Users screen lists staff too
    }).catch(function () { toast("Couldn't refresh"); });
  }

  function staffPanel(title, addLabel, tier, rows, note) {
    rows = rows || [];
    var panel = el("div", { class: "panel team-panel team-panel--" + tier });
    panel.appendChild(el("div", { class: "section-head section-head--stacked" }, [
      el("div", { class: "section-head-copy" }, [
        el("h3", {}, title),
        note ? el("p", { class: "section-head-note" }, note) : null
      ]),
      el("div", { class: "section-head-actions" }, [
        el("span", { class: "cms-count" }, rows.length + " total"),
        el("button", { class: "btn btn--sm btn--primary", onclick: function () { openAddStaffModal(tier); } }, addLabel)
      ])
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
      actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new sign-in code to send them", onclick: function () { resetStaffPasscode(c, tier); } }, "↻ Reset sign-in code"));
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
        ? "Manage everyone who runs the program. Coaches manage their own athletes; admins also create coaches; super admins can do everything, including the shared library and site appearance. Each person signs in with their email and a one-time sign-in code you share with them, then sets their own password."
        : "Create and manage coach accounts. Each coach signs in with their email and a one-time sign-in code you share with them, then manages their own athletes.")
    ]));
    var stack = el("div", { class: "team-stack" + (isSuperadmin() ? " team-stack--superadmin" : "") });
    stack.appendChild(staffPanel("Coaches", "+ Add coach", "coach", state.coaches || [], "The people assigning work, checking progress, and staying in touch with athletes."));
    if (isSuperadmin()) {
      var side = el("div", { class: "team-side-stack" }, [
        staffPanel("Admins", "+ Add admin", "admin", state.admins || [], "Program operators who can add coaches and manage the shared team setup."),
        staffPanel("Super admins", "+ Add super admin", "superadmin", state.superadmins || [], "Top-level access for appearance, global content, and operational control.")
      ]);
      stack.appendChild(side);
    }
    view.appendChild(stack);
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
      el("p", { class: "field-hint" }, "We'll create the " + who + " and generate a one-time sign-in code. Share the email and code with them. They sign in with those details and can set their own password afterward."),
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
      { label: "Create & get sign-in code", accent: true, onClick: submit }
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }

  function resetStaffPasscode(c, tier) {
    if (!confirm("Generate a new sign-in code for " + c.name + "? Their old code stops working.")) return;
    var path = (tier === "coach" ? "/coaches/" : "/users/") + encodeURIComponent(c.id) + "/reset-passcode";
    api(path, { method: "POST" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't reset sign-in code")); return; }
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
      el("p", { class: "field-hint" }, "Students belonging to " + c.name + ". Move them to another coach, unassign them, or delete them to free up this " + tier + " for removal."),
      listBox
    ]);
    function load() {
      listBox.textContent = "Loading…";
      api("/athletes?coachId=" + encodeURIComponent(c.id)).then(function (res) {
        listBox.textContent = "";
        var rows = (res.ok && res.data && res.data.athletes) || [];
        if (!rows.length) { listBox.appendChild(el("p", { class: "no-link" }, "No students. This " + tier + " can be deleted now.")); return; }
        rows.forEach(function (s) {
          var nameKids = [el("span", { class: "name" }, s.name)];
          if (s.email) nameKids.push(el("span", { class: "student-email" }, s.email));
          var row = el("div", { class: "student-row" }, [el("span", { class: "name-wrap" }, nameKids)]);
          // Reassign to another coach, then Move — the non-destructive way to empty
          // this coach's roster so they can be deleted. A target coach is required.
          var moveSel = coachSelectNode("", c.id);
          var moveBtn = el("button", { class: "btn btn--sm btn--ghost", title: "Move " + s.name + " to the selected coach", onclick: function () {
            if (!moveSel.value) { toast("Pick a coach first"); return; }
            api("/athletes/" + encodeURIComponent(s.id) + "/reassign", { method: "POST", body: { coachId: moveSel.value } }).then(function (r) {
              if (!r.ok) { toast(apiError(r, "Couldn't move")); return; }
              toast("Moved " + s.name); load(); refreshStaff();
            }).catch(function () { toast("Couldn't reach the server"); });
          } }, "Move");
          row.appendChild(el("div", { class: "student-row-actions" }, [
            moveSel, moveBtn,
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
    fontScale: "1", scaleRatio: "1.25"
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
    // Derived type-scale steps (base size × ratio^n). --font-scale still drives the global
    // text size as before; these --text-* steps expose a proper type scale for page/block
    // typography going forward. scaleRatio is a derived token (not a direct CSS var), so it
    // lives in DEFAULT_THEME(_C) but not THEME_VAR_MAP.
    var base = 16 * (parseFloat(theme.fontScale) || 1);
    var ratio = parseFloat(theme.scaleRatio) || 1.25;
    var steps = { "--text-sm": -1, "--text-base": 0, "--text-lg": 1, "--text-xl": 2, "--text-2xl": 3, "--text-3xl": 4 };
    Object.keys(steps).forEach(function (v) { r.style.setProperty(v, (base * Math.pow(ratio, steps[v])).toFixed(2) + "px"); });
  }
  // Apply the uploaded logo (header brand mark) and favicon. Both are optional media-library
  // images stored in site_settings.site; absent values fall back to the built-in "PX" mark
  // and the default favicon. Safe pre-login so the sign-in page brands itself too.
  function applySiteBranding(site) {
    site = site || (state.site && state.site.site) || {};
    var logo = $(".brand-logo");
    if (logo) {
      var url = safeImageSrc(site.logoUrl);
      if (url) {
        logo.textContent = "";
        logo.classList.add("brand-logo--img");
        logo.appendChild(el("img", { src: url, alt: slot("brand.name") || "Logo" }));
      } else {
        logo.classList.remove("brand-logo--img");
        if (!logo.firstChild || logo.querySelector("img")) logo.textContent = "PX";
      }
    }
    var fav = safeImageSrc(site.faviconUrl);
    if (fav) {
      var link = $("link[rel='icon']");
      if (!link) { link = el("link", { rel: "icon" }); document.head.appendChild(link); }
      link.setAttribute("href", fav);
    }
  }
  // Fetch the saved site theme/copy and apply it. Safe pre-login (the endpoint is public)
  // and tolerant of a missing/empty table (returns defaults, so it never blocks boot).
  function loadAndApplySiteTheme() {
    return api("/site").then(function (res) {
      if (res.ok && res.data) {
        state.site = res.data;
        if (res.data.theme) applySiteTheme(res.data.theme);
        applySiteBranding(res.data.site);
      }
    }).catch(function () {});
  }
  function toHex(v) { v = String(v || "").trim(); return /^#[0-9a-fA-F]{6}$/.test(v) ? v : ""; }
  function safeUrl(u) { u = String(u || "").trim(); return /^https:\/\//i.test(u) ? u : ""; }
  // Image sources may also be media-library paths (/media/<key>), not just https URLs.
  function safeImageSrc(u) {
    u = String(u || "").trim();
    return /^\/media\/[a-z0-9]{1,40}\.(jpg|png|webp|gif)$/.test(u) ? u : safeUrl(u);
  }
  function safeMaxWidth(v) {
    v = String(v == null ? "" : v).trim();
    var m = v.match(/^((?:[0-9]{1,3}|1[0-9]{3}|2000))(px|%)$/);
    if (!m) return "";
    return String(Number(m[1])) + m[2];
  }
  // Embed blocks: only allow iframes to these well-known players (kept in sync with the
  // server's EMBED_HOSTS). toEmbedSrc normalizes a pasted watch/share URL to an embed src.
  var EMBED_HOSTS_C = ["youtube.com", "www.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com", "player.vimeo.com", "vimeo.com", "www.loom.com", "loom.com"];
  function safeEmbedUrl(u) {
    u = safeUrl(u);
    if (!u) return "";
    try { if (EMBED_HOSTS_C.indexOf(new URL(u).hostname.toLowerCase()) !== -1) return u; } catch (e) {}
    return "";
  }
  function toEmbedSrc(u) {
    u = safeEmbedUrl(u);
    if (!u) return "";
    try {
      var url = new URL(u), host = url.hostname.toLowerCase();
      if (host === "youtu.be") { var yid = url.pathname.replace(/^\//, ""); return yid ? "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(yid) : ""; }
      if (host.indexOf("youtube") !== -1 && host.indexOf("nocookie") === -1) { var v = url.searchParams.get("v") || url.pathname.split("/").pop(); return v ? "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(v) : ""; }
      if (host === "vimeo.com") { var vid = url.pathname.split("/").filter(Boolean).pop(); return /^\d+$/.test(vid || "") ? "https://player.vimeo.com/video/" + vid : ""; }
    } catch (e) {}
    return u;
  }

  /* ----------------------------- Editable site copy ("content slots") -----------------------------
   * Every previously hardcoded piece of user-facing text has a stable slot key. These
   * defaults ARE the original copy; the content_slots table stores only overrides (same
   * pattern as DEFAULT_THEME). Any DOM node carrying data-slot="key" is (re)hydrated by
   * applySiteContent(), and for a super admin gets an inline ✎ edit button. The same keys
   * are edited in bulk from the Appearance → Site content panel. */
  var CONTENT_DEFAULTS = {
    "brand.name": "PerformanceXtra",
    "brand.tag": "Mental Workout Repository",
    "hero.kicker": "Mental training, kept in motion",
    "hero.title": "One focused place for athlete check-ins, coach guidance, and mental performance work.",
    "hero.copy": "PerformanceXtra keeps workouts, reflections, check-ins, and coach communication together, so athletes always know the next step and coaches can support progress without chasing updates across tools.",
    "hero.role1": "Athletes: workouts, check-ins, messages",
    "hero.role2": "Coaches: assignments, tracking, support",
    "hero.role3": "Admins: team setup, content, operations",
    "hero.note_title": "Preview the library",
    "hero.note_copy": "Then sign in to open your workspace.",
    "guide.title": "Start in a few focused steps",
    "guide.meta": "Usually 1 to 2 minutes",
    "guide.step1_title": "Athletes sign in with the email and passcode their coach shared.",
    "guide.step1_copy": "Open your assigned workouts, send reflections, and check in without extra setup.",
    "guide.step2_title": "Coaches and staff sign in with their own account.",
    "guide.step2_copy": "If this is a brand-new workspace, create the first admin account once, then invite the rest of the team.",
    "guide.step3_title": "The first screen after sign-in is role-specific.",
    "guide.step3_copy": "Athletes land on current work, coaches land on roster workflows, and admins land on setup controls.",
    "moment.morning_label": "Morning reset",
    "moment.morning_copy": "Start the day with one clear assignment, one honest check-in, and one place to return later.",
    "moment.midday_label": "Midday focus",
    "moment.midday_copy": "Keep practice notes, reflections, and coach direction together while the session is still fresh.",
    "moment.evening_label": "Evening review",
    "moment.evening_copy": "Review today's work, send reflections, and leave coaches a cleaner picture of progress.",
    "preview.kicker": "Inside the library",
    "preview.title": "A small preview of the work athletes return to",
    "preview.copy": "These sample activities show the kind of work inside the full library. Filters, assignments, and role-specific tools appear after sign-in.",
    "repo.heading": "Activity Repository",
    "repo.intro": "Every mental-training activity in one place. Search and filter by topic, content type, and progression, then open the resource or expand it for instructions and reflection prompts.",
    "students.heading": "Students",
    "students.intro": "Set up each athlete, assign them a focused set of activities to work on, and track what they’ve completed. Pick the active student in the header to assign work or review their progress.",
    "content.heading": "Content",
    "content.intro": "Manage your activity library and the Topic, Subtopic, and Content-type lists used across the app. Changes save to your team database and take effect right away, with no developer needed.",
    "workouts.heading": "My Workouts",
    "workouts.intro": "These are the activities your coach has assigned for you. Work through them and mark each one done as you go.",
    "checkin.heading": "Daily check-in",
    "checkin.intro": "A quick, private moment to notice how you’re doing. There are no wrong answers. It simply helps you and your coach notice patterns over time.",
    "messages.heading": "Messages",
    "messages.intro": "A direct line to your coach. Ask a question, share a win, or let them know how you’re doing.",
    "progress.heading": "My Progress",
    "progress.intro": "See how much you’ve completed so far, broken down by topic and by week.",
    "settings.heading": "Settings",
    "settings.intro": "Account security and data transfer tools for this workspace. What you see here changes based on whether you are using the shared server or the device-only fallback.",
    "footer.text": "PerformanceXtra — Mental Workout Repository",
    "footer.tagline": "catalog items (and growing)",
    "nav.repo": "Repository", "nav.students": "Students", "nav.content": "Content",
    "nav.team": "Team", "nav.cms": "CMS", "nav.settings": "Settings",
    "nav.workouts": "My Workouts", "nav.checkin": "Check-in", "nav.messages": "Messages", "nav.progress": "My Progress",
    "banner.storage": "Browser storage is unavailable, so student progress can’t be saved on this device. Changes will be lost when you close the tab.",
    "banner.preview": "👀 Coach preview: you’re seeing the student view.",
    "banner.default_pass": "⚠️ You’re still using the default admin passcode. Anyone who knows it can open your coaching tools."
  };
  // Groups drive the Appearance → Site content panel layout (and inline-editor labels).
  var CONTENT_GROUPS = [
    { title: "Brand & header", keys: [["brand.name", "Brand name"], ["brand.tag", "Brand tagline"]] },
    { title: "Signed-out landing: hero", keys: [
      ["hero.kicker", "Kicker line"], ["hero.title", "Headline", true], ["hero.copy", "Intro paragraph", true],
      ["hero.role1", "Role line 1"], ["hero.role2", "Role line 2"], ["hero.role3", "Role line 3"],
      ["hero.note_title", "Note title"], ["hero.note_copy", "Note copy"]
    ] },
    { title: "Signed-out landing: training moment", keys: [
      ["moment.morning_label", "Morning label"], ["moment.morning_copy", "Morning copy", true],
      ["moment.midday_label", "Midday label"], ["moment.midday_copy", "Midday copy", true],
      ["moment.evening_label", "Evening label"], ["moment.evening_copy", "Evening copy", true]
    ] },
    { title: "Signed-out landing: start guide", keys: [
      ["guide.title", "Guide title"], ["guide.meta", "Time estimate"],
      ["guide.step1_title", "Step 1 title", true], ["guide.step1_copy", "Step 1 copy", true],
      ["guide.step2_title", "Step 2 title", true], ["guide.step2_copy", "Step 2 copy", true],
      ["guide.step3_title", "Step 3 title", true], ["guide.step3_copy", "Step 3 copy", true]
    ] },
    { title: "Signed-out landing: library preview", keys: [
      ["preview.kicker", "Kicker line"], ["preview.title", "Heading"], ["preview.copy", "Copy", true]
    ] },
    { title: "Section headings & intros", keys: [
      ["repo.heading", "Repository heading"], ["repo.intro", "Repository intro", true],
      ["students.heading", "Students heading"], ["students.intro", "Students intro", true],
      ["content.heading", "Content heading"], ["content.intro", "Content intro", true],
      ["workouts.heading", "My Workouts heading"], ["workouts.intro", "My Workouts intro", true],
      ["checkin.heading", "Check-in heading"], ["checkin.intro", "Check-in intro", true],
      ["messages.heading", "Messages heading"], ["messages.intro", "Messages intro", true],
      ["progress.heading", "My Progress heading"], ["progress.intro", "My Progress intro", true],
      ["settings.heading", "Settings heading"], ["settings.intro", "Settings intro", true]
    ] },
    { title: "Footer", keys: [["footer.text", "Footer text"], ["footer.tagline", "Catalog tagline"]] },
    { title: "Navigation labels", keys: [
      ["nav.repo", "Repository tab"], ["nav.students", "Students tab"], ["nav.content", "Content tab"],
      ["nav.team", "Team tab"], ["nav.cms", "CMS tab"], ["nav.settings", "Settings tab"],
      ["nav.workouts", "My Workouts tab"], ["nav.checkin", "Check-in tab"], ["nav.messages", "Messages tab"], ["nav.progress", "My Progress tab"]
    ] },
    { title: "Banners", keys: [
      ["banner.storage", "Storage-unavailable warning", true],
      ["banner.preview", "Coach-preview banner"],
      ["banner.default_pass", "Default-passcode warning", true]
    ] }
  ];
  function slotLabel(key) {
    for (var g = 0; g < CONTENT_GROUPS.length; g++) {
      var hit = CONTENT_GROUPS[g].keys.filter(function (k) { return k[0] === key; })[0];
      if (hit) return hit[1];
    }
    return key;
  }
  // Effective copy for a slot: super-admin override if one is saved, else the original.
  function slot(key) {
    var o = state.content && state.content[key];
    return (o != null && o !== "") ? o : (CONTENT_DEFAULTS[key] || "");
  }
  // Public endpoint; tolerant of a missing table (no overrides → original copy).
  function loadSiteContent() {
    return api("/content").then(function (res) {
      if (res.ok && res.data && res.data.content) state.content = res.data.content;
      applySiteContent();
    }).catch(function () {});
  }
  // Rehydrate every data-slot node from the current overrides. Text only (textContent),
  // so slot copy can never inject markup. Safe to call any time — nodes that don't exist
  // yet are picked up on the next call (boot, save, auth-gate build).
  function applySiteContent() {
    $all("[data-slot]").forEach(function (n) {
      var key = n.getAttribute("data-slot");
      if (CONTENT_DEFAULTS[key] != null) n.textContent = slot(key);
    });
    document.title = slot("brand.name") + " — " + slot("brand.tag");
    decorateSlotEditing();
  }
  // Inline editing: give each data-slot node a small ✎ button (super admin only).
  // Buttons are siblings, not children, so rehydrating textContent never eats them.
  function decorateSlotEditing() {
    $all(".slot-edit-btn").forEach(function (b) { b.remove(); });
    $all("[data-slot]").forEach(function (n) { n.classList.remove("slot-editable"); });
    if (!isSuperadmin()) return;
    $all("[data-slot]").forEach(function (n) {
      var key = n.getAttribute("data-slot");
      if (CONTENT_DEFAULTS[key] == null) return;
      if (key.indexOf("banner.") === 0) return;     // banners are often hidden — edit via the panel
      if (n.closest("#view-appearance")) return;   // the panel edits copy via its own form
      if (n.closest(".brand") || n.closest(".auth-head")) return;   // header brand is too tight for a button — edit via the panel
      n.classList.add("slot-editable");
      var btn = el("button", {
        class: "slot-edit-btn", type: "button",
        title: "Edit this text", "aria-label": "Edit: " + slotLabel(key),
        onclick: function (e) { e.preventDefault(); e.stopPropagation(); openSlotEditor(key); }
      }, "✎");
      n.insertAdjacentElement("afterend", btn);
    });
  }
  function openSlotEditor(key) {
    var long = (CONTENT_DEFAULTS[key] || "").length > 80;
    var input = long ? el("textarea", { rows: 4 }) : el("input", { type: "text" });
    input.value = slot(key);
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, slotLabel(key)), input]),
      el("p", { class: "field-hint" }, "Shown to everyone. Leave empty and save to restore the original text.")
    ]);
    openModal("Edit site copy", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Save", accent: true, onClick: function () {
        saveContentSlots([[key, input.value]], closeModal);
      } }
    ]);
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 40);
  }
  // Shared save path for the inline editor and the Site content panel. `pairs` is
  // [[key, value], ...]; an empty value clears the override (back to original copy).
  function saveContentSlots(pairs, onDone) {
    var payload = {};
    pairs.forEach(function (p) { payload[p[0]] = p[1]; });
    api("/content", { method: "POST", body: { content: payload } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't save site copy")); return; }
      state.content = (res.data && res.data.content) || {};
      applySiteContent();
      if (state.session) renderTabs();   // nav-label slots feed the tabs
      toast("Site copy saved");
      if (onDone) onDone();
    }).catch(function () { toast("Couldn't reach the server"); });
  }

  /* ----------------------------- CMS hub (WordPress-style admin) -----------------------------
   * The whole super-admin CMS lives in one "CMS" tab (#view-appearance) organized into
   * sections shown in a left sub-nav, instead of one long scroll. Each section carries a
   * `minRole` (the capability model): only super admins see the tab today, but when
   * multi-author editing lands we flip the tab to isAtLeastAdmin() and admins automatically
   * get just the sections they're allowed. `soon` marks a section whose feature is on the
   * roadmap; it renders a placeholder describing what's coming. */
  function cmsSectionList() {
    return [
      { id: "dashboard", label: "Dashboard", minRole: "admin", render: renderCmsDashboard },
      { id: "pages", label: "Pages", minRole: "admin", render: renderPageBuilder },
      { id: "design", label: "Design", minRole: "superadmin", render: renderThemeEditor },
      { id: "content", label: "Content", minRole: "admin", render: renderSiteContentEditor },
      { id: "media", label: "Media", minRole: "admin", render: renderMediaLibrary },
      { id: "menus", label: "Menus", minRole: "superadmin", render: renderMenus },
      { id: "checkin", label: "Check-in", minRole: "superadmin", render: renderCheckinConfig },
      { id: "users", label: "Users", minRole: "superadmin", render: renderCmsUsers },
      { id: "settings", label: "Settings", minRole: "superadmin", render: renderSettings },
      { id: "access", label: "Access", minRole: "superadmin", render: renderAccess }
    ];
  }
  function cmsAccess() { return (state.site && state.site.access) || {}; }
  // Workspace mode: solo=true hides the multi-coach machinery (Team tab, staff
  // creation) because one super admin runs the whole program. Purely a UI switch —
  // no permission changes — so it's always safe to flip back.
  function soloMode() { return !!(state.site && state.site.mode && state.site.mode.solo); }
  function canEditCms(area) { return isSuperadmin() || !!cmsAccess()[area]; }
  function adminCmsAccess() { var a = cmsAccess(); return !!(a.pages || a.content || a.media); }
  function visibleCmsSections() {
    var acc = cmsAccess();
    return cmsSectionList().filter(function (s) {
      if (!isAtLeast(s.minRole)) return false;
      if (isSuperadmin()) return true;
      // Admins see only the areas a super admin granted (Dashboard if any are granted).
      if (s.id === "pages" || s.id === "content" || s.id === "media") return !!acc[s.id];
      if (s.id === "dashboard") return !!(acc.pages || acc.content || acc.media);
      return false;   // Design/Menus/Check-in/Settings/Access stay super-admin only
    });
  }
  function sectionDef(id) {
    var all = cmsSectionList();
    return all.filter(function (s) { return s.id === id; })[0] || all[0];
  }
  // The active section, normalized to one the current role may actually see.
  function cmsSection() {
    var vis = visibleCmsSections().map(function (s) { return s.id; });
    var cur = state.cmsSection || "dashboard";
    return vis.indexOf(cur) === -1 ? (vis[0] || "dashboard") : cur;
  }
  function setCmsSection(id) {
    state.cmsSection = id;
    var h = "#cms/" + id;
    if (location.hash !== h) history.replaceState(null, "", h);
    renderAppearance();
  }
  // Which data each section needs (lazy — a section never blocks on data it doesn't use).
  function cmsNeedsPages(section) { return section === "pages" || section === "dashboard" || section === "menus"; }
  function cmsDataReady(section) {
    if (!state.site) return false;
    if (cmsNeedsPages(section) && !state.pages) return false;
    if ((section === "media" || section === "dashboard") && state.media == null) return false;
    return true;
  }
  function ensureCmsData(section) {
    var jobs = [];
    if (!state.site) jobs.push(api("/site").then(function (r) {
      state.site = (r && r.data && r.data.theme) ? r.data : { theme: Object.assign({}, DEFAULT_THEME_C), site: {} };
    }).catch(function () { state.site = state.site || { theme: Object.assign({}, DEFAULT_THEME_C), site: {} }; }));
    if (cmsNeedsPages(section) && !state.pages) jobs.push(api("/pages").then(function (r) {
      state.pages = (r && r.data && r.data.pages) ? r.data.pages : [];
    }).catch(function () { state.pages = state.pages || []; }));
    if ((section === "media" || section === "dashboard") && state.media == null) jobs.push(loadMediaList());
    return jobs.length ? Promise.all(jobs) : Promise.resolve();
  }
  function renderAppearance() {
    var view = $("#view-appearance");
    if (!view) return;
    var section = cmsSection();
    if (!cmsDataReady(section)) {
      view.textContent = "";
      view.appendChild(el("p", { class: "field-hint" }, "Loading…"));
      ensureCmsData(section).then(function () {
        if (state.tab === "appearance") paintCmsHub(view, cmsSection());
      });
      return;
    }
    paintCmsHub(view, section);
  }
  function paintCmsHub(view, section) {
    view.textContent = "";
    view.appendChild(el("div", { class: "view-intro" }, [
      el("h2", {}, "CMS"),
      el("p", {}, "Manage your whole site from one place — pages, design, content and media. Changes save to the database and apply to everyone.")
    ]));
    var nav = el("nav", { class: "cms-nav", "aria-label": "CMS sections" });
    visibleCmsSections().forEach(function (s) {
      nav.appendChild(el("button", {
        class: "cms-nav-item" + (s.id === section ? " is-active" : ""),
        type: "button",
        "aria-current": s.id === section ? "page" : null,
        onclick: function () { if (s.id !== cmsSection()) setCmsSection(s.id); }
      }, [
        el("span", { class: "cms-nav-label" }, s.label),
        s.soon ? el("span", { class: "cms-nav-soon" }, "soon") : null
      ]));
    });
    var def = sectionDef(section);
    var body = el("div", { class: "cms-hub-body" }, [def.soon ? renderCmsSoon(def) : def.render()]);
    view.appendChild(el("div", { class: "cms-hub" }, [nav, body]));
  }
  function renderCmsSoon(def) {
    var panel = el("div", { class: "panel cms-soon" });
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, def.label),
      el("span", { class: "chip" }, "Coming soon")
    ]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin-top:4px" }, def.soon));
    return panel;
  }
  function dashCard(label, value, sub, onClick) {
    return el("button", { class: "cms-dash-card", type: "button", onclick: onClick }, [
      el("div", { class: "cms-dash-value" }, String(value)),
      el("div", { class: "cms-dash-label" }, label),
      el("div", { class: "cms-dash-sub" }, sub)
    ]);
  }
  function renderCmsDashboard() {
    var wrap = el("div", { class: "cms-dash" });
    var pages = state.pages || [];
    var pub = pages.filter(function (p) { return (p.status || (p.published ? "published" : "draft")) === "published"; }).length;
    var mediaCount = (state.media || []).length;
    var theme = (state.site && state.site.theme) || {};
    wrap.appendChild(el("div", { class: "cms-dash-grid" }, [
      dashCard("Pages", pages.length, pub + " published · " + (pages.length - pub) + " draft", function () { setCmsSection("pages"); }),
      dashCard("Media", mediaCount, mediaCount === 1 ? "image" : "images", function () { setCmsSection("media"); }),
      dashCard("Accent", toHex(theme.accent) || "—", "theme color", function () { setCmsSection("design"); })
    ]));

    var actions = el("div", { class: "panel" });
    actions.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Quick actions")]));
    actions.appendChild(el("div", { class: "cms-actions" }, [
      el("button", { class: "btn btn--sm btn--accent", onclick: function () { state.pageDraft = null; setCmsSection("pages"); setTimeout(openNewPageModal, 0); } }, "+ New page"),
      el("button", { class: "btn btn--sm", onclick: function () { setCmsSection("design"); } }, "Edit design"),
      el("button", { class: "btn btn--sm", onclick: function () { setCmsSection("content"); } }, "Edit site copy"),
      el("button", { class: "btn btn--sm", onclick: function () { setCmsSection("media"); } }, "Upload media")
    ]));
    wrap.appendChild(actions);

    var recent = el("div", { class: "panel" });
    recent.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Your pages"),
      el("button", { class: "btn btn--sm", onclick: function () { setCmsSection("pages"); } }, "All pages →")
    ]));
    if (!pages.length) {
      recent.appendChild(el("p", { class: "no-link" }, "No pages yet. Create your first one from Pages."));
    } else {
      var list = el("div", { class: "builder-canvas" });
      pages.slice(0, 6).forEach(function (p) {
        var isPub = (p.status || (p.published ? "published" : "draft")) === "published";
        list.appendChild(el("div", { class: "builder-block" }, [
          el("div", { class: "builder-block-head" }, [
            el("span", { class: "chip " + (isPub ? "chip--accent" : "") }, isPub ? "published" : "draft"),
            el("span", { class: "builder-block-summary" }, [el("strong", {}, p.title || p.id), " · #/p/" + p.id])
          ]),
          el("div", { class: "cms-actions" }, [
            el("button", { class: "btn btn--sm", onclick: function () { setCmsSection("pages"); setTimeout(function () { openPageDraft(p); }, 0); } }, "Edit")
          ])
        ]));
      });
      recent.appendChild(list);
    }
    wrap.appendChild(recent);
    return wrap;
  }

  /* ----------------------------- CMS: navigation menu ----------------------------- */
  function renderMenus() {
    var pages = (state.pages || []).filter(function (p) { return (p.status || (p.published ? "published" : "draft")) === "published"; });
    var items = ((((state.site || {}).menus) || {}).items || []).map(function (it) { return Object.assign({}, it); });
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Navigation menu")]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Control which pages appear in the top navigation and in what order. Leave this empty to auto-show every published page that has a nav label (the default). Add a custom link to point at any https:// address."));
    var list = el("div", { class: "builder-canvas" });
    function swap(i, j) { var t = items[i]; items[i] = items[j]; items[j] = t; redraw(); }
    function redraw() {
      list.textContent = "";
      if (!items.length) list.appendChild(el("p", { class: "no-link" }, "No menu items — navigation is auto-derived from published pages. Add an item to take manual control."));
      items.forEach(function (it, idx) {
        var label = el("input", { type: "text", value: it.label || "", placeholder: it.type === "link" ? "Link label" : "Nav label (defaults to the page's)" });
        label.addEventListener("input", function () { it.label = label.value; });
        var target;
        if (it.type === "link") {
          target = el("input", { type: "text", value: it.href || "", placeholder: "https://…" });
          target.addEventListener("input", function () { it.href = target.value; });
        } else {
          target = el("select", {});
          if (!pages.length) target.appendChild(el("option", { value: "" }, "(no published pages yet)"));
          pages.forEach(function (p) { var op = el("option", { value: p.id }, (p.title || p.id) + " (#/p/" + p.id + ")"); if (it.pageId === p.id) op.selected = true; target.appendChild(op); });
          if (!it.pageId && pages.length) it.pageId = pages[0].id;
          target.addEventListener("change", function () { it.pageId = target.value; });
        }
        list.appendChild(el("div", { class: "menu-row" }, [
          el("span", { class: "chip" }, it.type === "link" ? "link" : "page"),
          el("div", { class: "menu-row-fields" }, [label, target]),
          el("div", { class: "cms-actions" }, [
            el("button", { class: "btn btn--sm btn--ghost", disabled: idx === 0, onclick: function () { swap(idx, idx - 1); } }, "↑"),
            el("button", { class: "btn btn--sm btn--ghost", disabled: idx === items.length - 1, onclick: function () { swap(idx, idx + 1); } }, "↓"),
            el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { items.splice(idx, 1); redraw(); } }, "×")
          ])
        ]));
      });
    }
    redraw();
    panel.appendChild(list);
    panel.appendChild(el("div", { class: "builder-palette", style: "margin-top:12px" }, [
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () { items.push({ type: "page", pageId: pages.length ? pages[0].id : "", label: "" }); redraw(); } }, "+ Add page"),
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () { items.push({ type: "link", href: "", label: "" }); redraw(); } }, "+ Add link")
    ]));
    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { menus: { items: items } } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save menu")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          loadNavPages().then(function () { if (state.session) renderTabs(); });
          renderAppearance();
          toast("Menu saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save menu")
    ]));
    return panel;
  }

  /* ----------------------------- CMS: settings ----------------------------- */
  function renderSettings() {
    var wrap = el("div", { class: "cms-design" });
    var brand = el("div", { class: "panel" });
    brand.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Brand identity")]));
    brand.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" }, "The site name and tagline shown in the header and browser tab. Colors, fonts, logo and favicon live in Design."));
    var nameI = el("input", { type: "text", value: slot("brand.name") });
    var tagI = el("input", { type: "text", value: slot("brand.tag") });
    brand.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Site name"), nameI]),
      el("div", { class: "field" }, [el("label", {}, "Tagline"), tagI])
    ]));
    brand.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        saveContentSlots([["brand.name", nameI.value], ["brand.tag", tagI.value]]);
      } }, "Save brand")
    ]));
    wrap.appendChild(brand);

    // Workspace mode — solo hides the Team tab and staff creation for a program run
    // entirely by the super admin. UI-only: no permissions change, existing coach and
    // admin accounts keep working, and unticking restores everything.
    var modePanel = el("div", { class: "panel" });
    modePanel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Workspace mode")]));
    var soloCb = el("input", { type: "checkbox" });
    soloCb.checked = soloMode();
    modePanel.appendChild(el("label", { class: "access-row" }, [
      soloCb,
      el("div", {}, [
        el("div", { class: "access-row-title" }, "Solo mode — I run the whole program myself"),
        el("div", { class: "field-hint" }, "Hides the Team tab and staff creation; you create students and assign all work as the super admin. Nothing is deleted — untick to bring the multi-coach tools back.")
      ])
    ]));
    modePanel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { mode: { solo: soloCb.checked } } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save workspace mode")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          renderTabs(); renderAppearance();
          toast(soloMode() ? "Solo mode on — Team tab hidden" : "Solo mode off — Team tab restored");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save workspace mode")
    ]));
    wrap.appendChild(modePanel);

    var info = el("div", { class: "panel" });
    info.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Workspace")]));
    function infoRow(label, value) { return el("div", { class: "setting-row" }, [el("span", { class: "detail-label" }, label), el("span", {}, value)]); }
    info.appendChild(el("div", { class: "form-stack" }, [
      infoRow("Signed in as", (state.session && state.session.name) || "—"),
      infoRow("Pages", String((state.pages || []).length)),
      infoRow("Media", ((state.media || []).length) + " image" + ((state.media || []).length === 1 ? "" : "s"))
    ]));
    wrap.appendChild(info);
    return wrap;
  }

  /* ----------------------------- CMS: users (all accounts) ----------------------------- */
  // WordPress-style Users screen: every account — students and staff — in one searchable
  // list. Actions reuse the same flows as the Students and Team tabs (reset code, move,
  // delete); Edit is new here and fixes name/email typos in place via PATCH /users/:id.
  function renderCmsUsers() {
    var wrap = el("div", { class: "cms-design" });
    var panel = el("div", { class: "panel" });
    var searchI = el("input", { type: "search", placeholder: "Search by name, email, coach or role…", "aria-label": "Search users" });
    var countEl = el("span", { class: "cms-count" }, "");
    var listBox = el("div", { class: "student-list" });

    var headActions = [countEl, el("button", { class: "btn btn--sm btn--primary", onclick: function () { openAddAthleteModal(); } }, "+ Add student")];
    if (!soloMode()) headActions.push(el("button", { class: "btn btn--sm", onclick: function () { openAddStaffModal("coach"); } }, "+ Add coach"));
    panel.appendChild(el("div", { class: "section-head section-head--stacked" }, [
      el("div", { class: "section-head-copy" }, [
        el("h3", {}, "Users"),
        el("p", { class: "section-head-note" }, "Everyone with an account, in one place. Fix a name or email, hand out a fresh sign-in code, move a student, or remove an account.")
      ]),
      el("div", { class: "section-head-actions" }, headActions)
    ]));
    panel.appendChild(el("div", { class: "field", style: "margin: 4px 0 12px" }, [searchI]));
    panel.appendChild(listBox);
    wrap.appendChild(panel);

    function accountRows() {
      var rows = [];
      (state.allStudents || []).forEach(function (s) {
        rows.push({ tier: "student", label: "Student", data: s, meta: s.coachName ? ("Coach: " + s.coachName) : "" });
      });
      (state.coaches || []).forEach(function (c) {
        rows.push({ tier: "coach", label: "Coach", data: c, meta: (c.studentCount || 0) + " student" + (c.studentCount === 1 ? "" : "s") });
      });
      (state.admins || []).forEach(function (c) { rows.push({ tier: "admin", label: "Admin", data: c, meta: "" }); });
      (state.superadmins || []).forEach(function (c) { rows.push({ tier: "superadmin", label: "Super admin", data: c, meta: "" }); });
      return rows;
    }

    function paint() {
      var q = norm(searchI.value).trim();
      var rows = accountRows();
      var total = rows.length;
      if (q) rows = rows.filter(function (r) {
        return norm(r.data.name).indexOf(q) >= 0 || norm(r.data.email || "").indexOf(q) >= 0
          || norm(r.meta).indexOf(q) >= 0 || norm(r.label).indexOf(q) >= 0;
      });
      countEl.textContent = total ? (rows.length + " of " + total + " account" + (total === 1 ? "" : "s")) : "";
      listBox.textContent = "";
      if (state.allStudents == null) { listBox.appendChild(el("p", { class: "no-link" }, "Loading students…")); return; }
      if (!rows.length) { listBox.appendChild(el("p", { class: "no-link" }, total ? "No accounts match." : "No accounts yet.")); return; }
      rows.forEach(function (r) {
        var u = r.data;
        var nameKids = [
          el("span", { class: "name" }, u.name),
          el("span", { class: "chip", title: "Account role" }, r.label)
        ];
        if (u.email) nameKids.push(el("span", { class: "student-email", title: "Signs in with this email" }, u.email));
        if (r.meta) nameKids.push(el("span", { class: "dupe-coach" }, r.meta));
        var row = el("div", { class: "student-row" }, [el("span", { class: "name-wrap" }, nameKids)]);
        var actions = el("div", { class: "student-row-actions" });
        actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Edit name or email", onclick: function () { openEditUserModal(u, r.tier); } }, "✎ Edit"));
        if (r.tier === "student") {
          actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new sign-in code", onclick: function () { resetPasscode(u); } }, "↻ Reset sign-in code"));
          actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Move this student to a different coach", onclick: function () { openReassignStudent(u); } }, "Move…"));
          actions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this student and all their data", onclick: function () { deleteAllStudent(u); } }, "✕ Delete"));
        } else {
          actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Generate a new sign-in code", onclick: function () { resetStaffPasscode(u, r.tier); } }, "↻ Reset sign-in code"));
          // Same rules as the Team tab: super admins are never deletable, nor is your own account.
          if (r.tier !== "superadmin" && u.id !== (state.session && state.session.id)) {
            actions.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete this " + r.tier, onclick: function () { deleteStaff(u, r.tier); } }, "✕ Delete"));
          }
        }
        row.appendChild(actions);
        listBox.appendChild(row);
      });
    }

    if (state.allStudents == null) {
      api("/all-athletes").then(function (res) {
        state.allStudents = (res.ok && res.data && res.data.athletes) || [];
        paint();
      }).catch(function () {
        listBox.textContent = "";
        listBox.appendChild(el("p", { class: "no-link" }, "Couldn't load students."));
      });
    }
    searchI.addEventListener("input", paint);
    paint();
    return wrap;
  }

  // Edit an account's name/email in place (super admin only; PATCH /users/:id). An email
  // change signs the account's other sessions out — the modal says so up front.
  function openEditUserModal(u, tier) {
    var nameI = el("input", { type: "text", value: u.name || "" });
    var emailI = el("input", { type: "email", value: u.email || "", autocomplete: "off" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "Changes apply immediately. If you change the email, they'll sign in with the new address (their password or sign-in code stays the same) and any open sessions are signed out."),
      el("div", { class: "field" }, [el("label", {}, "Name"), nameI]),
      el("div", { class: "field" }, [el("label", {}, "Email"), emailI]),
      errBox
    ]);
    function submit() {
      errBox.hidden = true;
      var nm = nameI.value.trim(), em = emailI.value.trim();
      if (!nm || !em) { errBox.textContent = "Name and email are both required."; errBox.hidden = false; return; }
      var payload = {};
      if (nm !== (u.name || "")) payload.name = nm;
      if (em.toLowerCase() !== (u.email || "").toLowerCase()) payload.email = em;
      if (!Object.keys(payload).length) { closeModal(); return; }
      api("/users/" + encodeURIComponent(u.id), { method: "PATCH", body: payload }).then(function (res) {
        if (!res.ok) { errBox.textContent = apiError(res, "Couldn't save changes."); errBox.hidden = false; return; }
        closeModal();
        toast("Saved " + (res.data && res.data.user ? res.data.user.name : nm));
        state.allStudents = null;
        refreshFromServer().then(function () { renderAll(); });
        refreshStaff();
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    openModal("Edit " + (tier === "student" ? "student" : tier), body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Save changes", accent: true, onClick: submit }
    ]);
    setTimeout(function () { nameI.focus(); }, 30);
  }

  /* ----------------------------- CMS: access (multi-author roles) ----------------------------- */
  function renderAccess() {
    var acc = Object.assign({ pages: false, content: false, media: false }, cmsAccess());
    var wrap = el("div", { class: "cms-design" });
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Editing access")]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Super admins can always edit everything. Grant admins access to specific CMS areas below — they'll get a CMS tab with just those areas. Coaches never get the CMS. Design, Menus, Check-in, Settings and this page stay super-admin only."));
    [["pages", "Pages", "Create and edit builder pages, and edit the site pages' text."],
     ["content", "Content", "Edit all site copy — headings, intros and labels."],
     ["media", "Media", "Upload and manage images."]].forEach(function (row) {
      var cb = el("input", { type: "checkbox" }); cb.checked = !!acc[row[0]];
      cb.addEventListener("change", function () { acc[row[0]] = cb.checked; });
      panel.appendChild(el("label", { class: "access-row" }, [
        cb, el("div", {}, [el("div", { class: "access-row-title" }, "Admins can edit " + row[1]), el("div", { class: "field-hint" }, row[2])])
      ]));
    });
    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { access: acc } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save access")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          renderAppearance(); toast("Access saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save access")
    ]));
    wrap.appendChild(panel);

    var matrix = el("div", { class: "panel" });
    matrix.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "What each role can do")]));
    var ml = el("div", { class: "form-stack" });
    [["Super admin", "Everything — pages, design, content, media, menus, check-in, settings, access, plus managing admins and the global library."],
     ["Admin", "Manage coaches and the global library. CMS editing only in the areas granted above."],
     ["Coach", "Their own athletes and private content. No CMS access."]].forEach(function (r) {
      ml.appendChild(el("div", { class: "setting-row" }, [el("span", { class: "detail-label" }, r[0]), el("span", {}, r[1])]));
    });
    matrix.appendChild(ml);
    wrap.appendChild(matrix);
    return wrap;
  }

  /* ----------------------------- CMS: check-in configuration ----------------------------- */
  function renderCheckinConfig() {
    var cfg = { dimensions: checkinConfig().dimensions.map(function (d) { return Object.assign({}, d); }) };
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Daily check-in")]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Configure what athletes report each day. Rename a dimension, change its scale range and end labels, add your own, or turn one off. Turn on “Higher is worse” for things like Stress (it flips the warm color and the coach warning). Renaming keeps old check-ins; a dimension's key is fixed once created, to preserve history."));
    var list = el("div", { class: "builder-canvas" });
    function swap(i, j) { var t = cfg.dimensions[i]; cfg.dimensions[i] = cfg.dimensions[j]; cfg.dimensions[j] = t; redraw(); }
    function redraw() {
      list.textContent = "";
      if (!cfg.dimensions.length) list.appendChild(el("p", { class: "no-link" }, "No dimensions — the built-in default (Mood, Energy, Stress) will be used until you add one."));
      cfg.dimensions.forEach(function (d, idx) {
        var labelI = el("input", { type: "text", value: d.label || "" }); labelI.addEventListener("input", function () { d.label = labelI.value; });
        var lowI = el("input", { type: "text", value: d.low || "", placeholder: "e.g. Tough" }); lowI.addEventListener("input", function () { d.low = lowI.value; });
        var highI = el("input", { type: "text", value: d.high || "", placeholder: "e.g. Great" }); highI.addEventListener("input", function () { d.high = highI.value; });
        var minI = el("input", { type: "number", value: d.min, min: "1", max: "9" }); minI.addEventListener("input", function () { d.min = parseInt(minI.value, 10); });
        var maxI = el("input", { type: "number", value: d.max, min: "2", max: "10" }); maxI.addEventListener("input", function () { d.max = parseInt(maxI.value, 10); });
        var activeI = el("input", { type: "checkbox" }); activeI.checked = d.active !== false; activeI.addEventListener("change", function () { d.active = activeI.checked; });
        var invertI = el("input", { type: "checkbox" }); invertI.checked = !!d.invert; invertI.addEventListener("change", function () { d.invert = invertI.checked; });
        list.appendChild(el("div", { class: "checkin-cfg-row" }, [
          el("div", { class: "checkin-cfg-head" }, [
            el("span", { class: "chip" }, d.key),
            el("div", { class: "cms-actions" }, [
              el("button", { class: "btn btn--sm btn--ghost", disabled: idx === 0, onclick: function () { swap(idx, idx - 1); } }, "↑"),
              el("button", { class: "btn btn--sm btn--ghost", disabled: idx === cfg.dimensions.length - 1, onclick: function () { swap(idx, idx + 1); } }, "↓"),
              el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { cfg.dimensions.splice(idx, 1); redraw(); } }, "Remove")
            ])
          ]),
          el("div", { class: "field" }, [el("label", {}, "Label"), labelI]),
          el("div", { class: "appearance-grid" }, [
            el("label", { class: "appearance-field" }, [el("span", {}, "Low-end label"), lowI]),
            el("label", { class: "appearance-field" }, [el("span", {}, "High-end label"), highI]),
            el("label", { class: "appearance-field" }, [el("span", {}, "Min"), minI]),
            el("label", { class: "appearance-field" }, [el("span", {}, "Max"), maxI])
          ]),
          el("div", { class: "checkin-cfg-flags" }, [
            el("label", { class: "check" }, [activeI, el("span", {}, " Active")]),
            el("label", { class: "check" }, [invertI, el("span", {}, " Higher is worse")])
          ])
        ]));
      });
    }
    redraw();
    panel.appendChild(list);
    panel.appendChild(el("div", { class: "builder-palette", style: "margin-top:12px" }, [
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
        cfg.dimensions.push({ key: "dim" + (cfg.dimensions.length + 1) + "_" + Math.random().toString(36).slice(2, 5), label: "New dimension", low: "Low", high: "High", min: 1, max: 5, active: true, invert: false });
        redraw();
      } }, "+ Add dimension")
    ]));
    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () { cfg = { dimensions: DEFAULT_CHECKIN_C.dimensions.map(function (d) { return Object.assign({}, d); }) }; redraw(); } }, "Reset to default"),
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { checkin: cfg } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save check-in")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          renderAppearance();
          toast("Check-in configuration saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save check-in")
    ]));
    return panel;
  }

  /* ----------------------------- Appearance: site content panel -----------------------------
   * Bulk editor for every content slot, grouped by page area. Fields start at the
   * effective copy; clearing a field restores the original. Only changed keys are sent. */
  function renderSiteContentEditor() {
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Site content"),
      el("span", { class: "cms-count" }, "All editable copy")
    ]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Every heading, intro and label below is live site copy. Edit and save to change it for everyone; clear a field and save to restore the original wording. You can also edit any of these in place — look for the ✎ button next to the text on each page."));
    var dirty = {};   // key -> new value (only fields the user touched)
    CONTENT_GROUPS.forEach(function (group) {
      var body = el("div", { class: "form-stack" });
      group.keys.forEach(function (def) {
        var key = def[0], label = def[1], multiline = !!def[2];
        var input = multiline ? el("textarea", { rows: 3 }) : el("input", { type: "text" });
        input.value = slot(key);
        input.addEventListener("input", function () { dirty[key] = input.value; });
        var hint = (state.content && state.content[key] != null)
          ? el("span", { class: "slot-flag", title: "This copy has been customized" }, "edited")
          : null;
        body.appendChild(el("div", { class: "field" }, [el("label", {}, hint ? [label + " ", hint] : label), input]));
      });
      var det = el("details", { class: "content-group" }, [
        el("summary", {}, group.title),
        body
      ]);
      panel.appendChild(det);
    });
    panel.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        var pairs = Object.keys(dirty).map(function (k) { return [k, dirty[k]]; });
        if (!pairs.length) { toast("Nothing changed yet"); return; }
        saveContentSlots(pairs, function () { renderAppearance(); });
      } }, "Save site content")
    ]));
    return panel;
  }

  // The "Design" CMS section: brand (logo/favicon), colors, typography + type scale (the
  // "scaler"), and dimensions (spacing/radius) — every control previews live and only
  // persists on Save. Theme tokens map 1:1 to CSS variables (THEME_VAR_MAP); scaleRatio is
  // derived into --text-* steps by applySiteTheme. Logo/favicon live in site_settings.site.
  function renderThemeEditor() {
    var theme = Object.assign({}, DEFAULT_THEME_C, (state.site && state.site.theme) || {});
    var siteCfg = Object.assign({}, (state.site && state.site.site) || {});
    var wrap = el("div", { class: "cms-design" });
    function addHead(panel, title, hint) {
      panel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, title)]));
      if (hint) panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" }, hint));
    }

    /* ---- Brand: logo + favicon ---- */
    var brand = el("div", { class: "panel" });
    addHead(brand, "Brand", "Upload a logo for the header and a favicon for the browser tab. Leave empty to use the built-in “PX” mark.");
    function imagePickerRow(key, label, hint) {
      var thumb = el("div", { class: "brand-pick-thumb" });
      function drawThumb() {
        thumb.textContent = "";
        var url = safeImageSrc(siteCfg[key]);
        thumb.appendChild(url ? el("img", { src: url, alt: "" }) : el("span", { class: "no-link" }, "None"));
      }
      drawThumb();
      return el("div", { class: "brand-pick" }, [
        thumb,
        el("div", { class: "brand-pick-main" }, [
          el("div", { class: "detail-label" }, label),
          hint ? el("p", { class: "field-hint" }, hint) : null,
          el("div", { class: "cms-actions" }, [
            el("button", { class: "btn btn--sm", type: "button", onclick: function () {
              openMediaPicker(function (m) { siteCfg[key] = "/" + m.key; drawThumb(); applySiteBranding(siteCfg); });
            } }, "Choose image"),
            el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () {
              siteCfg[key] = ""; drawThumb(); applySiteBranding(siteCfg);
            } }, "Remove")
          ])
        ])
      ]);
    }
    brand.appendChild(imagePickerRow("logoUrl", "Logo", "Shown top-left in the header. A wide image with a transparent background works best."));
    brand.appendChild(imagePickerRow("faviconUrl", "Favicon", "The small icon in the browser tab. A square image is best."));
    wrap.appendChild(brand);

    /* ---- Colors ---- */
    var colorsPanel = el("div", { class: "panel" });
    addHead(colorsPanel, "Colors");
    var COLORS = [["accent", "Accent"], ["ember", "Secondary accent"], ["bg", "Background"], ["surface", "Surface / cards"], ["ink", "Text"], ["danger", "Danger"], ["warn", "Warning"]];
    var colorGrid = el("div", { class: "appearance-grid" });
    COLORS.forEach(function (pair) {
      var input = el("input", { type: "color", value: toHex(theme[pair[0]]) || "#000000" });
      input.addEventListener("input", function () { theme[pair[0]] = input.value; applySiteTheme(theme); });
      colorGrid.appendChild(el("label", { class: "appearance-field" }, [el("span", {}, pair[1]), input]));
    });
    colorsPanel.appendChild(colorGrid);
    wrap.appendChild(colorsPanel);

    /* ---- Typography + type scale (the "scaler") ---- */
    var typePanel = el("div", { class: "panel" });
    addHead(typePanel, "Typography", "Choose fonts and set the type scale — a base text size and the ratio between each step.");
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
      sel.addEventListener("change", function () { theme[key] = sel.value; applySiteTheme(theme); drawScale(); });
      return el("label", { class: "appearance-field" }, [el("span", {}, label), sel]);
    }
    var scalePreview = el("div", { class: "type-scale-preview" });
    function drawScale() {
      var base = 16 * (parseFloat(theme.fontScale) || 1);
      var ratio = parseFloat(theme.scaleRatio) || 1.25;
      scalePreview.textContent = "";
      [["Display", 4], ["Heading 1", 3], ["Heading 2", 2], ["Heading 3", 1], ["Body", 0], ["Small", -1]].forEach(function (row) {
        var px = base * Math.pow(ratio, row[1]);
        scalePreview.appendChild(el("div", { class: "type-scale-row", style: "font-size:" + px.toFixed(1) + "px" }, [
          el("span", {}, row[0]),
          el("span", { class: "type-scale-size" }, px.toFixed(0) + "px")
        ]));
      });
    }
    var sizeOut = el("span", { class: "appearance-val" }, Math.round(16 * (parseFloat(theme.fontScale) || 1)) + "px");
    var sizeInput = el("input", { type: "range", min: 0.8, max: 1.4, step: 0.05, value: parseFloat(theme.fontScale) || 1 });
    sizeInput.addEventListener("input", function () {
      theme.fontScale = sizeInput.value;
      sizeOut.textContent = Math.round(16 * parseFloat(sizeInput.value)) + "px";
      applySiteTheme(theme); drawScale();
    });
    var ratioSel = el("select", {});
    [["1.125", "Compact (1.125)"], ["1.2", "Reduced (1.2)"], ["1.25", "Balanced (1.25)"], ["1.333", "Bold (1.333)"], ["1.5", "Dramatic (1.5)"]].forEach(function (o) {
      var op = el("option", { value: o[0] }, o[1]);
      if (String(parseFloat(theme.scaleRatio)) === String(parseFloat(o[0]))) op.selected = true;
      ratioSel.appendChild(op);
    });
    ratioSel.addEventListener("change", function () { theme.scaleRatio = ratioSel.value; applySiteTheme(theme); drawScale(); });
    typePanel.appendChild(el("div", { class: "appearance-grid" }, [fontSelect("fontBody", "Body font"), fontSelect("fontDisplay", "Heading font")]));
    typePanel.appendChild(el("div", { class: "appearance-grid" }, [
      el("label", { class: "appearance-field" }, [el("span", {}, "Base text size"), el("div", { class: "appearance-slider" }, [sizeInput, sizeOut])]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Scale ratio"), ratioSel])
    ]));
    drawScale();
    typePanel.appendChild(el("div", { class: "field" }, [el("label", {}, "Type scale preview"), scalePreview]));
    wrap.appendChild(typePanel);

    /* ---- Dimensions: radius + spacing ---- */
    var dimPanel = el("div", { class: "panel" });
    addHead(dimPanel, "Dimensions", "Corner rounding and the base spacing unit used across the app.");
    var dimPreview = el("div", { class: "dim-preview" });
    function drawDim() {
      var rad = parseFloat(theme.radius) || 0, sp = parseFloat(theme.space) || 0;
      dimPreview.textContent = "";
      dimPreview.appendChild(el("div", { class: "dim-swatch", style: "border-radius:" + rad + "px" }, "radius " + rad + "px"));
      dimPreview.appendChild(el("div", { class: "dim-gap", style: "gap:" + sp + "px" }, [el("span", {}), el("span", {}), el("span", {})]));
    }
    function dimSlider(key, label, min, max) {
      var cur = parseFloat(theme[key]); if (isNaN(cur)) cur = parseFloat(DEFAULT_THEME_C[key]) || 0;
      var out = el("span", { class: "appearance-val" }, cur + "px");
      var input = el("input", { type: "range", min: min, max: max, step: 1, value: cur });
      input.addEventListener("input", function () { theme[key] = input.value + "px"; out.textContent = input.value + "px"; applySiteTheme(theme); drawDim(); });
      return el("label", { class: "appearance-field" }, [el("span", {}, label), el("div", { class: "appearance-slider" }, [input, out])]);
    }
    dimPanel.appendChild(el("div", { class: "appearance-grid" }, [dimSlider("radius", "Corner radius", 0, 28), dimSlider("space", "Spacing", 8, 28)]));
    drawDim();
    dimPanel.appendChild(el("div", { class: "field" }, [el("label", {}, "Preview"), dimPreview]));
    wrap.appendChild(dimPanel);

    /* ---- Actions ---- */
    wrap.appendChild(el("div", { class: "appearance-actions" }, [
      el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
        applySiteTheme(DEFAULT_THEME_C);
        if (state.site) state.site.theme = Object.assign({}, DEFAULT_THEME_C);
        renderAppearance();
      } }, "Reset theme"),
      el("button", { class: "btn btn--sm btn--primary", onclick: function () {
        api("/site", { method: "POST", body: { theme: theme, site: siteCfg } }).then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't save")); return; }
          if (res.data && res.data.site) state.site = res.data.site;
          applySiteTheme(state.site.theme); applySiteBranding(state.site.site); toast("Design saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }, "Save design")
    ]));
    return wrap;
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
    else if (type === "richtext") props = { doc: { blocks: [{ type: "paragraph", data: { text: "Write anything — bold, links, lists, quotes…" } }] } };
    else if (type === "columns") props = { cols: [{ heading: "Column one", text: "Text for the first column." }, { heading: "Column two", text: "Text for the second column." }] };
    else if (type === "gallery") props = { items: [] };
    else if (type === "embed") props = { url: "", caption: "" };
    else if (type === "quote") props = { text: "A memorable quote goes here.", cite: "" };
    else if (type === "divider") props = { style: "line" };
    else if (type === "cta") props = { heading: "Ready to start?", sub: "A short line of encouragement.", label: "Get started", href: "", style: "primary" };
    return { id: id, type: type, props: props };
  }
  function addBlock(type) { state.pageDraft.blocks.push(newBlock(type)); markPageDirty(); renderAppearance(); }
  function moveBlock(i, dir) {
    var b = state.pageDraft.blocks, j = i + dir;
    if (j < 0 || j >= b.length) return;
    var tmp = b[i]; b[i] = b[j]; b[j] = tmp; markPageDirty(); renderAppearance();
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
    if (b.type === "columns") return (p.cols || []).length + " column" + ((p.cols || []).length === 1 ? "" : "s");
    if (b.type === "gallery") return (p.items || []).length + " image" + ((p.items || []).length === 1 ? "" : "s");
    if (b.type === "embed") return p.url || "(no embed URL)";
    if (b.type === "quote") return (p.text || "").slice(0, 60) || "(quote)";
    if (b.type === "divider") return p.style || "line";
    if (b.type === "cta") return p.heading || "(call to action)";
    if (b.type === "richtext") {
      var n = ((p.doc || {}).blocks || []).length;
      var first = (((p.doc || {}).blocks || [])[0] || {}).data || {};
      var plain = String(first.text || "").replace(/<[^>]*>/g, "");
      return plain.slice(0, 60) || (n + " rich block" + (n === 1 ? "" : "s"));
    }
    return "";
  }
  /* ----------------------------- Appearance: media library (R2) -----------------------------
   * Images upload through the Worker into R2 (10 MB cap server-side); big photos are
   * downscaled in the browser first so uploads stay small and free-tier storage lasts.
   * The grid lists everything with alt-text editing, copy-URL and delete; the image
   * block's "Choose from library" picker reuses the same data. */
  var MEDIA_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  // Downscale to <=2000px on the long edge (webp when possible). GIFs upload untouched
  // so animations survive; anything that fails to decode falls back to the raw file.
  function downscaleImage(file) {
    if (file.type === "image/gif") return Promise.resolve(file);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 2000, w = img.naturalWidth, h = img.naturalHeight;
        if (w <= max && h <= max && file.size < 1.5 * 1024 * 1024) { resolve(file); return; }
        var scale = Math.min(1, max / Math.max(w, h));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) { resolve(blob || file); }, "image/webp", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function uploadMedia(file, onDone, folder) {
    if (MEDIA_UPLOAD_TYPES.indexOf(file.type) === -1) { toast("Only JPEG, PNG, WebP or GIF images can be uploaded"); return; }
    toast("Uploading " + file.name + "…");
    downscaleImage(file).then(function (blob) {
      if (blob.size > 10 * 1024 * 1024) { toast("That image is over 10 MB even after resizing"); return; }
      var qs = "/api/media?filename=" + encodeURIComponent(file.name);
      if (folder) qs += "&folder=" + encodeURIComponent(folder);
      return fetch(qs, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": blob.type || file.type }, body: blob
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); }).then(function (res) {
        if (!res.ok) { toast((res.data && res.data.error) || "Upload failed"); return; }
        state.media = state.media || [];
        state.media.unshift(res.data);
        toast("Image uploaded");
        if (onDone) onDone(res.data);
      });
    }).catch(function () { toast("Upload failed"); });
  }
  function loadMediaList() {
    return api("/media").then(function (res) {
      state.media = (res.ok && res.data && res.data.media) || [];
    }).catch(function () { state.media = state.media || []; });
  }
  function mediaUrl(m) { return "/" + m.key; }
  function renderMediaLibrary() {
    state.mediaFilter = state.mediaFilter || { q: "", folder: "" };
    var filter = state.mediaFilter;
    var panel = el("div", { class: "panel" });
    var fileInput = el("input", { type: "file", accept: MEDIA_UPLOAD_TYPES.join(","), hidden: true });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (f) uploadMedia(f, function () { renderAppearance(); }, filter.folder || "");
    });
    panel.appendChild(fileInput);
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Media library"),
      el("span", { class: "section-head-actions" }, [
        el("button", { class: "btn btn--sm btn--accent", onclick: function () { fileInput.click(); } }, "⬆ Upload image")
      ])
    ]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Images are stored in your site's own storage and served from /media/…. Large photos are resized before upload. Use them in image blocks via “Choose from library”. Uploads go into the selected folder; type a new folder name on any image to create one."));

    var folders = [];
    (state.media || []).forEach(function (m) { if (m.folder && folders.indexOf(m.folder) === -1) folders.push(m.folder); });
    folders.sort();
    var search = el("input", { type: "search", class: "cms-search", placeholder: "Search by name or alt text…", value: filter.q });
    search.addEventListener("input", function () { filter.q = search.value; drawGrid(); });
    var folderSel = el("select", {});
    folderSel.appendChild(el("option", { value: "" }, "All folders"));
    folders.forEach(function (fo) { var op = el("option", { value: fo }, fo); if (filter.folder === fo) op.selected = true; folderSel.appendChild(op); });
    folderSel.addEventListener("change", function () { filter.folder = folderSel.value; drawGrid(); });
    panel.appendChild(el("div", { class: "cms-toolbar" }, [search, folderSel]));

    var grid = el("div", { class: "media-grid" });
    panel.appendChild(grid);
    function matches(m) {
      if (filter.folder && (m.folder || "") !== filter.folder) return false;
      if (filter.q) {
        var q = filter.q.toLowerCase();
        if ((m.filename || "").toLowerCase().indexOf(q) === -1 && (m.alt || "").toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    }
    function drawGrid() {
      grid.textContent = "";
      if (!(state.media || []).length) { grid.appendChild(el("p", { class: "no-link" }, "No images yet. Upload your first one.")); return; }
      var shown = (state.media || []).filter(matches);
      if (!shown.length) { grid.appendChild(el("p", { class: "no-link" }, "No images match your search.")); return; }
      shown.forEach(function (m) {
        var altI = el("input", { type: "text", value: m.alt || "", placeholder: "Alt text (describe the image)" });
        var folderI = el("input", { type: "text", value: m.folder || "", placeholder: "Folder (optional)" });
        function saveMeta(okMsg, refresh) {
          api("/media/" + encodeURIComponent(m.id), { method: "POST", body: { alt: altI.value, folder: folderI.value } }).then(function (res) {
            if (!res.ok) { toast(apiError(res, "Couldn't save")); return; }
            m.alt = altI.value; m.folder = folderI.value; toast(okMsg || "Saved");
            if (refresh) renderAppearance();
          }).catch(function () { toast("Couldn't reach the server"); });
        }
        altI.addEventListener("change", function () { saveMeta("Alt text saved"); });
        folderI.addEventListener("change", function () { saveMeta("Folder saved", true); });
        grid.appendChild(el("div", { class: "media-card" }, [
          el("img", { class: "media-thumb", src: mediaUrl(m), alt: m.alt || m.filename, loading: "lazy" }),
          el("div", { class: "media-meta" }, [
            el("div", { class: "media-name", title: m.filename }, m.filename),
            altI, folderI,
            el("div", { class: "cms-actions" }, [
              el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
                try { navigator.clipboard.writeText(location.origin + mediaUrl(m)); toast("Image URL copied"); }
                catch (e) { toast(mediaUrl(m)); }
              } }, "Copy URL"),
              el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () {
                openModal("Delete image", el("p", {}, "Delete “" + m.filename + "”? Pages using it will show a broken image."), [
                  { label: "Cancel", onClick: closeModal },
                  { label: "Delete image", danger: true, onClick: function () {
                    api("/media/" + encodeURIComponent(m.id), { method: "DELETE" }).then(function (res) {
                      closeModal();
                      if (!res.ok) { toast(apiError(res, "Couldn't delete image")); return; }
                      state.media = (state.media || []).filter(function (x) { return x.id !== m.id; });
                      renderAppearance(); toast("Image deleted");
                    }).catch(function () { toast("Couldn't reach the server"); });
                  } }
                ]);
              } }, "Delete")
            ])
          ])
        ]));
      });
    }
    drawGrid();
    return panel;
  }
  // Grid picker used by the image block editor: choose an existing image or upload.
  function openMediaPicker(onPick) {
    function body() {
      var wrap = el("div", {});
      var fileInput = el("input", { type: "file", accept: MEDIA_UPLOAD_TYPES.join(","), hidden: true });
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (f) uploadMedia(f, function (m) { closeModal(); onPick(m); });
      });
      wrap.appendChild(fileInput);
      wrap.appendChild(el("div", { style: "margin-bottom:12px" }, [
        el("button", { class: "btn btn--sm btn--accent", onclick: function () { fileInput.click(); } }, "⬆ Upload new image")
      ]));
      var grid = el("div", { class: "media-grid media-grid--picker" });
      if (!(state.media || []).length) grid.appendChild(el("p", { class: "no-link" }, "No images in the library yet — upload one above."));
      (state.media || []).forEach(function (m) {
        var card = el("button", { class: "media-card media-card--pick", type: "button", onclick: function () { closeModal(); onPick(m); } }, [
          el("img", { class: "media-thumb", src: mediaUrl(m), alt: m.alt || m.filename, loading: "lazy" }),
          el("div", { class: "media-name", title: m.filename }, m.filename)
        ]);
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      return wrap;
    }
    if (state.media == null) loadMediaList().then(function () { openModal("Choose an image", body(), [{ label: "Cancel", onClick: closeModal }]); });
    else openModal("Choose an image", body(), [{ label: "Cancel", onClick: closeModal }]);
  }

  // Pages manager: a list of every builder page (create / edit / duplicate / publish /
  // delete), or the block editor for the page currently being edited.
  function renderPageBuilder() {
    return state.pageDraft ? renderPageEditor() : renderPagesList();
  }
  /* Reusable sections: save the current page's blocks as a named section, and insert a
   * saved section's blocks into any page (fresh block ids; re-sanitized on page save). */
  function loadSections() {
    return api("/sections").then(function (res) { state.sections = (res.ok && res.data && res.data.sections) || []; })
      .catch(function () { state.sections = state.sections || []; });
  }
  function saveAsSection() {
    var draft = state.pageDraft; if (!draft) return;
    if (!draft.blocks.length) { toast("Add some blocks to the page first"); return; }
    var nameI = el("input", { type: "text", placeholder: "e.g. Footer call-to-action" });
    openModal("Save as reusable section", el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Section name"), nameI]),
      el("p", { class: "field-hint" }, "Saves the " + draft.blocks.length + " block" + (draft.blocks.length === 1 ? "" : "s") + " on this page as a section you can insert into any page.")
    ]), [
      { label: "Cancel", onClick: closeModal },
      { label: "Save section", accent: true, onClick: function () {
        api("/sections", { method: "POST", body: { name: nameI.value, blocks: draft.blocks } }).then(function (res) {
          closeModal();
          if (!res.ok) { toast(apiError(res, "Couldn't save section")); return; }
          state.sections = state.sections || []; state.sections.unshift(res.data);
          toast("Section saved");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }
    ]);
    setTimeout(function () { try { nameI.focus(); } catch (e) {} }, 40);
  }
  function openInsertSectionModal() {
    function body() {
      var wrap = el("div", { class: "form-stack" });
      var secs = state.sections || [];
      if (!secs.length) wrap.appendChild(el("p", { class: "no-link" }, "No saved sections yet. Build a page, then use “Save page as section”."));
      secs.forEach(function (sec) {
        wrap.appendChild(el("div", { class: "builder-block" }, [
          el("div", { class: "builder-block-head" }, [
            el("span", { class: "chip" }, (sec.blocks || []).length + " block" + ((sec.blocks || []).length === 1 ? "" : "s")),
            el("span", { class: "builder-block-summary" }, el("strong", {}, sec.name))
          ]),
          el("div", { class: "cms-actions" }, [
            el("button", { class: "btn btn--sm btn--accent", onclick: function () {
              var draft = state.pageDraft; if (!draft) return;
              (sec.blocks || []).forEach(function (b) { draft.blocks.push(Object.assign({}, b, { id: "b" + Math.random().toString(36).slice(2, 8) })); });
              markPageDirty(); closeModal(); renderAppearance(); toast("Section inserted");
            } }, "Insert"),
            el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () {
              api("/sections/" + encodeURIComponent(sec.id), { method: "DELETE" }).then(function (res) {
                if (!res.ok) { toast(apiError(res, "Couldn't delete section")); return; }
                state.sections = (state.sections || []).filter(function (x) { return x.id !== sec.id; });
                closeModal(); openInsertSectionModal(); toast("Section deleted");
              }).catch(function () { toast("Couldn't reach the server"); });
            } }, "Delete")
          ])
        ]));
      });
      return wrap;
    }
    if (state.sections == null) loadSections().then(function () { openModal("Insert saved section", body(), [{ label: "Close", onClick: closeModal }]); });
    else openModal("Insert saved section", body(), [{ label: "Close", onClick: closeModal }]);
  }
  function slugify(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }
  function openPageDraft(page) { openPageDraftState(page); renderAppearance(); }
  function openNewPageModal() {
    var title = el("input", { type: "text", placeholder: "About us" });
    var slugI = el("input", { type: "text", placeholder: "about-us" });
    var touched = false;
    title.addEventListener("input", function () { if (!touched) slugI.value = slugify(title.value); });
    slugI.addEventListener("input", function () { touched = true; slugI.value = slugI.value.replace(/[^a-z0-9-]/g, ""); });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    openModal("New page", el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Page title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Address (slug)"), slugI,
        el("p", { class: "field-hint" }, "The page will live at #/p/<slug>. Lowercase letters, numbers and dashes only.")]),
      errBox
    ]), [
      { label: "Cancel", onClick: closeModal },
      { label: "Create page", accent: true, onClick: function () {
        var id = slugify(slugI.value || title.value);
        if (!id) { errBox.textContent = "Give the page a title or slug first."; errBox.hidden = false; return; }
        if ((state.pages || []).some(function (p) { return p.id === id; })) {
          errBox.textContent = "A page with that slug already exists."; errBox.hidden = false; return;
        }
        closeModal();
        openPageDraft({ id: id, title: title.value.trim() || id, blocks: [], status: "draft" });
      } }
    ]);
  }
  function refreshNavAndTabs() {
    return loadNavPages().then(function () { if (state.session) renderTabs(); });
  }
  // The app's built-in pages (the existing site). Their layout is fixed but their copy is
  // editable via content slots — surfaced in the Pages section so a super admin edits
  // existing pages here, not only new builder pages. `nav` = the in-app tab to preview it.
  var BUILTIN_PAGES = [
    { id: "landing", name: "Landing page", desc: "signed-out home, above the sign-in form", landing: true, slots: [
      ["hero.kicker", "Hero kicker"], ["hero.title", "Hero headline", true], ["hero.copy", "Hero intro", true],
      ["hero.role1", "Role line 1"], ["hero.role2", "Role line 2"], ["hero.role3", "Role line 3"],
      ["hero.note_title", "Preview note title"], ["hero.note_copy", "Preview note copy"],
      ["moment.morning_label", "Morning label"], ["moment.morning_copy", "Morning copy", true],
      ["moment.midday_label", "Midday label"], ["moment.midday_copy", "Midday copy", true],
      ["moment.evening_label", "Evening label"], ["moment.evening_copy", "Evening copy", true],
      ["guide.title", "Start-guide title"], ["guide.meta", "Time estimate"],
      ["guide.step1_title", "Step 1 title", true], ["guide.step1_copy", "Step 1 copy", true],
      ["guide.step2_title", "Step 2 title", true], ["guide.step2_copy", "Step 2 copy", true],
      ["guide.step3_title", "Step 3 title", true], ["guide.step3_copy", "Step 3 copy", true],
      ["preview.kicker", "Library-preview kicker"], ["preview.title", "Library-preview title"], ["preview.copy", "Library-preview copy", true]
    ] },
    { id: "repo", name: "Repository", nav: "repo", slots: [["repo.heading", "Heading"], ["repo.intro", "Intro paragraph", true]] },
    { id: "students", name: "Students", nav: "students", slots: [["students.heading", "Heading"], ["students.intro", "Intro paragraph", true]] },
    { id: "content", name: "Content", nav: "content", slots: [["content.heading", "Heading"], ["content.intro", "Intro paragraph", true]] },
    { id: "workouts", name: "My Workouts", nav: "workouts", slots: [["workouts.heading", "Heading"], ["workouts.intro", "Intro paragraph", true]] },
    { id: "checkin", name: "Check-in", nav: "checkin", slots: [["checkin.heading", "Heading"], ["checkin.intro", "Intro paragraph", true]] },
    { id: "messages", name: "Messages", nav: "messages", slots: [["messages.heading", "Heading"], ["messages.intro", "Intro paragraph", true]] },
    { id: "progress", name: "My Progress", nav: "progress", slots: [["progress.heading", "Heading"], ["progress.intro", "Intro paragraph", true]] },
    { id: "settings", name: "Settings", nav: "settings", slots: [["settings.heading", "Heading"], ["settings.intro", "Intro paragraph", true]] }
  ];
  function landingBuilderPage() { return (state.pages || []).filter(function (p) { return p.id === "landing"; })[0] || null; }
  function openBuiltinPageEditor(pg) {
    var inputs = {};
    var body = el("div", { class: "form-stack" });
    pg.slots.forEach(function (def) {
      var key = def[0], label = def[1];
      var input = def[2] ? el("textarea", { rows: 3 }) : el("input", { type: "text" });
      input.value = slot(key);
      inputs[key] = input;
      body.appendChild(el("div", { class: "field" }, [el("label", {}, label), input]));
    });
    openModal("Edit “" + pg.name + "” text", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Save", accent: true, onClick: function () {
        saveContentSlots(Object.keys(inputs).map(function (k) { return [k, inputs[k].value]; }), closeModal);
      } }
    ]);
  }
  function renderPagesList() {
    var wrap = el("div", { class: "cms-design" });

    /* Built-in site pages (existing) — editable copy + preview. */
    var sitePanel = el("div", { class: "panel" });
    sitePanel.appendChild(el("div", { class: "section-head" }, [el("h3", {}, "Site pages")]));
    sitePanel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Your existing built-in pages. Edit their text here, or open one to see it. For full block-based control of the landing page, use “Build with blocks”."));
    var siteList = el("div", { class: "builder-canvas" });
    BUILTIN_PAGES.forEach(function (pg) {
      var actions = [];
      if (canEditCms("content")) actions.push(el("button", { class: "btn btn--sm", onclick: function () { openBuiltinPageEditor(pg); } }, "Edit text"));
      if (pg.nav) actions.push(el("button", { class: "btn btn--sm btn--ghost", onclick: function () { setTab(pg.nav); } }, "Open ↗"));
      if (pg.landing) actions.push(el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
        var lp = landingBuilderPage();
        openPageDraft(lp || { id: "landing", title: "Landing", blocks: [], status: "draft" });
      } }, landingBuilderPage() ? "Edit blocks" : "Build with blocks"));
      siteList.appendChild(el("div", { class: "builder-block" }, [
        el("div", { class: "builder-block-head" }, [
          el("span", { class: "chip" }, "built-in"),
          el("span", { class: "builder-block-summary" }, [el("strong", {}, pg.name), pg.desc ? (" · " + pg.desc) : ""])
        ]),
        el("div", { class: "cms-actions" }, actions)
      ]));
    });
    sitePanel.appendChild(siteList);
    wrap.appendChild(sitePanel);

    /* Custom builder pages. */
    var panel = el("div", { class: "panel" });
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Custom pages"),
      el("span", { class: "section-head-actions" }, [
        el("button", { class: "btn btn--sm btn--accent", onclick: openNewPageModal }, "+ New page")
      ])
    ]));
    panel.appendChild(el("p", { class: "field-hint", style: "margin:4px 0 12px" },
      "Block-based pages you build from scratch. Published pages are visible at #/p/<slug>; give a page a nav label to add it to the navigation. A custom page with the slug “landing” replaces the built-in signed-out home."));
    var list = el("div", { class: "builder-canvas" });
    if (!(state.pages || []).length) list.appendChild(el("p", { class: "no-link" }, "No custom pages yet. Create your first one."));
    (state.pages || []).forEach(function (p) {
      var pub = (p.status || (p.published ? "published" : "draft")) === "published";
      list.appendChild(el("div", { class: "builder-block" }, [
        el("div", { class: "builder-block-head" }, [
          el("span", { class: "chip " + (pub ? "chip--accent" : "") }, pub ? "published" : "draft"),
          el("span", { class: "builder-block-summary" }, [
            el("strong", {}, p.title || p.id), " · #/p/" + p.id +
            " · " + ((p.blocks || []).length) + " block" + ((p.blocks || []).length === 1 ? "" : "s") +
            (p.navLabel ? " · in nav as “" + p.navLabel + "”" : "")
          ])
        ]),
        el("div", { class: "cms-actions" }, [
          el("button", { class: "btn btn--sm", onclick: function () { openPageDraft(p); } }, "Edit"),
          el("button", { class: "btn btn--sm btn--ghost", onclick: function () { togglePagePublished(p); } }, pub ? "Unpublish" : "Publish"),
          el("button", { class: "btn btn--sm btn--ghost", onclick: function () { duplicatePage(p.id); } }, "Duplicate"),
          el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { confirmDeletePage(p); } }, "Delete")
        ])
      ]));
    });
    panel.appendChild(list);
    wrap.appendChild(panel);
    return wrap;
  }
  function togglePagePublished(p) {
    var pub = (p.status || (p.published ? "published" : "draft")) === "published";
    api("/pages/" + encodeURIComponent(p.id), { method: "POST", body: {
      title: p.title, blocks: p.blocks || [], status: pub ? "draft" : "published",
      description: p.description || "", navLabel: p.navLabel || "", navOrder: p.navOrder
    } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't update page")); return; }
      state.pages = (state.pages || []).map(function (pg) { return pg.id === p.id ? res.data : pg; });
      refreshNavAndTabs();
      renderAppearance();
      toast(pub ? "Page unpublished" : "Page published");
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  function duplicatePage(id) {
    api("/pages/" + encodeURIComponent(id) + "/duplicate", { method: "POST", body: {} }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't duplicate page")); return; }
      state.pages.push(res.data);
      renderAppearance();
      toast("Page duplicated — it starts as a draft");
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  function confirmDeletePage(p) {
    openModal("Delete page", el("p", {}, "Delete “" + (p.title || p.id) + "” (#/p/" + p.id + ")? This can't be undone."), [
      { label: "Cancel", onClick: closeModal },
      { label: "Delete page", danger: true, onClick: function () {
        api("/pages/" + encodeURIComponent(p.id), { method: "DELETE" }).then(function (res) {
          closeModal();
          if (!res.ok) { toast(apiError(res, "Couldn't delete page")); return; }
          state.pages = (state.pages || []).filter(function (pg) { return pg.id !== p.id; });
          if (state.pageDraft && state.pageDraft.id === p.id) state.pageDraft = null;
          refreshNavAndTabs();
          renderAppearance();
          toast("Page deleted");
        }).catch(function () { toast("Couldn't reach the server"); });
      } }
    ]);
  }
  function renderPageEditor() {
    var draft = state.pageDraft;
    var panel = el("div", { class: "panel" });
    var dirtyFlag = el("span", { id: "page-dirty-flag", class: "cms-count page-flag" },
      draft.dirty ? "● Unsaved changes" : (draft.autosavedAt ? "Autosaved (not published)" : ""));
    if (draft.dirty) dirtyFlag.className = "cms-count page-flag page-flag--dirty";
    panel.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Page: " + (draft.title || draft.id)),
      dirtyFlag,
      el("span", { class: "section-head-actions" }, [
        el("button", { class: "btn btn--sm", onclick: function () { state.pageDraft = null; renderAppearance(); } }, "← All pages"),
        el("button", { class: "btn btn--sm btn--ghost", onclick: openRevisionsModal }, "Revisions"),
        el("button", { class: "btn btn--sm btn--ghost", onclick: function () {
          window.open(location.pathname + "#/p/" + draft.id, "_blank");
        } }, "Preview ↗")
      ])
    ]));
    if (draft.fromAutosave) {
      panel.appendChild(el("div", { class: "note-banner", style: "margin:0 0 12px" }, [
        el("strong", {}, "Resumed autosaved changes. "),
        "These aren't visible to visitors until you save the page. Use Revisions to go back to the last saved version."
      ]));
    }

    var titleInput = el("input", { type: "text", value: draft.title });
    titleInput.addEventListener("input", function () { draft.title = titleInput.value; markPageDirty(); });
    var slugInfo = el("input", { type: "text", value: "#/p/" + draft.id, readonly: true });
    var statusSel = el("select", {});
    [["draft", "Draft (only you can see it)"], ["published", "Published (visible to visitors)"]].forEach(function (o) {
      var op = el("option", { value: o[0] }, o[1]); if (draft.status === o[0]) op.selected = true; statusSel.appendChild(op);
    });
    statusSel.addEventListener("change", function () { draft.status = statusSel.value; markPageDirty("meta"); });
    var descInput = el("textarea", { rows: 2, placeholder: "Short description (used for search engines and page lists)" });
    descInput.value = draft.description || "";
    descInput.addEventListener("input", function () { draft.description = descInput.value; markPageDirty("meta"); });
    var navInput = el("input", { type: "text", value: draft.navLabel || "", placeholder: "e.g. About" });
    navInput.addEventListener("input", function () { draft.navLabel = navInput.value; markPageDirty("meta"); });
    var navOrderInput = el("input", { type: "number", value: draft.navOrder || "", placeholder: "0" });
    navOrderInput.addEventListener("input", function () { draft.navOrder = navOrderInput.value; markPageDirty("meta"); });
    panel.appendChild(el("div", { class: "appearance-grid" }, [
      el("label", { class: "appearance-field" }, [el("span", {}, "Page title"), titleInput]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Address"), slugInfo]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Status"), statusSel]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Nav link label (empty = not in nav)"), navInput]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Nav position"), navOrderInput]),
      el("label", { class: "appearance-field" }, [el("span", {}, "Description"), descInput])
    ]));

    var palette = el("div", { class: "builder-palette" });
    [["richtext", "Rich text"], ["hero", "Hero"], ["heading", "Heading"], ["text", "Text"], ["image", "Image"], ["gallery", "Gallery"], ["cards", "Cards"], ["columns", "Columns"], ["quote", "Quote"], ["embed", "Embed"], ["button", "Button"], ["cta", "Call to action"], ["divider", "Divider"], ["spacer", "Spacer"]].forEach(function (pair) {
      palette.appendChild(el("button", { class: "btn btn--sm btn--ghost", onclick: function () { addBlock(pair[0]); } }, "+ " + pair[1]));
    });
    panel.appendChild(el("div", { class: "builder-section" }, [el("div", { class: "detail-label" }, "Add a block"), palette]));

    var sectionsBar = el("div", { class: "builder-palette" }, [
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: openInsertSectionModal }, "⧉ Insert saved section"),
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: saveAsSection }, "💾 Save page as section")
    ]);
    panel.appendChild(el("div", { class: "builder-section" }, [el("div", { class: "detail-label" }, "Reusable sections"), sectionsBar]));

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
          el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { draft.blocks.splice(i, 1); markPageDirty(); renderAppearance(); } }, "Delete")
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
  function renderColumnsEditor(fields, p) {
    if (!Array.isArray(p.cols)) p.cols = [];
    var list = el("div", { class: "form-stack" });
    function draw() {
      list.textContent = "";
      p.cols.forEach(function (c, idx) {
        var h = el("input", { type: "text", placeholder: "Column heading", value: c.heading || "" });
        h.addEventListener("input", function () { c.heading = h.value; });
        var t = el("textarea", { rows: 3, placeholder: "Column text" }); t.value = c.text || "";
        t.addEventListener("input", function () { c.text = t.value; });
        list.appendChild(el("div", { class: "builder-col-edit" }, [
          h, t, el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { p.cols.splice(idx, 1); draw(); } }, "× Remove column")
        ]));
      });
    }
    draw();
    fields.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Columns (up to 4)"), list,
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () { if (p.cols.length < 4) { p.cols.push({ heading: "", text: "" }); draw(); } } }, "+ Add column")
    ]));
  }
  function renderGalleryEditor(fields, p, i, b) {
    if (!Array.isArray(p.items)) p.items = [];
    var list = el("div", { class: "form-stack" });
    function draw() {
      list.textContent = "";
      if (!p.items.length) list.appendChild(el("p", { class: "no-link" }, "No images yet — add one below."));
      p.items.forEach(function (it, idx) {
        var alt = el("input", { type: "text", placeholder: "Alt text", value: it.alt || "" });
        alt.addEventListener("input", function () { it.alt = alt.value; });
        list.appendChild(el("div", { class: "builder-card-row" }, [
          el("img", { class: "media-thumb media-thumb--sm", src: safeImageSrc(it.src) || "", alt: "" }),
          alt,
          el("button", { class: "btn btn--sm btn--ghost btn--danger", onclick: function () { p.items.splice(idx, 1); draw(); } }, "×")
        ]));
      });
    }
    draw();
    fields.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Images"), list,
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () {
        b.props = p;   // commit before the picker replaces this modal, then reopen
        openMediaPicker(function (m) { b.props.items = b.props.items || []; b.props.items.push({ src: "/" + m.key, alt: m.alt || "" }); openBlockModal(i); });
      } }, "+ Add image")
    ]));
  }
  function openBlockModal(i) {
    var b = state.pageDraft.blocks[i];
    if (!b) return;
    var p = Object.assign({}, b.props || {});
    var fields = el("div", { class: "form-stack" });
    var editorRef = { ed: null };   // Editor.js instance for richtext blocks
    function destroyEditor() {
      if (editorRef.ed) {
        try { editorRef.ed.destroy(); } catch (e) {}
        editorRef.ed = null;
      }
    }
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
      textField("src", "Image URL (https://… or /media/…)");
      fields.appendChild(el("div", { class: "field" }, [
        el("button", { class: "btn btn--sm", type: "button", onclick: function () {
          // The picker replaces this modal, so commit in-progress edits first, then
          // reopen the block editor with the chosen image filled in.
          b.props = p;
          openMediaPicker(function (m) {
            b.props.src = "/" + m.key;
            if (!b.props.alt && m.alt) b.props.alt = m.alt;
            openBlockModal(i);
          });
        } }, "🖼 Choose from library")
      ]));
      textField("alt", "Alt text"); textField("width", "Max width (e.g. 480px)");
    } else if (b.type === "button") {
      textField("label", "Label"); textField("href", "Link (https://…)");
      selectField("style", "Style", [["primary", "Primary"], ["ember", "Secondary"], ["ghost", "Ghost"]]);
    } else if (b.type === "spacer") {
      selectField("size", "Size", [["sm", "Small"], ["md", "Medium"], ["lg", "Large"]]);
    } else if (b.type === "cards") {
      renderCardsEditor(fields, p);
    } else if (b.type === "columns") {
      renderColumnsEditor(fields, p);
    } else if (b.type === "gallery") {
      renderGalleryEditor(fields, p, i, b);
    } else if (b.type === "embed") {
      textField("url", "Video URL (YouTube, Vimeo or Loom)");
      textField("caption", "Caption (optional)");
    } else if (b.type === "quote") {
      textField("text", "Quote", true); textField("cite", "Attribution (optional)");
    } else if (b.type === "divider") {
      selectField("style", "Style", [["line", "Line"], ["dots", "Dots"]]);
    } else if (b.type === "cta") {
      textField("heading", "Heading"); textField("sub", "Subheading", true);
      textField("label", "Button label"); textField("href", "Button link (https://…)");
      selectField("style", "Button style", [["primary", "Primary"], ["ember", "Secondary"], ["ghost", "Ghost"]]);
    } else if (b.type === "richtext") {
      // WordPress-style editor: block-based rich text (Editor.js), loaded on demand.
      var holder = el("div", { class: "richtext-holder" });
      var loading = el("p", { class: "field-hint" }, "Loading the rich-text editor…");
      fields.appendChild(el("div", { class: "field" }, [holder, loading]));
      ensureRichTextEditor().then(function () {
        loading.remove();
        editorRef.ed = new window.EditorJS({
          holder: holder,
          data: (p.doc && Array.isArray(p.doc.blocks)) ? p.doc : { blocks: [] },
          minHeight: 120,
          tools: {
            header: { class: window.Header, inlineToolbar: true, config: { levels: [1, 2, 3, 4], defaultLevel: 2 } },
            list: { class: window.List, inlineToolbar: true },
            quote: { class: window.Quote, inlineToolbar: true },
            delimiter: window.Delimiter
          }
        });
      }).catch(function () { loading.textContent = "Couldn't load the rich-text editor. Check your connection and try again."; });
    }
    openModal("Edit " + b.type, fields, [
      { label: "Cancel", onClick: function () {
        destroyEditor();
        closeModal();
      } },
      { label: "Done", accent: true, onClick: function () {
        if (b.type === "richtext") {
          if (!editorRef.ed) { closeModal(); return; }
          editorRef.ed.save().then(function (data) {
            p.doc = { blocks: ((data && data.blocks) || []).map(function (x) { return { type: x.type, data: x.data }; }) };
            destroyEditor();
            b.props = p; markPageDirty(); closeModal(); renderAppearance();
          }).catch(function () { toast("Couldn't read the editor content"); });
          return;
        }
        if (b.type === "heading") p.level = parseInt(p.level, 10) || 2;
        b.props = p; markPageDirty(); closeModal(); renderAppearance();
      } }
    ], destroyEditor);
  }
  function savePage() {
    var draft = state.pageDraft;
    api("/pages/" + encodeURIComponent(draft.id), { method: "POST", body: {
      title: draft.title, blocks: draft.blocks, status: draft.status,
      description: draft.description, navLabel: draft.navLabel, navOrder: draft.navOrder
    } }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't save page")); return; }
      var d = res.data || {};
      openPageDraftState(d);
      var found = false;
      state.pages = (state.pages || []).map(function (pg) {
        if (pg.id === d.id) { found = true; return d; }
        return pg;
      });
      if (!found) state.pages.push(d);
      refreshNavAndTabs();
      renderAppearance(); toast("Page saved");
    }).catch(function () { toast("Couldn't reach the server"); });
  }
  // Refresh the open draft from a server page row without re-rendering. If the row
  // carries an autosaved working copy (draftBlocks), the editor resumes from it —
  // the published version stays untouched until an explicit save.
  function openPageDraftState(page) {
    var hasAutosave = Array.isArray(page.draftBlocks);
    state.pageDraft = {
      id: page.id,
      title: (hasAutosave && page.draftTitle) || page.title || page.id,
      blocks: (hasAutosave ? page.draftBlocks : (page.blocks || [])).slice(),
      status: page.status || (page.published ? "published" : "draft"),
      description: page.description || "", navLabel: page.navLabel || "",
      navOrder: page.navOrder == null ? "" : String(page.navOrder),
      dirty: false, metadataDirty: false, fromAutosave: hasAutosave, autosavedAt: null
    };
  }
  function markPageDirty(kind) {
    if (!state.pageDraft) return;
    state.pageDraft.dirty = true;
    if (kind === "meta") state.pageDraft.metadataDirty = true;
    updateDirtyFlag();
  }
  function updateDirtyFlag() {
    var flag = $("#page-dirty-flag");
    if (!flag || !state.pageDraft) return;
    if (state.pageDraft.dirty) { flag.textContent = "● Unsaved changes"; flag.className = "cms-count page-flag page-flag--dirty"; }
    else if (state.pageDraft.autosavedAt) { flag.textContent = "Autosaved (not published)"; flag.className = "cms-count page-flag"; }
    else { flag.textContent = ""; flag.className = "cms-count page-flag"; }
  }
  // Every 20s, quietly park dirty edits in the page's working copy on the server.
  // A crash or closed tab then loses at most 20 seconds of work; the public page
  // only changes on an explicit "Save page".
  function autosavePageDraft() {
    var draft = state.pageDraft;
    if (!draft || !draft.dirty || !SERVER || !isSuperadmin()) return;
    api("/pages/" + encodeURIComponent(draft.id), { method: "POST", body: {
      mode: "autosave", title: draft.title, blocks: draft.blocks
    } }).then(function (res) {
      if (!res.ok || state.pageDraft !== draft) return;
      draft.dirty = !!draft.metadataDirty;
      draft.autosavedAt = Date.now();
      updateDirtyFlag();
    }).catch(function () {});
  }
  function openRevisionsModal() {
    var draft = state.pageDraft;
    if (!draft) return;
    api("/pages/" + encodeURIComponent(draft.id) + "/revisions").then(function (res) {
      var revs = (res.ok && res.data && res.data.revisions) || [];
      var body = el("div", { class: "form-stack" });
      if (!revs.length) body.appendChild(el("p", { class: "no-link" }, "No saved revisions yet. A revision is kept every time you save this page."));
      revs.forEach(function (r) {
        var when = new Date(r.saved_at * 1000).toLocaleString();
        body.appendChild(el("div", { class: "builder-block" }, [
          el("div", { class: "builder-block-head" }, [
            el("span", { class: "chip" + (r.status === "published" ? " chip--accent" : "") }, r.status || "draft"),
            el("span", { class: "builder-block-summary" }, [
              el("strong", {}, r.title), " · " + r.blocks.length + " block" + (r.blocks.length === 1 ? "" : "s") +
              " · " + when + (r.saved_by ? " · " + r.saved_by : "")
            ])
          ]),
          el("div", { class: "cms-actions" }, [
            el("button", { class: "btn btn--sm", onclick: function () {
              draft.title = r.title;
              draft.blocks = (r.blocks || []).slice();
              draft.dirty = true;
              closeModal();
              renderAppearance();
              toast("Revision loaded into the editor — save to apply it");
            } }, "Restore")
          ])
        ]));
      });
      openModal("Revisions — " + (draft.title || draft.id), body, [{ label: "Close", onClick: closeModal }]);
    }).catch(function () { toast("Couldn't load revisions"); });
  }
  // Published pages that opted into the nav; public endpoint, tolerant of absence.
  function loadNavPages() {
    return api("/nav").then(function (res) {
      state.navPages = (res.ok && res.data && res.data.nav) || [];
    }).catch(function () { state.navPages = state.navPages || []; });
  }
  /* ----------------------------- Public builder pages (#/p/:slug) ----------------------------- */
  // Lazily created host section for rendering builder pages inside the signed-in app.
  function ensurePageView() {
    var v = $("#view-page");
    if (!v) {
      v = el("section", { id: "view-page", class: "view", "aria-label": "Page" });
      $("main.container").appendChild(v);
    }
    return v;
  }
  function renderPublicPage(slug, mount) {
    mount.textContent = "";
    mount.appendChild(el("p", { class: "field-hint" }, "Loading page…"));
    // Super admins read the full row so they can preview drafts; everyone else only
    // ever sees published pages (the public endpoint 404s otherwise).
    var path = isSuperadmin()
      ? "/pages/" + encodeURIComponent(slug) + "/full"
      : "/pages/" + encodeURIComponent(slug);
    api(path).then(function (res) {
      mount.textContent = "";
      if (!res.ok || !res.data) {
        mount.appendChild(el("div", { class: "view-intro" }, [
          el("h2", {}, "Page not found"),
          el("p", {}, "This page doesn't exist or isn't published.")
        ]));
        return;
      }
      if (isSuperadmin() && res.data.status !== "published") {
        mount.appendChild(el("div", { class: "note-banner" }, [
          el("strong", {}, "Draft preview: "),
          "only super admins can see this page until it's published."
        ]));
      }
      var wrap = el("div", { class: "pb-page" });
      renderPageBlocks(res.data.blocks || [], wrap);
      mount.appendChild(wrap);
    }).catch(function () {
      mount.textContent = "";
      mount.appendChild(el("p", { class: "no-link" }, "Couldn't load this page."));
    });
  }

  /* ----------------------------- Rich text (Editor.js + DOMPurify) -----------------------------
   * Self-hosted, pinned bundles under vendor/ (no runtime CDN dependency), lazy-loaded:
   * DOMPurify only when a rich block needs rendering, the Editor.js suite only when a
   * super admin opens the rich-text editor. */
  var scriptPromises = {};
  function loadScript(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { delete scriptPromises[src]; reject(new Error("failed to load " + src)); };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }
  function ensureDomPurify() {
    return window.DOMPurify ? Promise.resolve() : loadScript("vendor/dompurify.min.js");
  }
  function ensureRichTextEditor() {
    return loadScript("vendor/editorjs.umd.js").then(function () {
      return Promise.all([
        loadScript("vendor/editorjs-header.umd.js"),
        loadScript("vendor/editorjs-list.umd.js"),
        loadScript("vendor/editorjs-quote.umd.js"),
        loadScript("vendor/editorjs-delimiter.umd.js"),
        ensureDomPurify()
      ]);
    });
  }
  // Sanitize an inline-HTML fragment and return a DOM node. The server already scrubbed
  // on save; DOMPurify at render time is the second, authoritative layer. Links are
  // post-hardened to https-only + noopener (tightening after sanitize is safe).
  var RICH_ALLOWED_TAGS = ["b", "i", "strong", "em", "a", "code", "mark", "br", "u", "s"];
  function richInline(tag, cls, html) {
    var node = el(tag, cls ? { class: cls } : {});
    node.innerHTML = window.DOMPurify
      ? window.DOMPurify.sanitize(String(html || ""), { ALLOWED_TAGS: RICH_ALLOWED_TAGS, ALLOWED_ATTR: ["href"] })
      : "";
    $all("a", node).forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (!/^https:\/\//i.test(href)) { a.removeAttribute("href"); return; }
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
    return node;
  }
  // Build DOM for a sanitized Editor.js document (paragraph/header/list/quote/delimiter).
  function renderRichDoc(doc, mount) {
    ((doc && doc.blocks) || []).forEach(function (b) {
      if (!b) return;
      var d = b.data || {};
      if (b.type === "paragraph") mount.appendChild(richInline("p", "pb-rich-p", d.text));
      else if (b.type === "header") {
        var lvl = d.level >= 1 && d.level <= 4 ? Math.floor(d.level) : 2;
        mount.appendChild(richInline("h" + lvl, "pb-rich-h", d.text));
      } else if (b.type === "list") {
        var listEl = el(d.style === "ordered" ? "ol" : "ul", { class: "pb-rich-list" });
        (d.items || []).forEach(function (it) { listEl.appendChild(richInline("li", "", it)); });
        mount.appendChild(listEl);
      } else if (b.type === "quote") {
        var q = el("blockquote", { class: "pb-rich-quote" }, [richInline("p", "", d.text)]);
        if (d.caption) q.appendChild(richInline("cite", "", d.caption));
        mount.appendChild(q);
      } else if (b.type === "delimiter") {
        mount.appendChild(el("div", { class: "pb-rich-delimiter", "aria-hidden": "true" }, "* * *"));
      }
    });
  }

  // Render an ordered list of sanitized content blocks into a mount node. All text is
  // set via textContent (never innerHTML) and links/images are forced to https; the
  // one exception is rich text, which goes through DOMPurify (richInline above), so
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
      var src = safeImageSrc(p.src);
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
    },
    richtext: function (p) {
      var wrap = el("div", { class: "pb-rich" });
      // DOMPurify may not be loaded yet on a public view; fill the node once it is.
      if (window.DOMPurify) renderRichDoc(p.doc, wrap);
      else ensureDomPurify().then(function () { renderRichDoc(p.doc, wrap); }).catch(function () {});
      return wrap;
    },
    columns: function (p) {
      var cols = (p.cols || []);
      var grid = el("div", { class: "pb-columns pb-cols-" + Math.min(4, Math.max(1, cols.length || 1)) });
      cols.forEach(function (c) {
        grid.appendChild(el("div", { class: "pb-column" }, [
          c.heading ? el("h3", { class: "pb-col-h" }, c.heading) : null,
          c.text ? el("p", {}, c.text) : null
        ]));
      });
      return grid;
    },
    gallery: function (p) {
      var items = (p.items || []).filter(function (it) { return safeImageSrc(it.src); });
      if (!items.length) return null;
      var grid = el("div", { class: "pb-gallery" });
      items.forEach(function (it) {
        grid.appendChild(el("img", { class: "pb-gallery-img", src: safeImageSrc(it.src), alt: it.alt || "", loading: "lazy" }));
      });
      return grid;
    },
    embed: function (p) {
      var src = toEmbedSrc(p.url);
      if (!src) return null;
      var wrap = el("div", { class: "pb-embed" }, [
        el("div", { class: "pb-embed-frame" }, [
          el("iframe", { src: src, loading: "lazy", allowfullscreen: "", frameborder: "0", referrerpolicy: "strict-origin-when-cross-origin", allow: "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" })
        ])
      ]);
      if (p.caption) wrap.appendChild(el("p", { class: "pb-embed-cap" }, p.caption));
      return wrap;
    },
    quote: function (p) {
      if (!p.text) return null;
      var q = el("blockquote", { class: "pb-quote" }, [el("p", {}, p.text)]);
      if (p.cite) q.appendChild(el("cite", {}, p.cite));
      return q;
    },
    divider: function (p) {
      return el("div", { class: "pb-divider pb-divider--" + (p.style === "dots" ? "dots" : "line"), "aria-hidden": "true" }, p.style === "dots" ? "• • •" : null);
    },
    cta: function (p) {
      var kids = [el("h2", { class: "pb-cta-h" }, p.heading || "")];
      if (p.sub) kids.push(el("p", { class: "pb-cta-sub" }, p.sub));
      var href = safeUrl(p.href);
      if (p.label && href) {
        var cls = "btn " + (p.style === "ghost" ? "btn--ghost" : (p.style === "ember" ? "btn--ember" : "btn--primary"));
        kids.push(el("a", { class: cls, href: href }, p.label));
      }
      return el("section", { class: "pb-cta" }, kids);
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
    { sel: "#student-select", title: "Active athlete", text: "Pick who you're working with. Assignments and progress follow this selection." },
    { sel: "[data-tab=\"settings\"]", title: "Settings", text: "Manage your account and back up or import data here." }
  ];
  var TOUR_STUDENT = [
    { sel: ".brand", title: "Welcome!", text: "This is your personal training space. Here's a quick tour." },
    { sel: "[data-tab=\"workouts\"]", title: "My Workouts", text: "The activities your coach assigned you. Work through them and tick each one done." },
    { sel: ".assign-item details.detail", title: "Read the instructions", text: "Open this to see the activity's instructions and reflection prompt. There is no need to leave the page." },
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
        cmsScope();   // normalize from the persisted choice (default: shared/publish)
        scopeWrap.hidden = false;
        scopeWrap.textContent = "";
        [["global", "Shared library — everyone"], ["private", "Only me — private"]].forEach(function (pair) {
          var input = el("input", { type: "radio", name: "cms-scope", value: pair[0] });
          if (state.cmsScope === pair[0]) input.checked = true;
          input.addEventListener("change", function () {
            if (!input.checked) return;
            setCmsScope(pair[0]);
            renderContent();
          });
          scopeWrap.appendChild(el("label", {}, [input, el("span", {}, pair[1])]));
        });
      } else {
        scopeWrap.hidden = true;
        state.cmsScope = "private";
      }
    }
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
      pane.textContent = ""; pane.appendChild(el("p", { class: "no-link" }, "Loading the shared library…"));
      return;
    }
    if (cmsGlobal() && state.globalTracking && state.globalTracking.failed) {
      var failPane = sub === "activities" ? $("#cms-activities") : $("#cms-taxonomy");
      failPane.textContent = "";
      failPane.appendChild(el("p", { class: "no-link" }, "Couldn't load the shared library — editing is paused so nothing gets overwritten. "));
      failPane.appendChild(el("button", { class: "btn btn--sm", onclick: function () { state.globalTracking = null; renderContent(); } }, "Try again"));
      return;
    }
    if (sub === "activities") renderCmsActivities(); else renderCmsTaxonomy();
  }

  // A persistent banner naming the library the super admin is editing, so a Shared-library
  // edit is never mistaken for a private one (and vice-versa). Only super admins see the
  // scope switch, so only they get the banner. Returns null for coaches/admins.
  function scopeBanner() {
    if (!isSuperadmin()) return null;
    if (cmsGlobal()) {
      return el("div", { class: "scope-banner scope-banner--global" }, [
        el("strong", {}, "Shared library"),
        " — changes here are visible to every coach and athlete. Switch to “My library” above to edit private content only."
      ]);
    }
    return el("div", { class: "scope-banner scope-banner--private" }, [
      el("strong", {}, "My library"),
      " — private to you. Switch to “Shared library” above to change what every coach and athlete sees."
    ]);
  }

  function renderCmsActivities() {
    var wrap = $("#cms-activities");
    wrap.textContent = "";
    var banner = scopeBanner(); if (banner) wrap.appendChild(banner);
    var libActions = [el("button", { class: "btn btn--sm btn--accent", onclick: function () { openActivityModal(); } }, "+ Add activity")];
    // Bulk import from a spreadsheet (super admin, server mode): parse client-side,
    // preview, then POST to the bulk endpoint in the current Shared/Private scope.
    if (SERVER && isSuperadmin()) {
      libActions.push(el("button", { class: "btn btn--sm", title: "Bulk-add activities from a CSV file", onclick: openCsvImportModal }, "⬆ Import CSV"));
    }
    wrap.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, "Activity library"),
      el("div", { class: "section-head-actions" }, libActions)
    ]));
    var search = el("input", { type: "search", class: "cms-search", placeholder: "Search activities…" });
    search.value = state.cmsSearch || "";
    var hiddenCb = el("input", { type: "checkbox" });
    hiddenCb.checked = !!state.cmsShowHidden;
    hiddenCb.addEventListener("change", function () { state.cmsShowHidden = hiddenCb.checked; state.cmsShowAll = false; renderCmsActivities(); });
    wrap.appendChild(el("div", { class: "cms-toolbar" }, [
      search,
      el("details", { class: "cms-toolbar-more" }, [
        el("summary", {}, "Library options"),
        el("div", { class: "cms-toolbar-panel" }, [
          el("label", { class: "check" }, [hiddenCb, " Show hidden"])
        ])
      ])
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
      var maxRows = (!q && !state.cmsShowAll) ? 36 : rows.length;
      var visibleRows = rows.slice(0, maxRows);
      if (visibleRows.length < rows.length) {
        tableWrap.appendChild(el("div", { class: "cms-window-note" }, [
          el("span", {}, "Showing the first " + visibleRows.length + " activities so this list stays scannable."),
          el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () { state.cmsShowAll = true; draw(); } }, "Show all " + rows.length)
        ]));
      }
      var table = el("div", { class: "cms-table" });
      visibleRows.forEach(function (a) {
        var hid = cmsHidden(a.id);
        var tags = [];
        // In the CMS: shared-library items say "Shared" (visible to everyone); the
        // editor's own private additions say "Added by you".
        if (isCustom(a.id)) {
          tags.push(el("span", { class: "chip chip--accent" }, (cmsGlobal() || a.scope === "global") ? "Shared" : "Added by you"));
        }
        if (hid) tags.push(el("span", { class: "chip" }, "Hidden"));
        table.appendChild(el("div", { class: "cms-row" + (hid ? " is-hidden" : "") }, [
          el("div", { class: "cms-cell cms-cell--name" }, [
            el("strong", {}, a.name),
            el("div", { class: "cms-meta" }, [a.topic, a.type, a.progression].filter(Boolean).join(" · ") || "—")
          ]),
          el("div", { class: "cms-cell cms-tags" }, tags),
          el("div", { class: "cms-cell cms-actions" }, [
            el("button", { class: "btn btn--sm", onclick: function () { openActivityModal(a.id); } }, "Edit"),
            el("details", { class: "cms-row-menu" }, [
              el("summary", {}, "More"),
              el("div", { class: "cms-row-menu-panel" }, [
                el("button", { class: "btn btn--sm btn--ghost", type: "button", onclick: function () { setHidden(a.id, !hid); renderAll(); } }, hid ? "Unhide" : "Hide"),
                isCustom(a.id) ? el("button", { class: "btn btn--sm btn--ghost btn--danger", type: "button", onclick: function () {
                  if (confirm("Delete this custom activity?")) { deleteCustomActivity(a.id); renderAll(); toast("Deleted"); }
                } }, "Delete") : null
              ])
            ])
          ])
        ]));
      });
      tableWrap.appendChild(table);
    }
    var timer;
    search.addEventListener("input", function () { state.cmsSearch = search.value; state.cmsShowAll = false; clearTimeout(timer); timer = setTimeout(draw, 120); });
    draw();
  }

  function renderCmsTaxonomy() {
    var wrap = $("#cms-taxonomy");
    wrap.textContent = "";
    var banner = scopeBanner(); if (banner) wrap.appendChild(banner);
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
      if (state.tab === "appearance" && isAtLeastAdmin()) renderAppearance();
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
      state.repoFiltersExpanded = !state.repoFiltersExpanded;
      syncRepoFilterDensity();
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
    // Keep a staff member's roster current without a manual reload (e.g. an athlete reassigned
    // to them by an admin). Guarded + throttled inside autoRefreshRoster so it's non-disruptive.
    document.addEventListener("visibilitychange", autoRefreshRoster);
    window.addEventListener("focus", autoRefreshRoster);
    setInterval(autoRefreshRoster, 60000);
    var allStudentsSearch = $("#all-students-search");
    if (allStudentsSearch) {
      var allStudentsTimer;
      allStudentsSearch.addEventListener("input", function () {
        clearTimeout(allStudentsTimer);
        allStudentsTimer = setTimeout(function () { if (state.studentTab === "all") renderAllStudents(); }, 120);
      });
    }
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
    // "#/p/<slug>" deep-links to a builder page.
    var initial = (location.hash || "").replace("#", "");
    if (initial.indexOf("/p/") === 0) state.tab = "page:" + initial.slice(3);
    else if (initial.indexOf("cms") === 0) { state.tab = "appearance"; var seg0 = initial.split("/")[1]; if (seg0) state.cmsSection = seg0; }
    else if (initial) state.tab = initial;

    // Page-builder autosave: park dirty edits in the server-side working copy every
    // 20s, and warn before closing a tab with unsaved changes.
    setInterval(autosavePageDraft, 20000);
    window.addEventListener("beforeunload", function (e) {
      if (state.pageDraft && state.pageDraft.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    // Builder-page links (#/p/<slug>) navigate without a reload, signed in or out.
    window.addEventListener("hashchange", function () {
      var h = (location.hash || "").replace("#", "");
      // Deep-link into a CMS section (#cms/<section>) for signed-in super admins.
      if (h.indexOf("cms") === 0 && !$("#auth-gate") && isAtLeastAdmin()) {
        state.cmsSection = h.split("/")[1] || "dashboard";
        setTab("appearance");
        return;
      }
      if (h.indexOf("/p/") !== 0) return;
      var slug = h.slice(3);
      if ($("#auth-gate")) {
        var mount = $("#auth-landing");
        if (mount) renderLandingInto(mount, slug);
      } else {
        setTab("page:" + slug);
      }
    });

    configureRepoFilterDensity();
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
        return loadBaseActivities().then(loadServerSnapshot).then(function () {
          return Promise.all([loadAndApplySiteTheme(), loadSiteContent(), loadNavPages()]);
        }).then(function () {
          // Coach, admin and super admin all use the tabbed app; the tab set grows with
          // rank. Only athletes get the student view.
          var staff = state.session.role !== "athlete";
          state.view = staff ? "admin" : "student";
          // A super admin defaults to publishing scope, and Repository-tab flows read
          // the global-only snapshot (e.g. to preserve edit payloads when hiding) — so
          // load it up front rather than lazily on first Content-tab visit.
          if (isSuperadmin() && cmsGlobal()) loadGlobalTracking();
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
        loadSiteContent();   // rehydrates the gate's data-slot nodes once copy arrives
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
