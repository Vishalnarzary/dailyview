/* ═══════════════════════════════════════════
   DAYFLOW — features.js
   Login, Plan Day, History (server-backed)
   ═══════════════════════════════════════════ */

// ─── ENV DETECT ───
const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);

// Login removed — app loads directly

// ─────────────────────────────────────────────
// PLAN THE DAY
// ─────────────────────────────────────────────
const PLAN_SYS_PROMPT = `You are a productivity planning AI. Given pending tasks and time remaining, create a realistic time-blocked schedule.

Rules:
- Start from the current time (provided)
- End by 11:00 PM
- Include 5-10 min breaks every 45-60 min of work
- Include at least one exercise/movement break (10-15 min)
- Schedule high-energy/high-priority tasks first
- Include a wind-down period at the end if time allows
- Be realistic about durations

Return ONLY valid JSON, no markdown:
{
  "plan": [
    {"time":"HH:MM AM/PM","endTime":"HH:MM AM/PM","activity":"string","type":"work|break|exercise|meal|winddown","duration":"X min"}
  ],
  "summary": "1-2 sentence overview",
  "tips": "1-2 actionable tips for this session"
}`;

async function planDay() {
  const modal   = document.getElementById('plan-modal');
  const loading = document.getElementById('plan-loading');
  const content = document.getElementById('plan-content');

  modal.classList.remove('hidden');
  loading.style.display = 'flex';
  content.classList.add('hidden');

  // Guard: no API key in local dev
  if (IS_LOCAL && !CONFIG.GROQ_API_KEY) {
    loading.innerHTML = '<p style="color:var(--yellow);margin:auto;">⚠️ Add your Groq API key to <code>CONFIG.GROQ_API_KEY</code> in app.js for local dev.</p>';
    return;
  }

  const today   = todayISO();
  const pending = state.tasks.filter(t => t.status === 'pending' && (!t.dueDate || t.dueDate === today));

  if (!pending.length) {
    loading.innerHTML = '<p style="color:var(--green);font-size:1.1rem;margin:auto;">🎉 No pending tasks! Enjoy your evening.</p>';
    return;
  }

  const now    = new Date();
  const end    = new Date(); end.setHours(23, 0, 0, 0);
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const minsLeft = Math.max(0, Math.floor((end - now) / 60000));

  const userMsg = `Current time: ${timeStr}
Minutes until 11 PM: ${minsLeft}
Pending tasks:\n${JSON.stringify(pending.map(t => ({
    task: t.task, priority: t.priority,
    energyLevel: t.energyLevel, estimatedMinutes: t.estimatedMinutes,
  })), null, 2)}`;

  try {
    const result = await callGroq(PLAN_SYS_PROMPT, userMsg, true);
    renderPlan(result);
  } catch (e) {
    loading.innerHTML = `<p style="color:var(--red);margin:auto;">Failed to generate plan: ${escHtml(e.message)}</p>`;
  }
}

