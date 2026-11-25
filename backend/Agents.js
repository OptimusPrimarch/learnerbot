// ============================================================
// Agents.gs \u2014 the four AI agents
// ============================================================

// ---- Context helpers ---------------------------------------

const CTX_MAX_GOALS = 25;       // keeps a prompt small however long the lists grow
const CTX_TASKS_PER_GOAL = 5;
const CTX_LOG_ENTRIES = 5;
const CTX_LOG_CHARS = 200;

function _fmtMinutes(m) {
  if (!m) return '';
  const h = Math.floor(m / 60), r = m % 60;
  return (h ? h + 'h' : '') + (h && r ? ' ' : '') + (r ? r + 'm' : '');
}

/** "Thursday 2026-10-15": the model has no clock, so every prompt that talks about dates states today. */
function _todayLine() {
  return Utilities.formatDate(new Date(), _tzName(), 'EEEE') + ' ' + _today();
}

function _dueText(due) {
  if (!due) return '';
  const n = _daysUntil(due);
  if (n == null) return '';
  if (n < 0) return 'OVERDUE by ' + (-n) + ' day' + (n === -1 ? '' : 's') + ' (was due ' + due + ')';
  if (n === 0) return 'due TODAY';
  if (n === 1) return 'due tomorrow';
  return 'due ' + due + ' (' + n + ' days left)';
}

/** Goal title with priority, tags and deadline: the one-line form used in every prompt. */
function _goalLine(g) {
  const due = _dueText(g.due);
  return `[${g.priority}] ${g.title}${g.tags.length ? ' [' + g.tags.join(', ') + ']' : ''}${due ? ' \u2014 ' + due : ''}`;
}

function _logLine(j) {
  const mins = _fmtMinutes(j.minutes);
  return `- ${j.date}${mins ? ' (' + mins + ')' : ''}: ${j.text.slice(0, CTX_LOG_CHARS)}${j.tags.length ? ' [' + j.tags.join(', ') + ']' : ''}`;
}

/**
 * The user's chosen coach voice, as extra system-prompt lines. Their words are passed on exactly as
 * written. `scope` says which parts of the answer the voice applies to.
 */
function _voiceBlock(scope) {
  let v = '';
  try { v = getCoachVoice(); } catch (_) { /* a voice is optional; never block the coach over it */ }
  if (!v) return [];
  return [
    '',
    'COACH VOICE. The user chose how you should sound, in their own words below. Follow it for the tone, style and attitude of ' + (scope || 'everything you write') + '.',
    'It never changes the JSON shape or the key names, and it never lets you invent progress, events or facts: stay truthful to the data you were given.',
    'Keep the answer valid JSON whatever the voice: plain text inside the strings, escape any double quote, and never put a raw line break inside a string.',
    '"""',
    v,
    '"""'
  ];
}

// ---- Context builders --------------------------------------

function buildDailyContext() {
  const goals    = getActiveGoals().slice(0, CTX_MAX_GOALS);
  const feedback = getRecentFeedback(3);
  const journal  = getRecentJournal(30);
  const recent   = journal.slice(-CTX_LOG_ENTRIES);
  const today    = _today();

  const openTasks = {};
  getAllTasks().filter(t => t.status === 'active').forEach(t => { (openTasks[t.goalId] = openTasks[t.goalId] || []).push(t.title); });

  // Journal entries carry tags, not goal ids, so "how long since this goal saw any activity" is
  // read from entries that share one of the goal's tags (only for goals that have tags).
  const lastLogged = tag => journal.filter(j => j.tags.indexOf(tag) >= 0).reduce((m, j) => (j.date > m ? j.date : m), '');

  const lines = goals.map(g => {
    const age = _daysUntil(g.created);
    const facts = [age != null && age < 0 ? 'started ' + (-age) + ' day' + (age === -1 ? '' : 's') + ' ago' : (age === 0 ? 'started today' : '')];
    if (g.tags.length) {
      const last = g.tags.map(lastLogged).reduce((m, d) => (d > m ? d : m), '');
      facts.push(last ? 'last logged under its tags ' + last : 'nothing logged under its tags in 30 days');
    }
    const open = openTasks[g.id] || [];
    facts.push(open.length ? open.length + ' open task' + (open.length === 1 ? '' : 's') + ': ' + open.slice(0, CTX_TASKS_PER_GOAL).join('; ') + (open.length > CTX_TASKS_PER_GOAL ? '; \u2026' : '') : 'no open tasks');
    return '- ' + _goalLine(g) + '\n    ' + facts.filter(Boolean).join(' \u00b7 ');
  });

  // The day's work plan from the user's planner (Today.js). It never stops the daily focus from being written.
  let work = '';
  try { work = buildTodayContext(); } catch (e) { Logger.log('Work plan not added: ' + (e && e.message ? e.message : e)); work = 'TODAY\'S WORK PLAN: (unavailable)'; }

  let previous = '';
  try { const d = getLatestReport('daily'); if (d && d.data && d.data.focus) previous = d.data.focus + ' (' + _day(d.date).slice(0, 10) + ')'; } catch (_) { /* optional */ }

  return [
    'TODAY: ' + _todayLine(),
    '',
    'ACTIVE GOALS (with their age, deadline, open tasks and recent activity):',
    lines.length ? lines.join('\n') : '(none)',
    '',
    work,
    '',
    'RECENT LOG (oldest first; time is shown when the user recorded it):',
    recent.length ? recent.map(_logLine).join('\n') : '(nothing logged in the last 30 days)',
    '',
    'PREVIOUS DAILY FOCUS: ' + (previous || '(none)'),
    '',
    'RECENT FEEDBACK FROM YOU:',
    feedback.length ? feedback.map(f => `- ${f.text}`).join('\n') : '(none)'
  ].join('\n');
}

