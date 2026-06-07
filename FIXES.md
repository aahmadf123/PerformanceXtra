# PerformanceXtra — Pending Fixes

## 🐛 Bug Fix 1: Instructions Not Visible on Student Side

### Root Cause
The `renderWorkoutsPanel()` and the assignment item rendering in `renderStudentDetail()` use `.assign-item` rows that only show the activity name and a "Mark done" button. The `<details>` expand block (which shows Instructions and Reflection Prompt) is only rendered in the **repository card grid** (`buildCard()`), not in the student-facing assignment list.

### What to Change
In the main `<script>` block, find the function that builds each `.assign-item` row inside `renderWorkoutsPanel`. It looks roughly like:

```js
// CURRENT (broken) — no instructions shown
const row = document.createElement('div');
row.className = 'assign-item' + (done ? ' is-done' : '');
row.innerHTML = `
  <div class="ai-name"><strong>${esc(act.name)}</strong> ...</div>
  <button ...>Mark done</button>
`;
```

Replace it with a version that appends the instructions/reflection `<details>` block **after** the name row:

```js
// FIX — add instructions + reflection details block
const hasDetails = act.instructions || act.reflection;
const detailsHtml = hasDetails ? `
  <details class="detail" style="width:100%; margin-top:6px;">
    <summary>Instructions &amp; Reflection</summary>
    <div class="detail-block">
      ${act.instructions ? `
        <div class="detail-label">Instructions</div>
        <div class="detail-text">${esc(act.instructions)}</div>
      ` : ''}
      ${act.reflection ? `
        <div class="detail-label" style="margin-top:8px;">Reflection Prompt</div>
        <div class="detail-text">${esc(act.reflection)}</div>
      ` : ''}
    </div>
  </details>
` : '';

// Wrap name + details in a flex column inside ai-name
row.innerHTML = `
  <div class="ai-name" style="flex:1; display:flex; flex-direction:column; gap:4px;">
    <strong>${esc(act.name)}</strong>
    <span style="font-size:.76rem; color:var(--muted);">${esc(act.progression||'')} · ${esc(act.type||'')}${act.time ? ' · '+esc(act.time) : ''}</span>
    ${detailsHtml}
  </div>
  ${act.link ? `<a href="${esc(act.link)}" target="_blank" rel="noopener" class="btn btn--sm">Open ↗</a>` : ''}
  <button class="btn btn--sm done-btn" data-id="${esc(act.id)}" aria-pressed="${done}">${done ? '✓ Done' : 'Mark done'}</button>
`;
```

**Also apply the same fix** in the `renderStudentDetail()` panel on the coach/admin side — assignments shown there also lack instructions.

---

## ✨ Feature: Onboarding Tour (Admin + Student)

### Design
- A **lightweight step-by-step tooltip tour** that triggers on first visit (tracked via an in-memory flag, since localStorage is sandboxed)
- Separate tour flows for **Admin** (after logging in) and **Student** (after switching to student view)
- Each tooltip: highlighted element + arrow + title + description + Next/Skip buttons
- Tour re-launchable from a `?` help button in the header

### Admin Tour Steps (7 steps)
| Step | Target element | Message |
|------|---------------|----------|
| 1 | `.brand` | **Welcome to PerformanceXtra!** This is your coach dashboard for managing mental training activities and student athletes. |
| 2 | `#view-repo` tab | **Activity Repository** — Browse all 190+ mental training activities. Filter by topic, progression level, and content type. |
| 3 | `.filter-grid` | **Filters** — Narrow down activities by week, month, topic, or content type. Use search for keyword lookup. |
| 4 | `#view-builder` tab | **Workout Builder** — Auto-generate a personalized workout. Pick criteria like Month 1 + Confidence and get a ready-to-assign session. |
| 5 | `#view-students` tab | **Students** — Add your athletes here. Click a student name to view their assignments and progress. |
| 6 | `#student-select` | **Active Student selector** — Always pick the active student first. The Workout Builder will exclude activities they've already completed. |
| 7 | `#admin-login-btn` | **Security tip** — Go to Settings → Admin Passcode and change the default passcode before sharing this app with students. |

### Student Tour Steps (4 steps)
| Step | Target element | Message |
|------|---------------|----------|
| 1 | `.brand` | **Welcome!** Your coach has set up mental training activities just for you. |
| 2 | `#view-workouts` tab | **My Workouts** — Your assigned activities are here. Open each one to read the instructions. |
| 3 | `.assign-item:first-child details` | **Instructions** — Click the arrow to expand instructions and reflection prompts. Read them carefully before doing the activity. |
| 4 | `.done-btn:first-of-type` | **Mark Done** — After completing an activity, press this to record your progress. Your coach can see what you've finished. |