function renderPlan(data) {
  document.getElementById('plan-loading').style.display = 'none';
  const content = document.getElementById('plan-content');
  content.classList.remove('hidden');

  document.getElementById('plan-summary').textContent = data.summary || '';
  document.getElementById('plan-tips').innerHTML      = '💡 ' + escHtml(data.tips || '');

  const tl = document.getElementById('plan-timeline');
  if (!data.plan?.length) { tl.innerHTML = '<p style="color:var(--text-muted)">No plan items.</p>'; return; }

  tl.innerHTML = data.plan.map(item => {
    const type = (item.type || 'work').toLowerCase();
    const icon = { work:'💼', break:'☕', exercise:'🏃', meal:'🍽️', winddown:'🌙' }[type] || '📌';
    return `<div class="tl-item type-${type}">
      <div class="tl-dot"></div>
      <div class="tl-time">${escHtml(item.time)} — ${escHtml(item.endTime)}
        <span class="tl-type-tag">${icon} ${type}</span>
      </div>
      <div class="tl-activity">${escHtml(item.activity)}</div>
      <div class="tl-meta">${escHtml(item.duration || '')}</div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────
// HISTORY — Server-backed (Upstash on Vercel,
//           localStorage fallback for local dev)
// ─────────────────────────────────────────────

// Load history: from /api/history on Vercel, localStorage locally
async function loadHistory() {
  if (IS_LOCAL) {
    const raw = localStorage.getItem('dayflow_history');
    return raw ? JSON.parse(raw) : {};
  }
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    return d.history || {};
  } catch {
    return {};
  }
}

// Save a single day entry
async function saveHistoryEntry(date, entry) {
  if (IS_LOCAL) {
    const raw  = localStorage.getItem('dayflow_history');
    const hist = raw ? JSON.parse(raw) : {};
    hist[date] = entry;
    localStorage.setItem('dayflow_history', JSON.stringify(hist));
    return;
  }
  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, entry }),
  });
}

function buildTodayEntry() {
  const today      = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const done       = todayTasks.filter(t => t.status === 'done').length;
  const total      = todayTasks.length;
  return {
    date: today,
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    tasks: todayTasks.map(t => ({
      task: t.task, status: t.status, priority: t.priority,
      energyLevel: t.energyLevel, estimatedMinutes: t.estimatedMinutes, tags: t.tags,
    })),
    stats: {
      total, completed: done, pending: total - done,
      completionRate: total ? Math.round((done / total) * 100) : 0,
      totalEstimatedMinutes: todayTasks.reduce((s, t) => s + (t.estimatedMinutes || 0), 0),
    },
    streak:    loadStreak().count,
    coachMode: state.coachMode,
    archivedAt: new Date().toISOString(),
  };
}

async function archiveToday() {
  const today      = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  if (!todayTasks.length) { showToast('No tasks to archive today.', 'warn'); return; }

  const entry = buildTodayEntry();
  try {
    await saveHistoryEntry(today, entry);
    showToast('Today archived to server! 💾', 'success');
  } catch {
    showToast('Failed to save history. Try again.', 'error');
  }
}

async function autoArchiveYesterday() {
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  const yTasks = state.tasks.filter(t => t.dueDate === yesterday);
  if (!yTasks.length) return;

  const history = await loadHistory();
  if (history[yesterday]) return; // already archived

  const done = yTasks.filter(t => t.status === 'done').length;
  await saveHistoryEntry(yesterday, {
    date: yesterday,
    dayOfWeek: new Date(yesterday + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
    tasks: yTasks.map(t => ({
      task: t.task, status: t.status, priority: t.priority,
      energyLevel: t.energyLevel, estimatedMinutes: t.estimatedMinutes, tags: t.tags,
    })),
    stats: {
      total: yTasks.length, completed: done, pending: yTasks.length - done,
      completionRate: yTasks.length ? Math.round((done / yTasks.length) * 100) : 0,
    },
    streak: loadStreak().count,
    archivedAt: new Date().toISOString(),
  });
}

async function openHistory() {
  document.getElementById('history-modal').classList.remove('hidden');
  document.getElementById('history-list').innerHTML = '<div class="empty-state"><span>⏳</span><p>Loading history...</p></div>';
  document.getElementById('empty-history').style.display = 'none';

  const history = await loadHistory();
  renderHistory(history);
}

function renderHistory(history) {
  const dates = Object.keys(history).sort().reverse();
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('empty-history');

  if (!dates.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = dates.map(date => {
    const d   = history[date];
    const s   = d.stats || {};
    const pct = s.completionRate || 0;
    const tasks = d.tasks || [];
    return `<div class="history-card">
      <div class="hc-top">
        <div>
          <div class="hc-date">${d.dayOfWeek || ''}, ${formatDate(date)}</div>
        </div>
        <span style="font-size:1.1rem;font-weight:800;color:var(--accent)">${pct}%</span>
      </div>
      <div class="hc-bar"><div class="hc-bar-fill" style="width:${pct}%"></div></div>
      <div class="hc-stats">
        <span>📋 ${s.total || 0} total</span>
        <span>✅ ${s.completed || 0} done</span>
        <span>⏳ ${s.pending || 0} pending</span>
        ${d.streak ? `<span>🔥 ${d.streak} streak</span>` : ''}
        ${s.totalEstimatedMinutes ? `<span>⏱ ~${Math.round(s.totalEstimatedMinutes/60*10)/10}h planned</span>` : ''}
      </div>
      <button class="hc-toggle" onclick="toggleHistoryTasks(this)">Show tasks ▾</button>
      <div class="hc-tasks" style="display:none">
        ${tasks.map(t => `<div class="hc-task ${t.status === 'done' ? 'done' : ''}">
          <span class="hc-task-status">${t.status === 'done' ? '✅' : '⬜'}</span>
          ${escHtml(t.task)}
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
}

function toggleHistoryTasks(btn) {
  const tasks   = btn.nextElementSibling;
  const showing = tasks.style.display !== 'none';
  tasks.style.display = showing ? 'none' : 'flex';
  btn.textContent = showing ? 'Show tasks ▾' : 'Hide tasks ▴';
}

// ─────────────────────────────────────────────
// ATTACH ALL EVENTS
// ─────────────────────────────────────────────
function attachFeatureEvents() {
  // Plan Day
  document.getElementById('plan-btn').addEventListener('click', planDay);
  document.getElementById('close-plan').addEventListener('click', () =>
    document.getElementById('plan-modal').classList.add('hidden'));
  document.getElementById('close-plan-bottom').addEventListener('click', () =>
    document.getElementById('plan-modal').classList.add('hidden'));
  document.getElementById('regenerate-plan').addEventListener('click', planDay);

  // History
  document.getElementById('history-btn').addEventListener('click', openHistory);
  document.getElementById('close-history').addEventListener('click', () =>
    document.getElementById('history-modal').classList.add('hidden'));
  document.getElementById('archive-now').addEventListener('click', async () => {
    await archiveToday();
    const history = await loadHistory();
    renderHistory(history);
  });
}
