/* ═══════════════════════════════════════════
   DAYFLOW — app.js
   All logic: Groq API, Voice, Tasks, Timer
   ═══════════════════════════════════════════ */

// ─────────────────────────────────────────────
// 1. CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  GROQ_API_KEY: '', // 🔑 Add your key here for local dev only — remove before committing
  MODEL: 'llama-3.3-70b-versatile',
  END_HOUR: 23,   // 11 PM
  END_MIN: 0,
};

// ─────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────
const state = {
  tasks: [],
  coachMode: 'coach',   // 'coach' | 'tough'
  focusMode: false,
  isListening: false,
};

// ─────────────────────────────────────────────
// 3. HELPERS
// ─────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().split('T')[0];
}
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}
function pad(n) { return String(n).padStart(2, '0'); }
function uid() { return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

// ─────────────────────────────────────────────
// 4. LOCALSTORAGE
// ─────────────────────────────────────────────
function saveTasks() {
  localStorage.setItem('dayflow_tasks', JSON.stringify(state.tasks));
}
function loadTasks() {
  const raw = localStorage.getItem('dayflow_tasks');
  if (raw) state.tasks = JSON.parse(raw);
}
function saveStreak(data) { localStorage.setItem('dayflow_streak', JSON.stringify(data)); }
function loadStreak() {
  const raw = localStorage.getItem('dayflow_streak');
  return raw ? JSON.parse(raw) : { count: 0, lastDate: null };
}
function saveCoachMode() { localStorage.setItem('dayflow_coach', state.coachMode); }
function loadCoachMode() { state.coachMode = localStorage.getItem('dayflow_coach') || 'coach'; }

// ─────────────────────────────────────────────
// 5. GROQ PROMPTS
// ─────────────────────────────────────────────
const TASK_SYS_PROMPT = `You are a smart daily task management AI. You receive the user's current task list and a voice/text command.

Your job:
- Parse intent: add tasks, mark done/pending, delete tasks, reschedule ("push to tomorrow")
- Return ONLY a valid JSON array — no markdown, no explanation, nothing else
- Include ALL tasks (unchanged ones too)

Each task object must have EXACTLY these fields:
{
  "id": "string (keep existing IDs; generate new ones as task_<timestamp>_<random> for new tasks)",
  "task": "string",
  "status": "pending" | "done",
  "priority": "high" | "medium" | "low",
  "energyLevel": "high" | "low",
  "estimatedMinutes": number,
  "tags": ["string"],
  "dueDate": "YYYY-MM-DD or null (null = today)"
}

Auto-assign rules:
- energyLevel "high": focus work, coding, writing, studying, physical tasks
- energyLevel "low": emails, calls, quick errands, routine tasks
- estimatedMinutes: be realistic (email = 10, quick call = 5, deep work = 90)
- priority "high": user stated urgency OR deadline-critical
- tags: domain categories like ["work","email"], ["health","gym"], ["personal"]
- "push to tomorrow" / "move to tomorrow" commands: set dueDate to tomorrow's date`;

const COACH_SYS_PROMPT = `You are a daily productivity coach. Generate a short personalized message.

Return ONLY valid JSON, no markdown, nothing else:
{"greeting": "1-2 sentences here", "quote": "motivational quote — Author Name"}

Coach mode: warm, encouraging, specific to their progress
Tough Love mode: direct, blunt, no excuses, pushes hard

Keep greeting under 60 words. Use a real attributed quote.`;

// ─────────────────────────────────────────────
// 6. GROQ API (with Vercel proxy support)
// ─────────────────────────────────────────────
// IS_LOCAL is declared in features.js (loaded first)

async function callGroq(systemPrompt, userMessage, parseJSON = true) {
  let resp;
  if (!IS_LOCAL) {
    // On Vercel: use serverless proxy to hide API key
    resp = await fetch('/api/groq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, userMessage, model: CONFIG.MODEL }),
    });
  } else {
    // Local dev: call Groq directly
    resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 3000,
      }),
    });
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error ${resp.status}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  if (!parseJSON) return content;

  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/,'').trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// 7. PROCESS VOICE COMMAND