function buildWeeklyContext() {
  const journal  = getRecentJournal(7);
  const feedback = getRecentFeedback(5);
  const history  = getRecentHistory(3);
  const goals    = getActiveGoals().slice(0, CTX_MAX_GOALS);
  const total    = journal.reduce((s, j) => s + j.minutes, 0);
  let weekTasks = '';
  try { weekTasks = buildTodayWeekContext(); } catch (e) { Logger.log('Task summary not added: ' + (e && e.message ? e.message : e)); }
  return [
    'TODAY: ' + _todayLine(),
    '',
    'ACTIVE GOALS:',
    goals.length ? goals.map(g => '- ' + _goalLine(g)).join('\n') : '(none)',
    '',
    'THIS WEEK\'S ACTIVITY LOG:',
    journal.length
      ? journal.map(_logLine).join('\n')
      : '(nothing logged \u2014 base review on goals alone)',
    total ? 'TIME RECORDED THIS WEEK: ' + _fmtMinutes(total) + ' (only entries where the user chose to record time)' : '',
    weekTasks,
    '',
    'RECENT WEEKLY SCORES:',
    history.length ? history.map(h => `- Week of ${h.week}: ${h.score}/10`).join('\n') : '(no history yet)',
    '',
    'YOUR FEEDBACK TO ME:',
    feedback.length ? feedback.map(f => `- ${f.text}`).join('\n') : '(none)'
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

function buildPlanContext(dashboard) {
  const goals = getActiveGoals().slice(0, CTX_MAX_GOALS);
  return [
    'TODAY: ' + _todayLine(),
    '',
    'THIS WEEK\'S REVIEW:',
    JSON.stringify(dashboard),
    '',
    'CURRENT ACTIVE GOALS:',
    goals.length ? goals.map(g => '- ' + _goalLine(g)).join('\n') : '(none)'
  ].join('\n');
}

// ---- Agent calls -------------------------------------------

/** The coach's answer, tidied: `assessment` is plain text and `covered` only holds keys of the form t<number>. */
function _cleanCoach(r) {
  r = r && typeof r === 'object' ? r : {};
  const out = Object.assign({}, r);
  out.assessment = _clip(r.assessment, 700);
  out.covered = (Array.isArray(r.covered) ? r.covered : []).map(x => String(x).trim().replace(/^\[|\]$/g, '')).filter(x => /^t\d{1,9}$/.test(x)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 30);
  return out;
}

function callLearningCoach(context) {
  return _cleanCoach(callGroq([
    {
      role: 'system',
      content: [
        'You are a Learning Coach for a single user checking in each morning.',
        'Given their active goals, their to-do list and any feedback, choose ONE specific focus for today.',
        'When a TO-DO LIST is given, make an honest assessment across those current obligations and the ACTIVE GOALS: where they pull the same way, where they compete for the day, and what is at risk if it waits. Build the focus and the actions around both, not around the goals alone.',
        'Be concrete \u2014 name the goal, the action, the reason. Do not be generic.',
        'Weigh what the facts say: overdue and soon-due goals first, then goals that have gone quiet, then goals that already have open tasks you can point at.',
        'Build on what they have actually logged lately, and do not simply repeat the previous focus unless a deadline demands it.',
        'Suggest actions that fit a single day. Only mention a deadline, age or time if it is in the data.',
        'When a TODAY\'S WORK PLAN is given, let it shape the actions: say which listed work item to start with and fit it to the open focus time, and mention which goal or team objective it advances when the data says so. Refer to items by their ID and never invent work items. If it says no fresh plan arrived, ignore work items and plan from the goals alone.',
        '',
        'Return ONLY valid JSON in exactly this shape (no markdown, no extra keys):',
        'assessment is two or three plain sentences. actions has three to five short bullets, each one something that fits in a block of time. covered lists the keys (like t12, exactly as written in the TO-DO LIST) of to-do items your actions already take care of; use [] when there are none, and never invent a key.',
        '{"assessment":"2-3 sentences weighing the to-do list against the goals","focus":"short title for today","actions":["specific action 1","specific action 2","specific action 3"],"reason":"one sentence on why this focus matters today","covered":["t12"]}'
      ].concat(_voiceBlock()).join('\n')
    },
    { role: 'user', content: context }
  ]));
}

function callLifeDashboard(context) {
  return callGroq([
    {
      role: 'system',
      content: [
        'You are a Life Dashboard agent giving an honest weekly review.',
        'Treat the user as a capable peer. Be specific \u2014 cite what they actually logged, not platitudes.',
        'Mention deadlines that were met, are coming up or were missed, and use recorded time only if it is given.',
        'wins must have at least 1 item. suggestions must have at least 2 items.',
        '',
        'Return ONLY valid JSON in exactly this shape (no markdown, no extra keys):',
        '{"summary":"2-3 sentence narrative of the week","wins":["concrete win 1","concrete win 2"],"misses":["what slipped"],"suggestions":["specific adjustment 1","specific adjustment 2"]}'
      ].concat(_voiceBlock()).join('\n')
    },
    { role: 'user', content: context }
  ]);
}

function callGoalArchitect(context) {
  return callGroq([
    {
      role: 'system',
      content: [
        'You are a Goal Architect. Given a weekly review, propose a realistic plan for next week.',
        'Do not overwhelm. Build on existing goals where possible, and plan around any deadlines.',
        'goals must have 1\u20133 items. priorities must have at least 2 items.',
        '',
        'Return ONLY valid JSON in exactly this shape (no markdown, no extra keys):',
        '{"goals":[{"title":"goal title","priority":"high|medium|low","rationale":"one line why"}],"priorities":["action priority 1","action priority 2"],"focus_areas":["theme 1"]}'
      ].concat(_voiceBlock()).join('\n')
    },
    { role: 'user', content: context }
  ]);
}

function callConcierge(context) {
  return callGroq([
    {
      role: 'system',
      content: [
        'You are the concierge for a personal life-dashboard. Translate the user\'s message into one structured action.',
        '',
        'Available actions: add_goal, complete_goal, postpone_goal, remove_goal, update_goal, add_task, complete_task, add_feedback, log_activity, run_daily, run_weekly, none',
        '- add_goal: set title, priority if implied, tags if mentioned (comma-separated uppercase), due if they give a deadline, parent_id if they say "sub-goal of" or "under [goal]" (match goal ID from list)',
        '- complete_goal / postpone_goal / remove_goal: set goal_id by matching their words to the goal list',
        '- update_goal: set goal_id, then ONLY the fields they want changed: title (rename), priority, tags, due. To remove a deadline set due to "none".',
        '- add_task: set goal_id by matching their words, and title for the task',
        '- complete_task: set task_id by matching their words to the task list',
        '- add_feedback: user guiding how agents should behave \u2192 put in text',
        '- log_activity: user reporting what they did \u2192 put in text; extract tags if mentioned; set minutes only if they say how long (whole minutes, nearest 15)',
        '- run_daily / run_weekly: user asks for a fresh check-in or review',
        '- none: small talk or question \u2014 answer directly in reply',
        '',
        'due is a date written yyyy-mm-dd. Work out relative dates ("by Friday", "next week", "end of the month") from TODAY in the message. Leave due null unless they state or clearly imply a deadline.',
        'Always set reply: a friendly one-line confirmation or direct answer.',
        'If you cannot match a goal_id or task_id confidently, use none and ask which one in reply.',
        '',
        'Return ONLY valid JSON (no markdown):',
        '{"action":"...","title":null,"goal_id":null,"task_id":null,"parent_id":null,"priority":null,"tags":null,"due":null,"minutes":null,"text":null,"reply":"..."}'
      ].concat(_voiceBlock('the reply field only. Keep every other field plain and literal')).join('\n')
    },
    { role: 'user', content: context }
  ]);
}