### Implementation Snippet

```js
// ---- Onboarding Tour ----
const TOUR_ADMIN = [
  { sel: '.brand', title: 'Welcome to PerformanceXtra!', text: 'This is your coach dashboard for managing mental training.' },
  { sel: '[data-tab="repo"]', title: 'Activity Repository', text: 'Browse all 190+ activities. Filter by topic, week, or content type.' },
  { sel: '.filter-grid', title: 'Filters', text: 'Narrow activities by progression (Week 1, Month 2, etc.), topic, or type.' },
  { sel: '[data-tab="builder"]', title: 'Workout Builder', text: 'Auto-generate a workout — pick "Month 1, Confidence" and get a tailored session.' },
  { sel: '[data-tab="students"]', title: 'Students', text: 'Add athletes, assign workouts, and track their progress from here.' },
  { sel: '#student-select', title: 'Active Student', text: 'Select a student first. The builder will skip activities they already completed.' },
  { sel: '[data-tab="settings"]', title: 'Security Tip', text: 'Change the default admin passcode in Settings before sharing with students!' },
];

const TOUR_STUDENT = [
  { sel: '.brand', title: 'Welcome!', text: "Your coach has assigned mental training activities just for you." },
  { sel: '[data-tab="workouts"]', title: 'My Workouts', text: 'Your assigned activities appear here. Open each one for instructions.' },
  { sel: '.done-btn', title: 'Mark Done', text: 'After completing an activity, press this button to record your progress.' },
  { sel: '[data-tab="progress"]', title: 'My Progress', text: 'See how far you have come — completions by topic and by week.' },
];

let tourStep = 0, tourSteps = [], tourActive = false;

function startTour(steps) {
  tourSteps = steps.filter(s => document.querySelector(s.sel));
  tourStep = 0;
  tourActive = true;
  showTourStep();
}

function showTourStep() {
  document.querySelector('.tour-overlay')?.remove();
  if (tourStep >= tourSteps.length) { tourActive = false; return; }
  const { sel, title, text } = tourSteps[tourStep];
  const target = document.querySelector(sel);
  if (!target) { tourStep++; showTourStep(); return; }
  const rect = target.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  overlay.innerHTML = `
    <div class="tour-backdrop"></div>
    <div class="tour-tip" style="top:${rect.bottom + window.scrollY + 12}px; left:${Math.max(8, rect.left)}px;">
      <strong>${title}</strong>
      <p>${text}</p>
      <div class="tour-actions">
        <button class="btn btn--sm" id="tour-skip">Skip tour</button>
        <button class="btn btn--sm btn--primary" id="tour-next">${tourStep < tourSteps.length-1 ? 'Next →' : 'Got it!'}</button>
      </div>
      <div class="tour-counter">${tourStep+1} / ${tourSteps.length}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('tour-next').onclick = () => { tourStep++; showTourStep(); };
  document.getElementById('tour-skip').onclick = () => { document.querySelector('.tour-overlay')?.remove(); tourActive = false; };
}

// CSS to add to <style>:
/*
.tour-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:900; }
.tour-tip {
  position:absolute; z-index:901; background:var(--surface); border-radius:var(--radius);
  padding:16px; max-width:320px; box-shadow:var(--shadow);
  border:2px solid var(--brand);
}
.tour-tip strong { display:block; font-size:1rem; margin-bottom:6px; }
.tour-tip p { font-size:.88rem; color:var(--ink-soft); margin:0 0 12px; }
.tour-actions { display:flex; gap:8px; justify-content:flex-end; }
.tour-counter { font-size:.72rem; color:var(--muted); text-align:right; margin-top:8px; }
*/

// Trigger tours:
// After admin login: startTour(TOUR_ADMIN);
// After student view: startTour(TOUR_STUDENT);
// Help button: document.getElementById('help-btn').onclick = () => startTour(isAdmin ? TOUR_ADMIN : TOUR_STUDENT);
```

---

## 🔘 Help Button (Header)

Add a `?` button to the header next to the role controls:

```html
<button class="btn btn--sm" id="help-btn" aria-label="Launch tutorial tour" title="Help / Tour">?</button>
```

Wire it up:
```js
document.getElementById('help-btn').addEventListener('click', () => {
  startTour(currentRole === 'admin' ? TOUR_ADMIN : TOUR_STUDENT);
});
```