// ─────────────────────────────────────────────
async function processCommand(rawText) {
  if (!rawText.trim()) { showToast('Please say or type a command first.', 'warn'); return; }
  if (IS_LOCAL && !CONFIG.GROQ_API_KEY) {
    showToast('⚠️ Add your Groq API key to CONFIG.GROQ_API_KEY in app.js for local dev', 'error');
    return;
  }

  setLoading(true, 'Processing your command...');

  const today = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const userMsg = `Current tasks (JSON):\n${JSON.stringify(todayTasks, null, 2)}\n\nUser command: "${rawText}"\n\nToday's date: ${today}\nTomorrow's date: ${tomorrowISO()}`;

  let updated;
  try {
    updated = await callGroq(TASK_SYS_PROMPT, userMsg, true);
    if (!Array.isArray(updated)) throw new Error('LLM did not return an array');
  } catch (e) {
    // Retry once
    try {
      updated = await callGroq(TASK_SYS_PROMPT, userMsg + '\n\nIMPORTANT: Return ONLY a raw JSON array, starting with [ and ending with ]', true);
      if (!Array.isArray(updated)) throw new Error('Still not an array');
    } catch (e2) {
      setLoading(false);
      showToast('AI returned an unexpected format. Please try again.', 'error');
      return;
    }
  }

  // Merge: keep tasks for other days, replace today's
  const otherDays = state.tasks.filter(t => t.dueDate && t.dueDate !== today);
  state.tasks = [...otherDays, ...updated];
  saveTasks();
  renderAll();
  checkTimeReality();
  setLoading(false);
  document.getElementById('transcript').value = '';
  showToast('Tasks updated! ✨', 'success');
}

// ─────────────────────────────────────────────
// 8. COACH GREETING
// ─────────────────────────────────────────────
async function loadCoach() {
  const el = document.getElementById('coach-greeting');
  const qEl = document.getElementById('coach-quote');
  el.textContent = 'Loading your daily briefing...';
  qEl.textContent = '';

  if (IS_LOCAL && !CONFIG.GROQ_API_KEY) {
    el.textContent = state.coachMode === 'coach'
      ? "Welcome back! Add your Groq API key to app.js for personalized coaching. Let's make today count! 💪"
      : "No API key, no excuses. Add CONFIG.GROQ_API_KEY in app.js and get moving.";
    qEl.textContent = '"The secret of getting ahead is getting started." — Mark Twain';
    return;
  }

  const today = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const pending = todayTasks.filter(t => t.status === 'pending').length;
  const now = new Date();
  const endOfDay = new Date(); endOfDay.setHours(CONFIG.END_HOUR, CONFIG.END_MIN, 0, 0);
  const hoursLeft = Math.max(0, (endOfDay - now) / 3600000).toFixed(1);
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const userMsg = `Mode: ${state.coachMode}\nTasks remaining: ${pending}\nHours until 11 PM: ${hoursLeft}\nCurrent time: ${timeStr}\nCompleted today: ${todayTasks.filter(t=>t.status==='done').length}`;

  try {
    const result = await callGroq(COACH_SYS_PROMPT, userMsg, true);
    el.textContent = result.greeting || 'Have a productive day!';
    qEl.textContent = result.quote ? `"${result.quote.replace(/^"|"$/g,'')}"` : '';
  } catch {
    el.textContent = "Let's make today count! Set clear goals and tackle them one by one.";
    qEl.textContent = '"Small progress is still progress." — Unknown';
  }
}

// ─────────────────────────────────────────────
// 9. COUNTDOWN TIMER
// ─────────────────────────────────────────────
function updateCountdown() {
  const now = new Date();
  const end = new Date();
  end.setHours(CONFIG.END_HOUR, CONFIG.END_MIN, 0, 0);

  const card = document.getElementById('countdown-card');
  const hEl = document.getElementById('cd-h');
  const mEl = document.getElementById('cd-m');
  const sEl = document.getElementById('cd-s');
  const statusEl = document.getElementById('cd-status');

  // Remove urgency classes
  card.classList.remove('cd-green','cd-yellow','cd-red','pulsing');

  if (now >= end) {
    hEl.textContent = '00';
    mEl.textContent = '00';
    sEl.textContent = '00';
    statusEl.textContent = '🌙 Day ended — great work today!';
    card.classList.add('cd-red');
    // Update focus timer too
    document.getElementById('focus-timer').textContent = 'Day Ended';
    return;
  }

  const diff = end - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);

  hEl.textContent = pad(h);
  mEl.textContent = pad(m);
  sEl.textContent = pad(s);

  // Focus mode timer
  document.getElementById('focus-timer').textContent = `${pad(h)}:${pad(m)}`;

  // Urgency
  const totalMins = h * 60 + m;
  if (totalMins > 180) {
    card.classList.add('cd-green');
    statusEl.textContent = '🟢 Plenty of time ahead';
  } else if (totalMins > 60) {
    card.classList.add('cd-yellow');
    statusEl.textContent = '🟡 Getting tighter — stay focused';
  } else if (totalMins > 0) {
    card.classList.add('cd-red', 'pulsing');
    statusEl.textContent = '🔴 Final sprint! Push through!';
  }

  // Time-of-day theme
  updateTimeTheme(now.getHours());
}

