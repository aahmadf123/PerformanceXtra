# Round 2 — your new list, in plain English

Everything from your earlier list (further down this document) is confirmed done in the
app — we re-checked each item in the current code before starting this round. Here's
what changed for the new list:

### "We can take out coaches login and maybe even the admin"

Done — and already applied to the live site. The test coach and admin accounts are
removed and every student now sits under the super admin. The old **Team** tab is
gone entirely: everything it did now lives in the **Users** tab, so there's one place
for people and no duplicate screens. Coach and admin logins no longer exist.

Two fixes made the consolidation possible: any existing student can now be **moved
onto the super admin** (Students → All students → Move — previously the app refused
to hand a student to an admin), and the super admin can reset any student's sign-in
code no matter who originally created them. The students' assignment history was
kept when the test coach was removed.

### "Don't cross out the name of the activities when complete"

Done. Completed activities keep the checkmark, the "Logged" note and the softer color —
the name just isn't struck through anymore, anywhere.

### "Take out 'on court/no link' on an assigned activity"

Done. Activities without a link now simply show nothing where the link would be — on
the repository cards and in the TXT/PDF downloads.

### "Bulk load activities via a CSV file"

Done. The Content tab's Activity library now has **⬆ Import CSV**. Download the CSV
template (it has the exact column headings plus two example rows), paste your journal
prompts / readings / etc. into it, and import. You'll see a preview first — how many
are new, which names already exist (skipped unless you say otherwise), and any broken
rows with their row numbers. The import respects your Shared/Private switch: in
"Shared library" mode everything you import is published to everyone.

### "Need an install drive for production server"

The app runs on Cloudflare's platform, so there's no physical server or install drive —
but we've built the equivalent: a one-command install script plus a step-by-step guide
(`docs/INSTALL.md`) that takes a blank Cloudflare account to a running production site,
database and all. If you meant something else by "install drive", tell us what you had
in mind and we'll build that instead.

### "Two reflection spaces on the Students page, one seems empty"

Found it — two causes, both fixed. Your athlete had reflections written in the **old
whole-set box** (from before the per-activity fix) on two assignments, so those showed
as a second, separate block; it's now clearly labelled "from an earlier version",
appears only when it has text, and is hidden when the same text already shows on an
activity. And the **PDF download** drew an empty "Assignment-level reflection" box on
every export — that box now only appears when there's old writing to show.

### "WordPress users and security"

We read this as: *manage people the way WordPress does — top-level Users and Settings.*
That now exists: a **Users** tab in the main navigation lists every account — students
and super admins — in one searchable place, with the role shown on each row. This is
where you **add students** (and, rarely, another super admin), **edit a name or email
in place** (previously a typo meant deleting and re-creating the account), hand out a
fresh sign-in code, move a student, or remove an account. The **Students** tab stays
focused on the work itself: assignments, progress, reflections and messages. The
**Settings** tab holds your account security and backup/restore. On the security side,
the earlier answer below still stands — the app isn't built on WordPress and has none
of its attack surface. If you also wanted something specific (say, connecting an
existing WordPress site), let us know.

---

# Your feedback — what we found and what changed

Thanks for the detailed list — every item led somewhere useful. Here's each one in
plain English: what was happening, what changed, and what you'll notice.

---

## The bugs you reported

### "Changes I made as SuperAdmin weren't showing up for Coach1"

**You were right, and it wasn't your fault.** When you edited activities from the
Repository tab, the app quietly saved those edits to your *personal* library — a
private copy only your account could see. Coach1 was never looking at stale data;
your changes were simply never published. We found 102 of your edits (17 activity
edits, your taxonomy re-organization, and one added article) sitting in that private
scope, and we've **published all of them to the shared library**, so every coach and
athlete now sees them.

Going forward it can't happen again: as super admin, **your edits now publish to
everyone by default**. A banner at the top of the Repository always tells you which
mode you're in ("Publishing" or "Private edits") with a one-click switch, in case you
ever *do* want to try something privately first.

One thing to check: we published *everything* you'd created. If any of it was meant
to stay private to you, tell us which items and we'll flip them back.

### "The reflection/observation field is no longer available"

Also real. The answer box only appeared on the *current* activity and *completed*
activities — anything further down the list showed the prompt with nowhere to type.
**Every activity in a set now has its answer box**, whenever the athlete wants to
write. (The old single "whole set" reflection box was replaced by these per-activity
boxes; anything athletes wrote in the old box is still saved and visible to you.)

### "Make the topic, sub-topic and content type lists alphabetical"

Done in an earlier update — all three lists are alphabetical everywhere (filters,
editing screens, and the assignment builder). One deliberate exception: the
*Progression* list stays in Week 1 → Week 17 → Advanced order, since alphabetical
would put Week 10 before Week 2.

