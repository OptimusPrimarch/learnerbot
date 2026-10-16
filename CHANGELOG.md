# Changelog

Each release has a **name** people see (1.0, 1.1, ...) and a **build id** the update check compares
(2026.10.11). The build id only ever goes up. The site and the sheet's script both report them, and
Settings shows "LearnerBot 1.2, build 2026.10.11".

## 1.2 · build 2026.10.11 · 2026-10-16

**A Custom theme**
- Settings > Look > Custom: pick a **primary** color (the page background) and a **secondary** color (buttons and highlights)
  and the cards, borders, text and status colors are worked out from them. Text always stays readable: a color that would
  make it hard to read is nudged just far enough
- Six ready-made color schemes: LearnerBot (navy and gold, from the new icon), Forest, Plum, Ocean, Sand and Cloud
- The primary color is saved in your sheet with the rest of your look; text size is still per device

**A new look for LearnerBot itself**
- New icon (a little robot wearing an open book) for the browser tab, the Android and iPhone home screens, the app header,
  the welcome card, link previews and the setup guide's cover

**Needs the script update:** yes, to save the Custom theme in your sheet (the icon alone is site only). Press **Update now**.
Until then, a Custom look is kept on that device.

## 1.1 · build 2026.10.10 · 2026-10-15

**Look**
- Three themes: Dark (as before), Light and High contrast
- Accent color: eight ready-made colors, a color picker, or the theme's own. A color that would be hard to read on
  the chosen theme is nudged until it is readable, and button text switches between dark and light to match
- Font: six choices (System, Humanist, Serif, Wide and clear, Monospace, Rounded) that use fonts already on the device,
  so nothing is downloaded
- Text size: Small, Medium or Large, kept on each device (a phone and a computer want different sizes)
- Theme, accent and font are saved in your sheet, so every device you connect matches; the page also keeps a copy
  on the device so it opens in the right colors straight away. Settings > Look
- A sheet whose script has not been updated yet still remembers your look on that device, and sends it once the script is updated
- Buttons now follow the chosen font too

**Needs the script update:** yes (it saves the look in the Settings tab). Press **Update now**.

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