function updateTimeTheme(h) {
  const body = document.body;
  body.classList.remove('theme-morning','theme-evening','theme-late','theme-final');
  if      (h >= 22) body.classList.add('theme-final');
  else if (h >= 20) body.classList.add('theme-late');
  else if (h >= 17) body.classList.add('theme-evening');
  else               body.classList.add('theme-morning');
}

// ─────────────────────────────────────────────
// 10. TIME REALITY CHECK
// ─────────────────────────────────────────────
function checkTimeReality() {
  const now = new Date();
  const end = new Date(); end.setHours(CONFIG.END_HOUR, CONFIG.END_MIN, 0, 0);
  const minsLeft = Math.max(0, (end - now) / 60000);

  const today = todayISO();
  const pending = state.tasks.filter(t => t.status === 'pending' && (!t.dueDate || t.dueDate === today));
  const totalEst = pending.reduce((s, t) => s + (t.estimatedMinutes || 0), 0);

  if (totalEst > minsLeft && pending.length > 0) {
    const hrsNeeded = (totalEst / 60).toFixed(1);
    const hrsLeft   = (minsLeft / 60).toFixed(1);
    document.getElementById('modal-msg').textContent =
      `Your pending tasks need ~${hrsNeeded}h, but you only have ${hrsLeft}h until 11 PM. Want to move the lower-priority tasks to tomorrow?`;
    document.getElementById('time-modal').classList.remove('hidden');
  }
}

// ─────────────────────────────────────────────
// 11. STREAK TRACKING
// ─────────────────────────────────────────────
function updateStreak() {
  const streak = loadStreak();
  const today = todayISO();
  const yesterday = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().split('T')[0]; })();

  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const allDone = todayTasks.length > 0 && todayTasks.every(t => t.status === 'done');

  if (allDone && streak.lastDate !== today) {
    streak.count = (streak.lastDate === yesterday) ? streak.count + 1 : 1;
    streak.lastDate = today;
    saveStreak(streak);
  }

  document.getElementById('streak-num').textContent = streak.count;
}

// ─────────────────────────────────────────────
// 12. DASHBOARD METRICS
// ─────────────────────────────────────────────
function updateDashboard() {
  const today = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const total   = todayTasks.length;
  const done    = todayTasks.filter(t => t.status === 'done').length;
  const pending = total - done;
  const pct     = total ? Math.round((done / total) * 100) : 0;

  document.getElementById('s-total').textContent   = total;
  document.getElementById('s-done').textContent    = done;
  document.getElementById('s-pending').textContent = pending;
  document.getElementById('ring-pct').textContent  = pct + '%';

  // SVG ring
  const circ = 238.76;
  const offset = circ - (circ * pct / 100);
  document.getElementById('ring-circle').style.strokeDashoffset = offset;

  updateStreak();
}

// ─────────────────────────────────────────────
// 13. RENDER TASKS
// ─────────────────────────────────────────────
function renderAll() {
  const today = todayISO();
  const todayTasks = state.tasks.filter(t => !t.dueDate || t.dueDate === today);
  const pending = todayTasks.filter(t => t.status === 'pending');
  const done    = todayTasks.filter(t => t.status === 'done');

  renderList('pending-list', 'empty-pending', pending, 'pending-count', false);
  renderList('tada-list',    'empty-tada',    done,    'done-count',    true);
  updateDashboard();

  // Focus task
  const topTask = pending.sort((a,b) => {
    const pri = {high:0,medium:1,low:2};
    return (pri[a.priority]||1) - (pri[b.priority]||1);
  })[0];
  document.getElementById('focus-task-text').textContent = topTask ? topTask.task : 'All tasks complete! 🎉';
}

function renderList(listId, emptyId, tasks, countId, isDone) {
  const list  = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  const count = document.getElementById(countId);

  count.textContent = tasks.length;

  if (!tasks.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = tasks.map(t => taskHTML(t, isDone)).join('');

  // Attach events
  list.querySelectorAll('.task-check').forEach(btn => {
    btn.addEventListener('click', () => toggleTask(btn.dataset.id));
  });
  list.querySelectorAll('.task-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteTask(btn.dataset.id));
  });
}

