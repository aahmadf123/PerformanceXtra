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
  var ALL = [];   // every activity, including hidden — used for BY_ID lookups & admin management
  var DATA = [];  // visible activities — what students, the builder and filters see
  var BY_ID = {};
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
    ALL.forEach(function (a) { BY_ID[a.id] = a; });
    DATA = ALL.filter(function (a) { return !hidden[a.id]; });
    PRESENT = {
      topic: ordered(TAX.topics, distinctPresent("topic")),
      subtopic: ordered(TAX.subtopics, distinctPresent("subtopic")),
      type: ordered(TAX.types, distinctPresent("type")),
      progression: ordered(TAX.progressions, distinctPresent("progression")),
      frequency: ordered(TAX.frequencies, distinctPresent("frequency"))
    };
  }
  function isHidden(id) { return !!(state.tracking.hidden && state.tracking.hidden[id]); }
  function isCustom(id) { return /^CUST-/.test(id); }

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
  function loadServerSnapshot() {
    return api("/bootstrap").then(function (res) {
      if (!res.ok || !res.data) throw new Error("bootstrap failed (" + res.status + ")");
      var d = res.data;
      state.session = d.me;
      state.tracking = normalizeStore({
        students: d.students || {},
        activeStudentId: d.activeStudentId || (state.tracking && state.tracking.activeStudentId) || null,
        customActivities: d.customActivities || [],
        overrides: d.overrides || {},
        hidden: d.hidden || {}
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
  var DEFAULT_PASSCODE = "pxadmin";
  var storageOK = true;

  function emptyStore() {
    return {
      version: 2, activeStudentId: null, students: {},
      customActivities: [], overrides: {}, hidden: {},
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
      if (obj.settings && obj.settings.passcodeHash) s.settings.passcodeHash = obj.settings.passcodeHash;
    }
    // Every student needs a completed map and an assignments array.
    Object.keys(s.students).forEach(function (id) {
      var st = s.students[id];
      if (!st.completed || typeof st.completed !== "object") st.completed = {};
      if (!Array.isArray(st.assignments)) st.assignments = [];
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
  function isDone(activityId) { return !!completedMap()[activityId]; }

  // Mark/unmark an activity done for a student. Optimistically updates the in-memory
  // map (so the UI flips instantly), then persists: to the server (athlete only) in
  // SERVER mode, or to localStorage in LOCAL mode.
  function setCompletion(student, activityId, done, assignmentId) {
    if (!student) return;
    if (done) student.completed[activityId] = new Date().toISOString();
    else delete student.completed[activityId];
    if (SERVER) {
      api("/completions", { method: "POST", body: { activity_id: activityId, assignment_id: assignmentId || null, done: done } })
        .then(function (res) { if (!res.ok) toast(apiError(res, "Couldn't save — please retry")); })
        .catch(function () { toast("Couldn't reach the server"); });
    } else {
      saveTracking();
    }
  }

  function toggleComplete(activityId) {
    var s = activeStudent();
    if (!s) { toast("Select a student first"); return false; }
    // In SERVER mode only an athlete may complete their own activities (the coach
    // can't tick boxes on a student's behalf — the athlete does that themselves).
    if (SERVER && (!state.session || state.session.role !== "athlete")) {
      toast("Athletes mark their own activities done"); return false;
    }
    setCompletion(s, activityId, !s.completed[activityId], null);
    return true;
  }

  function addStudent(name) {
    name = (name || "").trim();
    if (!name) return null;
    var id = genId();
    students()[id] = { id: id, name: name, createdAt: new Date().toISOString(), completed: {}, assignments: [] };
    if (!state.tracking.activeStudentId) state.tracking.activeStudentId = id;
    saveTracking();
    return id;
  }

  /* ----------------------------- Assignments ----------------------------- */
  function studentAssignments(s) { return (s && Array.isArray(s.assignments)) ? s.assignments : []; }

  function addAssignment(studentId, title, note, activityIds) {
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
    saveTracking();
  }
  function assignmentProgress(s, asg) {
    var done = 0;
    asg.items.forEach(function (id) { if (s.completed[id]) done++; });
    return { done: done, total: asg.items.length };
  }

  // Create an assignment, routing to the server in SERVER mode. onDone runs on success.
  function createAssignmentFlow(studentId, title, note, ids, onDone) {
    if (SERVER) {
      api("/assignments", { method: "POST", body: { athlete_id: studentId, title: title, note: note, activity_ids: ids } })
        .then(function (res) {
          if (!res.ok) { toast(apiError(res, "Couldn't create assignment")); return; }
          refreshFromServer().then(function () { if (onDone) onDone(); });
        }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (addAssignment(studentId, title, note, ids)) { if (onDone) onDone(); }
    else { toast("Couldn't create assignment"); }
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
      api("/custom-activities", { method: "POST", body: { payload: payload } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save activity")); return; }
        refreshFromServer().then(function () { renderAll(); });
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
        path = "/custom-activities"; body = { payload: Object.assign({ id: id }, payload) };
      } else {
        path = "/overrides"; body = { activity_id: id, payload: fields, hidden: isHidden(id) };
      }
      api(path, { method: "POST", body: body }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't save changes")); return; }
        refreshFromServer().then(function () { renderAll(); });
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
      api("/overrides", { method: "POST", body: { activity_id: id, payload: null, hidden: false } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't revert")); return; }
        refreshFromServer().then(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    delete state.tracking.overrides[id]; saveStore(); rebuildData();
  }
  function setHidden(id, on) {
    if (SERVER) {
      // Preserve any existing edit payload while flipping the hidden flag.
      var payload = state.tracking.overrides[id] || null;
      api("/overrides", { method: "POST", body: { activity_id: id, payload: payload, hidden: !!on } }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't update")); return; }
        refreshFromServer().then(function () { renderRepo(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    if (on) state.tracking.hidden[id] = true; else delete state.tracking.hidden[id];
    saveStore(); rebuildData();
  }
  function deleteCustomActivity(id) {
    if (SERVER) {
      api("/custom-activities/" + encodeURIComponent(id), { method: "DELETE" }).then(function (res) {
        if (!res.ok) { toast(apiError(res, "Couldn't delete")); return; }
        refreshFromServer().then(function () { renderAll(); });
      }).catch(function () { toast("Couldn't reach the server"); });
      return;
    }
    state.tracking.customActivities = state.tracking.customActivities.filter(function (a) { return a.id !== id; });
    delete state.tracking.hidden[id];
    saveStore(); rebuildData();
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
    filters: { search: "", topic: "", subtopic: "", type: "", progression: "", frequency: "" },
    workout: { criteria: null, results: [] },
    tracking: loadStore()
  };
  rebuildData();
  saveStore();   // persist normalization / v1→v2 migration so it survives even if nothing else changes

  function isAdminView() { return state.view === "admin"; }

  /* ----------------------------- Repository ----------------------------- */
  function applyFilters() {
    var f = state.filters;
    var q = norm(f.search);
    // Admins can opt to see hidden activities (to unhide/edit them); everyone
    // else only ever sees the visible set.
    var source = (isAdminView() && state.showHidden) ? ALL : DATA;
    return source.filter(function (a) {
      if (f.topic && a.topic !== f.topic) return false;
      if (f.subtopic && (a.subtopics || []).indexOf(f.subtopic) === -1) return false;
      if (f.type && a.type !== f.type) return false;
      if (f.progression && a.progression !== f.progression) return false;
      if (f.frequency && a.frequency !== f.frequency) return false;
      if (q) {
        var hay = norm(a.name + " " + (a.topic || "") + " " + (a.subtopics || []).join(" "));
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function detailBlock(label, text) {
    return el("div", { class: "detail-block" }, [
      el("div", { class: "detail-label" }, label),
      el("div", { class: "detail-text" }, text)
    ]);
  }

  function createCard(a) {
    var hidden = isHidden(a.id);
    var card = el("article", { class: "card" + (isDone(a.id) ? " is-done" : "") + (hidden ? " is-hidden-activity" : ""), "data-id": a.id });

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

    var foot = el("div", { class: "card-foot" });
    if (a.link) {
      foot.appendChild(el("a", { class: "btn btn--sm btn--primary", href: a.link, target: "_blank", rel: "noopener" }, "Open resource ↗"));
    } else {
      foot.appendChild(el("span", { class: "no-link" }, "No link (on-court)"));
    }
    var hasStudent = !!activeStudent();
    var coachInServer = SERVER && (!state.session || state.session.role !== "athlete");
    var canComplete = hasStudent && !coachInServer;
    var done = isDone(a.id);
    var doneBtn = el("button", {
      class: "btn btn--sm done-btn",
      "aria-pressed": done ? "true" : "false",
      disabled: !canComplete,
      title: canComplete ? "" : (coachInServer ? "Athletes mark their own activities done" : "Add a student first"),
      onclick: function () {
        if (toggleComplete(a.id)) {
          var nowDone = isDone(a.id);
          doneBtn.setAttribute("aria-pressed", nowDone ? "true" : "false");
          doneBtn.textContent = nowDone ? "✓ Completed" : "Mark done";
          card.classList.toggle("is-done", nowDone);
          updateStudentCount();
        }
      }
    }, done ? "✓ Completed" : "Mark done");
    foot.appendChild(doneBtn);
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

  function readCriteria() {
    var scope = $("input[name=scope]:checked").value;
    return {
      scope: scope,
      month: scope === "month" ? Number($("#b-month").value) : null,
      week: scope === "week" ? Number($("#b-week").value) : null,
      topic: $("#b-topic").value,
      subtopic: $("#b-subtopic").value,
      type: $("#b-type").value,
      mix: $("#b-mix").checked,
      count: Math.max(1, Number($("#b-count").value) || 5),
      timeBudget: Number($("#b-time").value) || 0,
      excludeCompleted: $("#b-exclude").checked
    };
  }

  function candidatePool(c) {
    var pool = DATA.slice();
    if (c.scope === "month" && c.month) {
      var m = TAX.months.filter(function (x) { return x.value === c.month; })[0];
      var weeks = m ? m.weeks : [];
      pool = pool.filter(function (a) { return weeks.indexOf(a.week) !== -1; });
    } else if (c.scope === "week" && c.week) {
      pool = pool.filter(function (a) { return a.week === c.week; });
    } else if (c.scope === "extra") {
      pool = pool.filter(function (a) { return a.week == null; });
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

  function criteriaSummary(c) {
    var parts = [];
    if (c.scope === "month" && c.month) {
      var m = TAX.months.filter(function (x) { return x.value === c.month; })[0];
      parts.push(m ? m.label : "Month " + c.month);
    } else if (c.scope === "week" && c.week) parts.push("Week " + c.week);
    else if (c.scope === "extra") parts.push("Extra Activities");
    else parts.push("Any progression");
    if (c.topic) parts.push(c.topic);
    if (c.subtopic) parts.push(c.subtopic);
    if (c.type) parts.push(c.type);
    return parts.join(" · ");
  }

  function totalMinutes(list) {
    return list.reduce(function (sum, a) { return sum + (a.timeMinutes || 0); }, 0);
  }

  function generateWorkout() {
    var c = readCriteria();
    var pool = candidatePool(c);
    var results = selectWorkout(pool, c);
    state.workout = { criteria: c, results: results, poolSize: pool.length };
    $("#regenerate-btn").disabled = results.length === 0;
    renderWorkout();
  }

  function renderWorkout() {
    var out = $("#workout-output");
    out.textContent = "";
    var w = state.workout;
    if (!w.criteria) {
      out.appendChild(el("div", { class: "empty-state", id: "workout-empty" }, [
        el("h3", {}, "No workout yet"),
        el("p", {}, "Set your criteria and press Generate workout.")
      ]));
      return;
    }
    if (!w.results.length) {
      out.appendChild(el("div", { class: "empty-state" }, [
        el("h3", {}, "No activities match"),
        el("p", {}, "No activities fit those criteria. Try a broader scope or a different topic.")
      ]));
      return;
    }

    out.appendChild(el("h3", {}, "Your Workout"));
    out.appendChild(el("div", { class: "workout-meta" }, [
      el("span", {}, [el("b", {}, w.results.length + " "), "activities"]),
      el("span", {}, [el("b", {}, "~" + totalMinutes(w.results) + " min "), "estimated"]),
      el("span", {}, criteriaSummary(w.criteria))
    ]));

    if (w.results.length < w.criteria.count) {
      out.appendChild(el("div", { class: "warn" },
        "Only " + w.results.length + " of " + w.criteria.count + " requested activities matched these criteria."));
    }

    var exportBar = el("div", { class: "export-bar" }, [
      el("button", { class: "btn btn--sm", onclick: function () { window.print(); } }, "🖨 Print"),
      el("button", { class: "btn btn--sm", onclick: copyWorkout }, "📋 Copy"),
      el("button", { class: "btn btn--sm", onclick: downloadWorkout }, "⬇ Download .txt")
    ]);
    if (isAdminView()) {
      exportBar.appendChild(el("button", {
        class: "btn btn--sm btn--accent",
        onclick: function () { openAssignModal(w.results.map(function (a) { return a.id; }), criteriaSummary(w.criteria)); }
      }, "👤 Assign to student"));
    }
    out.appendChild(exportBar);

    var listWrap = el("div", {});
    w.results.forEach(function (a, idx) {
      var sub = el("div", { class: "workout-sub" }, [
        el("span", {}, a.type || "—"),
        a.time ? el("span", {}, a.time) : null,
        el("span", {}, a.topic || ""),
        a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener" }, "Open ↗") : el("span", { class: "no-link" }, "No link (on-court)")
      ]);
      var body = el("div", { class: "workout-body" }, [
        el("div", { class: "workout-title" }, a.name),
        sub
      ]);
      if (a.instructions) {
        var d = el("details", { class: "detail" }, el("summary", {}, "Instructions"));
        d.appendChild(detailBlock("Instructions", a.instructions));
        body.appendChild(d);
      }
      listWrap.appendChild(el("div", { class: "workout-item" }, [
        el("div", { class: "workout-num" }, String(idx + 1)),
        body
      ]));
    });
    out.appendChild(listWrap);
  }

  function workoutToText() {
    var w = state.workout;
    var lines = [];
    lines.push("PERFORMANCEXTRA — MENTAL WORKOUT");
    lines.push(criteriaSummary(w.criteria));
    lines.push(w.results.length + " activities · ~" + totalMinutes(w.results) + " min");
    lines.push("");
    w.results.forEach(function (a, i) {
      lines.push((i + 1) + ". " + a.name + "  [" + (a.type || "—") + (a.time ? ", " + a.time : "") + "]");
      lines.push("   Link: " + (a.link || "No link (on-court)"));
      if (a.instructions) lines.push("   Instructions: " + a.instructions.replace(/\n/g, "\n      "));
      lines.push("");
    });
    return lines.join("\n");
  }

  function copyWorkout() {
    var text = workoutToText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Workout copied to clipboard"); },
        function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = el("textarea", {}, text);
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Workout copied"); }
    catch (e) { toast("Copy not supported — use Download instead"); }
    document.body.removeChild(ta);
  }
  function downloadWorkout() {
    downloadFile("performancextra-workout.txt", workoutToText(), "text/plain");
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
    if (asg.note) area.appendChild(el("p", { class: "pa-note" }, asg.note));
    var ol = el("ol", { class: "pa-list" });
    asg.items.forEach(function (id) {
      var a = BY_ID[id];
      if (!a) return;
      var li = el("li", {});
      li.appendChild(el("div", { class: "pa-name" }, a.name + (a.time ? " (" + a.time + ")" : "") + (student.completed[id] ? "  ✓ done" : "")));
      var meta = [a.type, a.topic, a.progression, a.frequency].filter(Boolean).join(" · ");
      if (meta) li.appendChild(el("div", { class: "pa-meta" }, meta));
      if (a.link) li.appendChild(el("div", { class: "pa-link" }, a.link));
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
      if (SERVER && s.pending) nameKids.push(el("span", { class: "pill pill--pending", title: "Hasn't set a password yet" }, "Invite pending"));
      var row = el("div", { class: "student-row" + (active ? " is-active" : "") }, [
        el("button", {
          class: "btn btn--sm btn--ghost", title: "Set active",
          "aria-pressed": active ? "true" : "false",
          onclick: function () { setActiveStudent(s.id); renderAll(); }
        }, active ? "● Active" : "○ Set active"),
        el("span", { class: "name-wrap" }, nameKids)
      ]);
      if (SERVER) {
        // Athletes manage their own accounts via invite; offer a copyable link instead.
        row.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Copy invite link", "aria-label": "Copy invite link for " + s.name, onclick: function () { reissueInvite(s); } }, "🔗 Invite"));
      } else {
        row.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Rename", "aria-label": "Rename " + s.name, onclick: function () {
          var name = prompt("Rename student", s.name);
          if (name) { renameStudent(s.id, name); renderAll(); }
        } }, "✎"));
        row.appendChild(el("button", { class: "btn btn--sm btn--ghost btn--danger", title: "Delete", "aria-label": "Delete " + s.name, onclick: function () {
          if (confirm("Delete " + s.name + " and their progress?")) { deleteStudent(s.id); renderAll(); }
        } }, "✕"));
      }
      list.appendChild(row);
    });

    renderStudentDetail();
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
    var p = computeProgress(s);
    var pct = DATA.length ? Math.round(p.total / DATA.length * 100) : 0;
    container.appendChild(el("div", { class: "progress-stat" }, [
      el("span", { class: "big" }, String(p.total)),
      el("span", {}, "of " + DATA.length + " activities completed (" + pct + "%)")
    ]));
    container.appendChild(el("div", { class: "progress-bar" }, el("span", { style: "width:" + pct + "%" })));

    if (p.total) {
      container.appendChild(el("div", { class: "breakdown" }, [
        el("div", {}, [el("div", { class: "detail-label", style: "margin-bottom:8px" }, "By topic"), bars(p.byTopic)]),
        el("div", {}, [el("div", { class: "detail-label", style: "margin-bottom:8px" }, "By progression"), bars(p.byWeek)])
      ]));

      container.appendChild(el("div", { class: "detail-label", style: "margin-bottom:8px" }, "Completed activities"));
      var cl = el("div", { class: "completed-list" });
      Object.keys(s.completed)
        .sort(function (a, b) { return (s.completed[b] || "").localeCompare(s.completed[a] || ""); })
        .forEach(function (aid) {
          var a = BY_ID[aid];
          if (!a) return;
          var canUndo = !SERVER || (state.session && state.session.role === "athlete");
          cl.appendChild(el("div", { class: "completed-row" }, [
            el("span", { class: "badge", "data-type": a.type || "" }, a.type || "—"),
            el("span", { class: "c-name" }, a.name),
            canUndo ? el("button", { class: "btn btn--sm btn--ghost", title: "Un-complete", onclick: function () {
              setCompletion(s, aid, false, null); renderAll();
            } }, "Undo") : null
          ]));
        });
      container.appendChild(cl);
    } else {
      container.appendChild(el("p", { class: "no-link" }, "No activities completed yet."));
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
        : "No workouts assigned yet — browse the Repository to explore on your own."));
      return;
    }
    list.forEach(function (asg) {
      var prog = assignmentProgress(s, asg);
      var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
      var complete = prog.total > 0 && prog.done === prog.total;
      var card = el("div", { class: "assignment" });

      var actions = el("div", { class: "assignment-actions" });
      actions.appendChild(el("button", { class: "btn btn--sm btn--ghost", title: "Print / Save as PDF", "aria-label": "Print assignment", onclick: function () { printAssignment(s, asg); } }, "🖨"));
      if (opts.admin) {
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
      card.appendChild(el("div", { class: "assignment-head" }, [
        el("div", {}, [
          el("div", { class: "assignment-title" }, asg.title),
          asg.note ? el("div", { class: "assignment-note" }, asg.note) : null,
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
        if (a.link) item.appendChild(el("a", { class: "btn btn--sm", href: a.link, target: "_blank", rel: "noopener" }, "Open ↗"));
        if (opts.actionable) {
          var btn = el("button", { class: "btn btn--sm done-btn", "aria-pressed": done ? "true" : "false", onclick: function () {
            setCompletion(s, id, !s.completed[id], asg.id);
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
        card.appendChild(item);
      });
      container.appendChild(card);
    });
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
    detail.appendChild(el("div", { class: "section-head" }, [
      el("h3", {}, s.name + " — Assignments"),
      el("button", { class: "btn btn--sm btn--accent", onclick: function () { openAssignBuilderModal(s.id); } }, "+ New assignment")
    ]));
    appendAssignmentList(detail, s, { admin: true });

    detail.appendChild(el("h3", { style: "margin:24px 0 14px" }, "Progress"));
    appendProgress(detail, s);
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
      c.textContent = Object.keys(s.completed).length + " / " + DATA.length + " done";
    } else { c.textContent = ""; }
  }

  /* ----------------------------- Tabs / role ----------------------------- */
  function currentTabs() {
    return isAdminView()
      ? [{ id: "repo", label: "Repository" }, { id: "builder", label: "Workout Builder" },
         { id: "students", label: "Students" }, { id: "settings", label: "Settings" }]
      : [{ id: "workouts", label: "My Workouts" }, { id: "repo", label: "Repository" },
         { id: "progress", label: "My Progress" }];
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

    if (SERVER) {
      // Real, server-trusted session: no client passcode, no coach "preview".
      var role = state.session ? state.session.role : "athlete";
      var name = state.session ? state.session.name : "";
      $("#admin-login-btn").hidden = true;
      $("#student-view-btn").hidden = true;
      $("#logout-btn").hidden = false;
      $("#preview-banner").hidden = true;
      if (role === "coach") { badge.textContent = "Coach" + (name ? " · " + name : ""); badge.classList.remove("is-student"); }
      else { badge.textContent = name || "Athlete"; badge.classList.add("is-student"); }
      applyServerChrome();
      renderTabs();
      setTab(state.tab);
      return;
    }

    var authed = isAuthed();
    var preview = authed && !isAdminView();
    $("#admin-login-btn").hidden = authed;
    $("#student-view-btn").hidden = !isAdminView();
    $("#logout-btn").hidden = !isAdminView();
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
      info.appendChild(detailBlock("Signed in as", state.session.name + (state.session.role === "coach" ? " · coach" : " · athlete")));
    }
  }

  function goAdmin() { state.view = "admin"; state.tab = "repo"; applyRole(); renderAll(); }
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
    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Assign to"), sel]),
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]),
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
        });
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
      var q = norm(search.value);
      listWrap.textContent = "";
      var matches = DATA.filter(function (a) {
        if (!q) return true;
        return norm(a.name + " " + (a.topic || "") + " " + (a.subtopics || []).join(" ")).indexOf(q) !== -1;
      }).slice(0, 200);
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

    var quick = null;
    if (state.workout && state.workout.results && state.workout.results.length) {
      quick = el("button", { class: "btn btn--sm", type: "button", onclick: function () {
        state.workout.results.forEach(function (a) { selected[a.id] = true; });
        if (!title.value) title.value = criteriaSummary(state.workout.criteria);
        refresh(); updateCount(); toast("Added last generated workout");
      } }, "↪ Use last generated workout");
    }

    var body = el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Note (optional)"), note]),
      quick,
      el("div", { class: "field" }, [el("label", {}, "Add activities"), search]),
      listWrap, countEl
    ]);
    search.addEventListener("input", refresh);
    openModal("New assignment for " + s.name, body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create assignment", accent: true, onClick: function () {
        var ids = Object.keys(selected);
        if (!ids.length) { toast("Pick at least one activity"); return; }
        createAssignmentFlow(studentId, title.value, note.value, ids, function () { closeModal(); renderAll(); toast("Assignment created"); });
      } }
    ]);
    refresh();
  }

  // Add a new custom activity, or edit an existing one (built-in edits go to an override layer).
  function openActivityModal(id) {
    var editing = id ? BY_ID[id] : null;
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
      field("Subtopics", "subtopics", { placeholder: "Calmness, Focus" }, false, "Separate multiple with commas."),
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
      dl("dl-topics", PRESENT.topic), dl("dl-types", PRESENT.type),
      dl("dl-progressions", PRESENT.progression), dl("dl-frequencies", PRESENT.frequency)
    ]);
    function save() {
      var form = {};
      Object.keys(f).forEach(function (k) { form[k] = f[k].value; });
      if (!String(form.name || "").trim()) { toast("Name is required"); f.name.focus(); return; }
      if (editing) saveActivityEdit(id, form); else addCustomActivity(form);
      closeModal(); refreshSelects(); renderRepo();
      toast(editing ? "Activity updated" : "Activity added");
    }
    openModal(editing ? "Edit activity" : "Add activity", body, [
      { label: "Cancel", onClick: closeModal },
      (editing && isCustom(id)) ? { label: "Delete", danger: true, onClick: function () {
        if (confirm("Delete this custom activity?")) { deleteCustomActivity(id); closeModal(); refreshSelects(); renderRepo(); toast("Deleted"); }
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
  function showAuthGate() {
    if ($("#auth-gate")) return;
    var card = el("div", { class: "auth-card" });
    var root = el("div", { class: "auth-gate", id: "auth-gate", role: "dialog", "aria-modal": "true", "aria-label": "Sign in" }, card);
    document.body.appendChild(root);
    var invite = getQueryParam("invite");
    if (invite) renderAcceptForm(card, invite);
    else renderLoginForm(card);
  }
  function renderLoginForm(card) {
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
    card.appendChild(el("div", { class: "form-stack" }, [
      el("div", { class: "field" }, [el("label", { for: "auth-email" }, "Email"), email]),
      el("div", { class: "field" }, [el("label", { for: "auth-pass" }, "Password"), pass]),
      errBox,
      el("button", { class: "btn btn--primary btn--block", onclick: submit }, "Sign in"),
      setupRow
    ]));
    [email, pass].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }); });
    setTimeout(function () { email.focus(); }, 30);
    api("/setup-status").then(function (res) {
      setupRow.textContent = "";
      if (res.ok && res.data && res.data.needsSetup) {
        setupRow.appendChild(document.createTextNode("First time here? "));
        setupRow.appendChild(el("a", { href: "#", onclick: function (e) { e.preventDefault(); renderSetupForm(card); } }, "Create the coach account"));
      } else {
        setupRow.textContent = "Athletes: open the invite link your coach sent you.";
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
    card.appendChild(el("h3", { class: "auth-title" }, "Create your coach account"));
    card.appendChild(el("p", { class: "field-hint" }, "This is the first account on this site — it becomes the head coach. Athletes get added later by invite."));
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

  // Coach: add an athlete and receive a private invite link to send them (T7).
  function openAddAthleteModal(prefillName) {
    var name = el("input", { type: "text", value: prefillName || "", placeholder: "Athlete's name" });
    var email = el("input", { type: "email", placeholder: "their@email.com", autocomplete: "off" });
    var errBox = el("div", { class: "warn" }); errBox.hidden = true;
    var body = el("div", { class: "form-stack" }, [
      el("p", { class: "field-hint" }, "We'll create the athlete and give you a private invite link to send them. They set their own password — there's no shared passcode to leak."),
      el("div", { class: "field" }, [el("label", {}, "Name"), name]),
      el("div", { class: "field" }, [el("label", {}, "Email"), email]),
      errBox
    ]);
    function submit() {
      errBox.hidden = true;
      var nm = name.value.trim(), em = email.value.trim();
      if (!nm || !em) { errBox.textContent = "Name and email are both required."; errBox.hidden = false; return; }
      api("/athletes", { method: "POST", body: { name: nm, email: em } }).then(function (res) {
        if (!res.ok) { errBox.textContent = apiError(res, "Couldn't add athlete."); errBox.hidden = false; return; }
        closeModal();
        refreshFromServer().then(function () { renderAll(); showInviteModal(res.data); });
      }).catch(function () { errBox.textContent = "Couldn't reach the server."; errBox.hidden = false; });
    }
    openModal("Add athlete", body, [
      { label: "Cancel", onClick: closeModal },
      { label: "Create & get invite link", accent: true, onClick: submit }
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }
  function showInviteModal(data) {
    var url = (data && data.inviteUrl) || "";
    var who = (data && data.athlete && data.athlete.name) || "your athlete";
    var link = el("input", { type: "text", value: url, readonly: true });
    link.addEventListener("focus", function () { this.select(); });
    var body = el("div", { class: "form-stack" }, [
      el("p", {}, "Send this private link to " + who + ". They'll open it, set a password, and land on their workouts."),
      el("div", { class: "field" }, [el("label", {}, "Invite link"), link]),
      el("p", { class: "field-hint" }, "The link works once, and expires in 14 days. You can re-issue it later from the athlete's row.")
    ]);
    openModal("Athlete invite link", body, [
      { label: "Copy link", primary: true, onClick: function () { copyText(url).then(function (ok) { toast(ok ? "Invite link copied" : "Couldn't copy — select it manually"); }); } },
      { label: "Done", onClick: closeModal }
    ]);
    setTimeout(function () { link.focus(); link.select(); }, 30);
  }
  function reissueInvite(s) {
    api("/athletes/" + encodeURIComponent(s.id) + "/reinvite", { method: "POST" }).then(function (res) {
      if (!res.ok) { toast(apiError(res, "Couldn't create invite")); return; }
      refreshFromServer().then(function () { renderStudents(); });
      showInviteModal({ athlete: { name: s.name }, inviteUrl: res.data.inviteUrl });
    }).catch(function () { toast("Couldn't reach the server"); });
  }
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
    fillSelect($("#f-subtopic"), PRESENT.subtopic, "All subtopics"); $("#f-subtopic").value = f.subtopic;
    fillSelect($("#f-type"), PRESENT.type, "All types"); $("#f-type").value = f.type;
    fillSelect($("#f-progression"), PRESENT.progression, "All progressions"); $("#f-progression").value = f.progression;
    fillSelect($("#f-frequency"), PRESENT.frequency, "All frequencies"); $("#f-frequency").value = f.frequency;
    fillSelect($("#b-topic"), PRESENT.topic, "Any topic");
    fillSelect($("#b-subtopic"), PRESENT.subtopic, "Any subtopic");
    fillSelect($("#b-type"), PRESENT.type, "Any type");
  }

  function renderAll() {
    renderStudentPicker();
    renderRepo();
    if (isAdminView()) {
      renderWorkout();
      renderStudents();
    } else {
      renderWorkoutsTab();
      renderProgressTab();
    }
  }

  /* ----------------------------- Init ----------------------------- */
  function init() {
    if (!storageOK) $("#storage-warning").hidden = false;
    $("#total-count").textContent = DATA.length;

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
    [["topic", "f-topic"], ["subtopic", "f-subtopic"], ["type", "f-type"], ["progression", "f-progression"], ["frequency", "f-frequency"]]
      .forEach(function (pair) {
        $("#" + pair[1]).addEventListener("change", function (e) { state.filters[pair[0]] = e.target.value; renderRepo(); });
      });
    $("#clear-filters").addEventListener("click", clearFilters);
    $("#filters-toggle").addEventListener("click", function () {
      var bar = $("#filter-bar");
      var collapsed = bar.classList.toggle("is-collapsed");
      this.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

    // Builder
    fillSelect($("#b-topic"), PRESENT.topic, "Any topic");
    fillSelect($("#b-subtopic"), PRESENT.subtopic, "Any subtopic");
    fillSelect($("#b-type"), PRESENT.type, "Any type");
    var bMonth = $("#b-month"); bMonth.textContent = "";
    TAX.months.forEach(function (m) { bMonth.appendChild(option(m.value, m.label)); });
    var bWeek = $("#b-week"); bWeek.textContent = "";
    TAX.progressions.filter(function (p) { return /week/i.test(p); }).forEach(function (p) {
      bWeek.appendChild(option(p.replace(/\D+/g, ""), p));
    });
    $all("input[name=scope]").forEach(function (r) {
      r.addEventListener("change", function () {
        var v = $("input[name=scope]:checked").value;
        $("#month-field").hidden = v !== "month";
        $("#week-field").hidden = v !== "week";
      });
    });
    $("#builder-form").addEventListener("submit", function (e) { e.preventDefault(); generateWorkout(); });
    $("#regenerate-btn").addEventListener("click", generateWorkout);

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
        return loadServerSnapshot().then(function () {
          state.view = state.session.role === "coach" ? "admin" : "student";
          if (!location.hash) state.tab = state.session.role === "coach" ? "repo" : "workouts";
          refreshSelects();
          applyRole();
          renderAll();
          maybeAutoTour();
        });
      }
      if (res.status === 401) {
        // The API is live but we're signed out → show the login / invite gate.
        SERVER = true;
        showAuthGate();
        return;
      }
      // Some other status (e.g. 404 from static hosting) → no backend here.
      runLocalMode();
    }).catch(runLocalMode);   // network error → offline/static
  }
  function runLocalMode() {
    SERVER = false;
    state.view = isAuthed() ? "admin" : "student";
    applyRole();
    renderAll();
    maybeDefaultPasscodeNudge();
    maybeAutoTour();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
