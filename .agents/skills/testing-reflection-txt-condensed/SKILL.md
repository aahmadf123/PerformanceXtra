---
name: testing-reflection-txt-condensed
description: End-to-end test the PerformanceXtra student assignment-level reflection box, download-all-as-TXT export, and admin condensed completed-assignments view. Use when verifying these coach/student UI flows.
---

# Testing PerformanceXtra: reflection box, TXT export, condensed completed

The app is a single-page Cloudflare Worker + D1 app (vanilla JS in `app.js`). It is deployed to production at `https://performance-xtra.firas-azfar.workers.dev` and auto-deploys from `main` via Cloudflare Workers, so merged PRs can be tested directly on production (confirm with `curl .../app.js | grep <new-symbol>`).

## Roles & login

Full-screen "Sign in" gate: email + password/passcode. Two role types:
- **Coach/Admin** — sees Repository, Workout Builder, Students, Settings tabs.
- **Athlete/Student** — sees My Workouts, My Progress tabs.

Use the header user chip + "Log out" to switch roles. To review a student as admin, go to **Students** tab and click the student row ("○ Set active") so it becomes the active student; the right pane shows "<name> — Assignments".

## Devin Secrets Needed

No stored Devin secrets required. Test credentials are provided by the user per-session (coach login + per-student passcodes). If not provided, ask the user for the coach login and at least one student passcode. Do not hardcode them in the skill.

## Feature locations

- **Assignment-level reflection (student)**: bottom of each assignment card in My Workouts, labeled "YOUR REFLECTION FOR THIS ASSIGNMENT" (distinct from the per-activity "YOUR REFLECTION" box). Auto-saves with ~450ms debounce; status line shows "Not submitted yet" → "Saving..." → "Saved <timestamp>". Stored using sentinel `activity_id = "__assignment__"` in the reflections table.
- **Coach read-only view**: same reflection appears read-only under "STUDENT REFLECTION" with "Updated <timestamp>" in the admin Students → assignment card.
- **Download all as TXT**: "⬇ Download all as TXT" button in both the student My Workouts toolbar and the admin "<name> — Assignments" section header. Exports all assignments; assignment-level reflection appears under an `ASSIGNMENT REFLECTION:` section in the file.
- **Condensed completed (admin only)**: fully-completed assignments are hidden inside a `<details class="completed-assignments">` collapsible labeled "Completed assignments — N assignment(s)". In-progress assignments render directly. Student view is NOT condensed.

## Recommended end-to-end procedure

Use a unique marker string (e.g. `REFLECT-MARKER-42`) to prove data round-trips student → coach → TXT.

1. **Student submit**: log in as student → My Workouts → type marker into "YOUR REFLECTION FOR THIS ASSIGNMENT" → wait ~1s → confirm "Saved <timestamp>". Optionally click "Mark done" on all activities of one assignment so it reads "✓ All done" (sets up the condensed test).
2. **Coach read-only**: log out, log in as admin → Students → click student row → confirm the read-only "STUDENT REFLECTION" shows the marker + "Updated <timestamp>".
3. **TXT export**: click "⬇ Download all as TXT". The file lands in `~/Downloads/performancextra-<name>-all-assignments-<date>.txt`. Verify via shell: `grep -A2 "ASSIGNMENT REFLECTION" ~/Downloads/performancextra-*.txt` should show the marker.
4. **Condensed completed**: still as admin viewing the student, confirm the completed assignment is NOT a full inline card but inside the "Completed assignments" collapsible; click the summary to expand and reveal the card ("✓ All done").

## Tips & gotchas

- Verify the downloaded TXT with the shell `cat`/`grep` tool against `~/Downloads/` rather than eyeballing the browser download chip.
- The condensed collapsible only applies to the **admin** view — don't expect it in the student My Workouts view.
- If a feature appears missing, first confirm production actually serves the merged code (`curl .../app.js | grep <symbol>`) before assuming a bug; a stale cache or unmerged branch is a common cause.
- Test data may already exist for the test students; if no assignment exists, create one as the coach (Students → + New assignment) before testing.