function taskHTML(t, isDone) {
  const energyLabel = t.energyLevel === 'high' ? '⚡ High Energy' : '🌊 Low Energy';
  const timeLabel   = t.estimatedMinutes ? `⏱ ${t.estimatedMinutes < 60 ? t.estimatedMinutes+'m' : (t.estimatedMinutes/60).toFixed(1)+'h'}` : '';
  const domainTags  = (t.tags||[]).map(tag => `<span class="tag tag-domain">${tag}</span>`).join('');

  return `
    <div class="task-item ${isDone ? 'done' : ''}">
      <button class="task-check" data-id="${t.id}" title="${isDone ? 'Mark pending' : 'Mark done'}">
        ${isDone ? '✓' : ''}
      </button>
      <div class="task-body">
        <div class="task-text">${escHtml(t.task)}</div>
        <div class="task-meta">
          <span class="tag tag-priority-${t.priority||'medium'}">${t.priority||'medium'}</span>
          <span class="tag tag-energy-${t.energyLevel||'low'}">${energyLabel}</span>
          ${timeLabel ? `<span class="tag tag-time">${timeLabel}</span>` : ''}
          ${domainTags}
        </div>
      </div>
      <button class="task-delete" data-id="${t.id}" title="Delete task">✕</button>
    </div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
// 14. TASK ACTIONS
// ─────────────────────────────────────────────
function toggleTask(id) {
  const t = state.tasks.find(t => t.id === id);
  if (!t) return;
  t.status = t.status === 'done' ? 'pending' : 'done';
  saveTasks();
  renderAll();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveTasks();
  renderAll();
}

function pushOverflowToTomorrow() {
  const today = todayISO();
  const tmr   = tomorrowISO();
  const pending = state.tasks.filter(t => t.status === 'pending' && (!t.dueDate || t.dueDate === today));
  if (!pending.length) return;

  // Push lower-priority pending tasks to tomorrow
  const sorted = [...pending].sort((a,b)=>{const p={high:0,medium:1,low:2};return (p[a.priority]||1)-(p[b.priority]||1);});
  const now = new Date();
  const end = new Date(); end.setHours(CONFIG.END_HOUR,CONFIG.END_MIN,0,0);
  const minsLeft = Math.max(0,(end-now)/60000);
  let accum = 0;

  for (const t of sorted) {
    accum += t.estimatedMinutes || 0;
    if (accum > minsLeft) {
      const task = state.tasks.find(x => x.id === t.id);
      if (task) task.dueDate = tmr;
    }
  }
  saveTasks();
  renderAll();
  showToast('Overflow tasks moved to tomorrow 📅', 'success');
}

// ─────────────────────────────────────────────
// 15. SPEECH RECOGNITION
// ─────────────────────────────────────────────
let recognition = null;

function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const r = new SpeechRecognition();
  r.continuous      = true;
  r.interimResults  = true;
  r.lang            = 'en-US';

  const ta = document.getElementById('transcript');
  let finalText = '';

  r.onstart = () => {
    state.isListening = true;
    document.getElementById('mic-btn').classList.add('listening');
    setVoiceStatus('🔴 Listening...', 'listening');
    finalText = ta.value;
  };

  r.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t + ' ';
      else interim = t;
    }
    ta.value = finalText + interim;
  };

  r.onerror = e => {
    if (e.error === 'no-speech') return; // ignore silence
    showToast(`Mic error: ${e.error}. Please try again.`, 'error');
    stopListening();
  };

  r.onend = () => {
    if (state.isListening) r.start(); // keep going if still active
  };

  return r;
}

function startListening() {
  if (!recognition) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      showToast('Voice not supported in this browser. Use Chrome! 🎤', 'error');
      return;
    }
    recognition = initSpeech();
  }
  recognition.start();
}

function stopListening() {
  state.isListening = false;
  document.getElementById('mic-btn').classList.remove('listening');
  setVoiceStatus('Ready', '');
  if (recognition) { try { recognition.stop(); } catch(_) {} }
}

// ─────────────────────────────────────────────
// 16. UI HELPERS
// ─────────────────────────────────────────────
function setLoading(on, text = 'Thinking...') {
  document.getElementById('loading-overlay').classList.toggle('hidden', !on);
  document.getElementById('loading-text').textContent = text;
}

function setVoiceStatus(text, cls) {
  const el = document.getElementById('voice-status');
  el.textContent = text;
  el.className = 'voice-status ' + cls;
}

function showToast(msg, type = 'info') {
  const existing = document.getElementById('dayflow-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'dayflow-toast';
  const colors = { success:'#34d399', warn:'#fbbf24', error:'#f87171', info:'#38bdf8' };
  toast.style.cssText = `
    position:fixed; bottom:32px; left:50%; transform:translateX(-50%);
    background:#1a1a2e; border:1px solid ${colors[type]||colors.info};
    color:#f0f0ff; padding:12px 24px; border-radius:12px;
    font-family:'Outfit',sans-serif; font-size:0.9rem; font-weight:500;
    box-shadow:0 8px 32px rgba(0,0,0,0.5); z-index:9999;
    animation:slide-in 0.3s ease both;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function toggleFocusMode() {
  state.focusMode = !state.focusMode;
  document.getElementById('focus-overlay').classList.toggle('hidden', !state.focusMode);
  document.getElementById('focus-btn').classList.toggle('active', state.focusMode);
}

function updateCoachUI() {
  const icon  = document.getElementById('coach-icon');
  const label = document.getElementById('coach-label');
  const avatar = document.getElementById('coach-avatar');
  if (state.coachMode === 'tough') {
    icon.textContent  = '🔥';
    label.textContent = 'Tough Love';
    avatar.textContent = '😤';
    document.getElementById('coach-toggle').classList.add('active');
  } else {
    icon.textContent  = '🧠';
    label.textContent = 'Coach';
    avatar.textContent = '🤖';
    document.getElementById('coach-toggle').classList.remove('active');
  }
}

// ─────────────────────────────────────────────
// 17. EVENT LISTENERS
// ─────────────────────────────────────────────
function attachEvents() {
  // Mic button — toggle
  document.getElementById('mic-btn').addEventListener('click', () => {
    if (state.isListening) stopListening();
    else startListening();
  });

  // Process button
  document.getElementById('process-btn').addEventListener('click', () => {
    const text = document.getElementById('transcript').value.trim();
    processCommand(text);
  });

  // Enter key in textarea (Ctrl+Enter or Cmd+Enter)
  document.getElementById('transcript').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('process-btn').click();
    }
  });

  // Clear transcript
  document.getElementById('clear-btn').addEventListener('click', () => {
    document.getElementById('transcript').value = '';
    if (state.isListening) stopListening();
  });

  // Focus mode
  document.getElementById('focus-btn').addEventListener('click', toggleFocusMode);
  document.getElementById('exit-focus-btn').addEventListener('click', toggleFocusMode);

  // Coach toggle
  document.getElementById('coach-toggle').addEventListener('click', () => {
    state.coachMode = state.coachMode === 'coach' ? 'tough' : 'coach';
    saveCoachMode();
    updateCoachUI();
    loadCoach();
  });

  // Refresh coach
  document.getElementById('refresh-coach').addEventListener('click', loadCoach);

  // Time reality modal
  document.getElementById('modal-dismiss').addEventListener('click', () => {
    document.getElementById('time-modal').classList.add('hidden');
  });
  document.getElementById('modal-push').addEventListener('click', () => {
    pushOverflowToTomorrow();
    document.getElementById('time-modal').classList.add('hidden');
  });
}

