# Changelog

Each release has a **name** people see (1.0, 1.1, ...). The sheet's script has its own **build id** (2026.10.11) that
the update check compares; it only ever goes up, and it only changes when the script does. A release that is only the
website (like 1.3) leaves the build alone, so nobody has to press anything. Settings shows, for example,
"LearnerBot 1.3. Your sheet's script is up to date (build 2026.10.11)."

## 1.13 · build 2026.11.27 · 2026-11-25

**Google Tasks on The Workday**
- Google Tasks that are due today, or overdue, appear in the same **To do** list as your work items. In place of a work item number they say
  **Google Task**, the title opens the task in Google Tasks, and anything the task points at (a linked email or document) is listed underneath
- Tasks with no due date are left out, so your whole backlog does not land on the page. Nothing is ever changed in Google Tasks
- A task you finish in Google Tasks moves to **Closed since the last refresh**; finishing one here saves a log entry like any other task
- **One-time setup:** in your sheet, open Extensions → Apps Script, press **+** beside Services, choose **Google Tasks API**, then **Add**. Press
  **Refresh Google Tasks** on The Workday and approve Google's permission screen once. Until then the page shows these same steps

**The Workday refreshes twice a day**
- The planner now runs at 6 AM and 3 PM on weekdays. The 3 PM run updates your work items, your calendar and your Google Tasks, and works out open
  focus time from the rest of the day only
- Work items that left your list since the morning (finished, merged, reassigned) move to **Closed since the last refresh**, where **Put back** undoes it.
  Nothing is logged for them. Your Google Tasks are also refreshed at the 7 AM daily focus and with the **Refresh Google Tasks** button

**New conversation (Assistant)**
- A **New conversation** button clears the assistant's chat and starts clean. Earlier messages stay in your sheet, so a later version of the
  assistant can use or show them

**Goals Dashboard**
- The Dashboard tab is now called **Goals Dashboard**

**Needs the script update:** yes. Press **Update now**. Your sheet's Today tab gains one column (Links) by itself; nothing is changed or deleted.

## 1.12 · website only · script build stays 2026.11.26 · 2026-11-25

**Choose whether The Workday shows your team objectives**
- The **Team objectives** section on The Workday now has a **Show** / **Minimize** button. Minimized, it is one line (how many objectives and
  the average progress); shown, it lists each objective with its progress and due date
- It remembers your choice on each device, so your phone and your computer can differ. Until you choose, it stays minimized, as before
- Works with the keyboard and a screen reader (the button says whether the list is open)

**Needs the script update:** no. Reload the page.

## 1.11 · build 2026.11.26 · 2026-11-25

**Update now works again for the Workday release**
- Releases 1.9 and 1.10 were labelled with a script build number (2026.11.25.1) that the updater built into every sheet refuses, so **Update
  now** said "The downloaded file is not a LearnerBot update". Nothing was installed and nothing in your sheet changed
- This release carries everything from 1.8, 1.9 and 1.10 (the Workday tab, **Your day**, and the new name) under build **2026.11.26**,
  which the updater accepts. A test now runs the real update from the previous script to this one, and checks the build number's format

**Needs the script update:** yes. Press **Update now**.

## 1.10 · website only · script build stays 2026.11.25.1 · 2026-11-25