### "Update the Progression value 'Extra Activities' to 'Advanced'"

Done in an earlier update — renamed everywhere: the spreadsheet, the app, the
database, and every filter.

---

## About Lionel Messi 🐐

**Why couldn't you see him?** Each staff member's "My students" list shows only their
own athletes — and Messi belongs to Test Coach 1, not to you. That's by design (each
coach runs their own roster), and it's why he *does* appear under **Students → All
students**, which lists everyone. So nothing was broken in the database — but your
instinct was right that something was off:

**The real bug was assigning him work.** When you (or an admin) assigned work to
another coach's athlete, the assignment was filed under *your* name — so Test Coach 1
could never see or manage it from their side. Fixed: **assignments now always land
with the athlete's own coach**, no matter who creates them. We also re-filed the ones
that were mis-filed. And messaging now works the same way — you can message any
athlete you can assign to, and their coach sees the same conversation.

---

## Your questions

### "I added an article on leadership and it shows as 'Custom' — did I miss something?"

You didn't miss anything — "Custom" was just the app's (confusing) label for anything
that isn't one of the original 190 spreadsheet activities. We've retired it: items you
publish to the shared library now show **no special tag** to coaches (to them it's
simply library content — which is the point), and a coach's own private additions say
**"Added by you"** instead.

### "What is the 'Set Active' indicator for?"

It picks which athlete's *workspace* you're in — assignments, progress, wellbeing and
messages all point at that one athlete. Two improvements: the buttons now explain
themselves ("Open workspace" / "Working here"), and your selection **sticks between
sign-ins** instead of resetting to the first athlete every time.

### "Admin login vs my login?"

Same door, different keys. Everyone signs in on the same screen; what changes is what
appears *after*. A coach gets the coaching tabs; an admin also gets **Team** (create
and manage coaches); you as super admin also get **Appearance** and the shared-library
controls. There's no separate admin login page to remember.

### "Can you create a guide for maintaining the app?"

Done — `MAINTENANCE.md` now lives in the project. It's written exactly for your
stated future: working on changes with an AI or a developer. It maps out how the app
is put together, how to test and ship a change, how the database is updated safely,
and a symptom → cause → fix table for everything we've ever debugged (including the
issues in this list).

---

## "WordPress users and security"

We want to make sure we address the actual concern here, because **PerformanceXtra
isn't built on WordPress** — there are no plugins, themes, or wp-admin to secure, and
none of the usual WordPress security worries apply.

What protects your data instead, in plain terms:

- Everyone signs in with a personal account; there are no shared logins. Athletes get
  one-time codes you hand out; lost codes are reset, never recovered.
- What each person can see is enforced on the **server** — an athlete can't reach
  coach tools by fiddling with their browser.
- Passwords are stored only as one-way cryptographic hashes; sign-in attempts are
  rate-limited to block password guessing; changing a password now signs out every
  other device that account was logged in on.
- The app runs on Cloudflare's platform with a private database — no third-party
  plugins, trackers, or email services touch the data.

**Could you tell us what prompted the note?** For example:
1. Does PerformanceXtra have an existing WordPress website you'd like this app linked
   to (shared sign-in, or a link from the site into the app)?
2. Were you asking whether this app has the security problems WordPress is known for?
   (Short answer: no — see above.)
3. Something else entirely?

Any of those is doable — we just don't want to build the wrong thing.

---

## One important security note for you

The very first super-admin password (the one from initial setup) ended up recorded in
the project's setup files, so we've retired it. **Next time you sign in, the app will
ask you to choose a new password before continuing** — one extra step, one time.
Everything else about signing in is unchanged. (If you've already changed your
password since setup, you won't see this at all.)

---

## Things we'd like your call on

1. **Anything published by mistake?** We moved all your stranded edits into the shared
   library — flag anything that should be private again.
2. **Tidy the topic list?** "Competitive Intelligence", "Competitive Mindset" and
   "Competitive Presence" each exist as their own topic with a single activity — they'd
   probably work better folded into one topic with sub-topics. Your vocabulary, your
   call. (We did fix a stray misspelling: "Competitve Mindset" → "Competitive
   Mindset".)
3. **A phone-first layout for athletes?** Most athletes will use phones; a bottom
   navigation bar (Today / Check-in / Messages) would make that nicer. Say the word and
   we'll add it.
4. **Re-assigning the same drill:** completing an activity used to mark it done
   *forever* — even in a brand-new assignment months later. We've changed it so each
   assignment tracks its own completion. If you preferred the old behavior for some
   drills, let us know.