// ─────────────────────────────────────────────
// 18. INIT
// ─────────────────────────────────────────────
async function init() {
  loadTasks();
  loadCoachMode();
  updateCoachUI();
  renderAll();
  updateCountdown();

  // Countdown: update every second
  setInterval(updateCountdown, 1000);

  // Load coach greeting
  loadCoach();

  // Attach all events
  attachEvents();

  // Auto-archive yesterday if not done (async — saves to server)
  if (typeof autoArchiveYesterday === 'function') await autoArchiveYesterday();

  // Seed demo tasks if first visit
  if (!state.tasks.length && !localStorage.getItem('dayflow_visited')) {
    localStorage.setItem('dayflow_visited', '1');
    state.tasks = [
      { id: uid(), task: 'Review project proposal', status: 'pending', priority: 'high', energyLevel: 'high', estimatedMinutes: 45, tags: ['work'], dueDate: null },
      { id: uid(), task: 'Reply to team emails', status: 'pending', priority: 'medium', energyLevel: 'low', estimatedMinutes: 20, tags: ['work','email'], dueDate: null },
      { id: uid(), task: 'Go for a 30-min walk', status: 'done', priority: 'medium', energyLevel: 'high', estimatedMinutes: 30, tags: ['health'], dueDate: null },
    ];
    saveTasks();
    renderAll();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Attach plan/history events
  if (typeof attachFeatureEvents === 'function') attachFeatureEvents();

  // No login — init directly
  init();
});