**The Today tab is now called The Workday**
- The tab, and the heading at the top of it, now say **The Workday**. Everything on it works as before. The Dashboard's **Today's Focus**
  (your coach's pick for the day) keeps its name
- Your sheet's tab is still called Today, so nothing in your sheet changes

**Needs the script update:** no. Reload the page.

## 1.9 · build 2026.11.25.1 · 2026-11-25

**Your day, from both calendars (Today tab)**
- A new **Your day** panel on the Today tab shows the day in time order: **Booked** windows, tagged with the calendar they came from
  (Outlook or Google), and **Open focus** windows with how long each is. It also says how many all-day items are on your calendar
- Only times arrive from your computer, never event names. The names are in the planner's own printout and daily file on your computer
- The 7am coach now hears which calendar each booked window is on, so it can tell work time from personal time

**Needs the script update:** yes, a small one. Press **Update now**. Nothing in your sheet changes; the Today feed simply carries a
little more (which calendar each booked window is on, and how many all-day items there are). An older script keeps working without it.

## 1.8 · build 2026.11.25 · 2026-11-25

**A Today tab: the day's work, apart from your goals**
- A new **Today** tab lists the tasks for the day. They arrive each morning from a planner on your own computer (your calendar's
  open time, your work items and your team's objectives), and you can add your own. Each task shows a short title and its ID, size,
  state and any warnings (blocked, due soon, carried over). Open work from the last few days shows as **Carried over**
- Linking a task to a goal is optional, and you can change or remove the link at any time
- Checking a task off asks **how long it took** (quick picks of 15 minutes to 2 hours, or skip the time) and saves it to your Log,
  tagged from the goal if you linked one. **Undo** (the bar at the bottom) takes the log entry back; a finished task can also be
  put back on the list later. Tasks can be skipped for the day
- Works offline like everything else: changes are kept on the device and sent in order, and nothing is logged twice
- The 7am daily focus now reads the day's plan (short titles and IDs only), says so plainly when no fresh plan arrived, and the
  weekly review hears how many of the week's tasks were finished
- Phone and computer: large tap targets, one row of tabs on a phone, works with every theme and with a screen reader or keyboard

**What is sent:** the planner sends your sheet only short titles, IDs, sizes, states, warnings and the open time windows. Meeting
names, links, descriptions and people are never sent. Only the main connection (the computer you pasted the token into) can deliver a plan.

**Needs the script update:** yes. Press **Update now**. Your sheet gets a new **Today** tab by itself; nothing is changed or deleted.

## 1.7 · build 2026.10.14 · 2026-10-19

**Keep your own coach voices (Settings > Coach voice)**
- Write a voice, give it a name and press **Save to my voices**. It is kept in your sheet, so it shows up under **My voices** on
  every device, next to the ready-made ones. Pick one to load it into the box, change it if you like, and press **Save voice** to
  make your coach use it
- Up to 12 of your own, a name of up to 30 characters and up to 800 characters of words (the same limit as the voice your coach
  uses). Saving under a name you already have replaces that voice, and the ✕ beside one removes it
- Keeping a voice does not change the one your coach is using, and the coach only ever sees the voice you saved with **Save voice**

**Needs the script update:** yes, a small one. Press **Update now**. Your sheet gets one new row in the Settings tab (`my_voices`)
when you first keep a voice; nothing else changes.

## 1.6 · website only · script build stays 2026.10.13 · 2026-10-19

**A simpler Dashboard**
- Today's Focus, Log Activity and Active Goals are now three full-width sections, one under the other, instead of one wide
  section and two columns. The log has its text box on the left with tags, time and **Log it** beside it, and a new goal is added
  from a single line (title, priority, tags, due date, **Add**). On a phone they stack as before
- Goal titles have room to show more of their text on a wide screen

**Needs the script update:** no. Reload the page.

## 1.5 · build 2026.10.13 · 2026-10-19

**Changes made without a connection are kept and sent later**
- Adding, completing, postponing, removing or editing goals and tasks, logging activity, editing or removing log entries and
  sending feedback now work with no signal. Each change shows on screen at once, is saved in this browser, and goes to your
  sheet in the order you made it as soon as it can be reached
- The status chip at the top says **3 changes waiting** while anything is unsent; press it to try now. It also tries again by
  itself (after a few seconds, then less and less often), when the phone or computer says it is back online, and when you come
  back to the tab
- Closing the page or reloading does not lose them: the dashboard comes back with your new goals and tasks shown as waiting, and
  they are sent when you reopen it
- Nothing is applied twice. Each new goal, task, log entry or note carries its own id, and the sheet recognises one it already
  saved when the answer was lost on the way back
- A change the sheet turns down is dropped with a message that names it (and so are changes that depended on it, like a task for a
  goal that could not be saved). A wrong token or a busy sheet keeps everything and tries again. Disconnecting while changes are
  waiting asks first
- Settings, the AI coach and updates still need a connection and show the usual message when there is none

**Needs the script update:** yes, a small one. Press **Update now**. Until you do, offline changes still work, but with an older
script a change whose answer got lost on the way back could be saved twice. Your sheet gains a `Ref` column on goals, tasks, log
entries and feedback by itself (new items fill it in; old rows stay empty) and nothing is deleted.

## 1.4 · build 2026.10.12 · 2026-10-19

**Look back at your log (History > Log)**
- A **Log** section in History: your entries newest first, grouped by day, with tags, time, a total for each day and a
  tag filter. The last 30 days open first, with **Show older**
- Edit an entry's text, tags or time, or remove it. Removing hides it at once and gives you the five-second Undo bar
- Entries added on the Dashboard show up in the log straight away

**Keeping the sheet light (Settings > Housekeeping)**
- Removed log entries, goals and tasks are hidden first and deleted for good after **14 or 30 days** (you choose; 30 to start).
  The clean-up runs on the first log entry or removal of the day, never from a timer. Completed goals are never deleted this way
- A **tidy-up of completed goals** about every three months: each goal done for a month or more is kept as a record or removed
  entirely (with its tasks). Small, quick goals (finished within two weeks, at most two tasks, no sub-goals, not high priority)
  start on Remove; bigger ones start on Keep. You can change any choice, and nothing is deleted until you confirm
- History shows when a goal was completed, and "kept" for goals you chose to keep

**Edit the proposed plan (Review tab)**
- Change the suggested goals (title, priority, why), add or remove some, and edit the priorities and focus areas, before
  adding them as real goals. The next weekly review makes a fresh plan; the edited one stays in the earlier report

**Needs the script update:** yes. Press **Update now**. Your sheet gains a few columns by itself (goals and tasks remember when
they changed status; log entries get an id and a status) and nothing is deleted by the update: goals and tasks that were
already completed or removed start counting from the day you update.

## 1.3 · website only · script build stays 2026.10.11 · 2026-10-19

**Find things faster**
- **Log Activity** now sits right under Today's Focus and above your goals (beside them on a wide screen), so adding an
  entry no longer means scrolling past every goal
- A **Review** tab: the weekly review, the proposed plan and the weekly scores
- An **Assistant** tab: the chat at full size, with Steer the Assistant beside it. The floating chat bar is gone
- On a phone the four tabs get their own full-width row, with refresh and settings at the top right

**Settings**
- "Connect your LearnerBot" is now a folded section like the others, and it stays closed unless you are not connected or the
  connection was refused. The page no longer jumps into the access token field (which raised the keyboard on a phone)
- "Look" is now **Appearance**, and "Request timings" is now **Speed and diagnostics**

**Coach voice**
- Fifteen ready-made voices in three groups (Gentle, Tough, Fun), including cheerleader, patient teacher, zen monk, stoic philosopher,
  wise old wizard, noir detective, pirate captain, sports commentator, grumpy chef and startup founder

**Needs the script update:** no. Nothing to press.

## 1.2 · build 2026.10.11 · 2026-10-16

**A Custom theme**
- Settings > Appearance > Custom: pick a **primary** color (the page background) and a **secondary** color (buttons and highlights)
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

**Look** (this section of Settings was called "Look" until 1.3; it is now Appearance)
- Three themes: Dark (as before), Light and High contrast
- Accent color: eight ready-made colors, a color picker, or the theme's own. A color that would be hard to read on
  the chosen theme is nudged until it is readable, and button text switches between dark and light to match
- Font: six choices (System, Humanist, Serif, Wide and clear, Monospace, Rounded) that use fonts already on the device,
  so nothing is downloaded
- Text size: Small, Medium or Large, kept on each device (a phone and a computer want different sizes)
- Theme, accent and font are saved in your sheet, so every device you connect matches; the page also keeps a copy
  on the device so it opens in the right colors straight away. Settings > Appearance
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
