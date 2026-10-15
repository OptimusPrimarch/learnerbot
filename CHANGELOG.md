# Changelog

Each release has a **name** people see (1.0, 1.1, ...) and a **build id** the update check compares
(2026.10.9). The build id only ever goes up. The site and the sheet's script both report them, and
Settings shows "LearnerBot 1.0, build 2026.10.9".

## 1.0 · build 2026.10.9 · 2026-10-15

The first official release. Everything before it was private testing.

**Goals and tasks**
- Goals with priority, tags, sub-goals, an optional due date, and in-place editing
- Tasks under each goal; complete, postpone or remove anything and take it back for five seconds with Undo
- History of completed, postponed and removed goals

**The coach (Groq)**
- Daily focus built from your open tasks, recent log, goal age and deadlines
- Weekly review and a proposed plan for the next week
- Chat that can add goals, tasks, log entries and due dates in plain words
- Your own coach voice, stored exactly as you write it, with a handful of starting points
- Groq's occasional "bad JSON" answers are retried before you ever see an error

**Logging**
- Log what you did, with optional time in 15-minute steps and a "this week" total
- Daily streak

**Your data and access**
- Everything lives in your own Google Sheet; the site keeps nothing about you
- Phone connection by an emailed one-time link, with per-phone access you can revoke
- Optional email updates: daily focus, weekly review, evening nudge

**Keeping it current**
- The site tells you when your sheet's script is behind; **Update now** installs the new version in seconds,
  with **Go back** and a "Repair: use the built-in version" item in the sheet menu
- [update.html](update.html) is the by-hand fallback

**Also**
- Demo mode, installable on Android, instant open from the last saved dashboard
- Printable setup guide (PDF)
