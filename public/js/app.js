const API = '/api';

// ---------------- State ----------------
let tasks = [];
let editingTaskId = null;      // task id being created/edited in the task modal
let draggingId = null;
let filterPriority = '';
let filterTag = '';

// Idle / break-reminder tracking
const BREAK_THRESHOLD_MS = 45 * 60 * 1000;   // nudge after 45 min of continuous focus work
const SNOOZE_MS = 5 * 60 * 1000;
let continuousStart = null;    // when the currently-running task started (ms)
let breakPopupShownAt = null;
let snoozeUntil = null;

// ---------------- Utilities ----------------
function fmtDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtHoursMinutes(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatDueDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// For a running task, total_seconds from the server is a snapshot that excludes
// the currently-open segment. Add the time elapsed since running_since so the
// card never flashes back down when a full task-list refresh re-renders it.
function liveTotalSeconds(task) {
  if (!task.is_running || !task.running_since) return task.total_seconds;
  const elapsedSinceStart = Math.max(0, Math.floor((Date.now() - new Date(task.running_since).getTime()) / 1000));
  return task.total_seconds + elapsedSinceStart;
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ---------------- Clock ----------------
function tickClock() {
  const el = document.getElementById('clock');
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------- Data loading ----------------
async function loadTasks() {
  tasks = await api('/tasks');
  render();
}

// ---------------- Rendering ----------------
function passesFilters(task) {
  if (filterPriority && task.priority !== filterPriority) return false;
  if (filterTag) {
    const taskTags = (task.tags || '').split(',').filter(Boolean);
    if (!taskTags.includes(filterTag)) return false;
  }
  return true;
}

function isOverdue(task) {
  if (!task.due_date || task.status === 'done') return false;
  const today = new Date().toISOString().slice(0, 10);
  return task.due_date < today;
}

function render() {
  const cols = { todo: [], in_progress: [], done: [] };
  tasks.filter(passesFilters).forEach((t) => cols[t.status].push(t));

  Object.entries(cols).forEach(([status, list]) => {
    const container = document.getElementById(`col-${status}`);
    container.innerHTML = '';
    document.getElementById(`count-${status}`).textContent = list.length;

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-col';
      empty.textContent = tasks.length === 0
        ? (status === 'todo' ? 'No tasks yet' : status === 'in_progress' ? 'Nothing in progress' : 'Nothing completed yet')
        : 'No tasks match the current filters';
      container.appendChild(empty);
      return;
    }

    list.forEach((task) => container.appendChild(renderCard(task)));
  });

  // Track continuous-work start for break popup — use the server's own
  // running_since timestamp directly, no need to reconstruct it from polling.
  const running = tasks.find((t) => t.is_running);
  if (running) {
    continuousStart = new Date(running.running_since).getTime();
  } else {
    continuousStart = null;
    breakPopupShownAt = null;
  }
}

function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'card' + (task.is_running ? ' running' : '');
  card.draggable = true;
  card.dataset.id = task.id;

  card.addEventListener('dragstart', () => {
    draggingId = task.id;
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggingId = null;
  });

  const topRow = document.createElement('div');
  topRow.className = 'card-top-row';

  const badge = document.createElement('span');
  badge.className = `priority-badge ${task.priority}`;
  badge.textContent = task.priority;
  topRow.appendChild(badge);

  if (task.due_date) {
    const due = document.createElement('span');
    due.className = 'due-pill' + (isOverdue(task) ? ' overdue' : '');
    due.textContent = (isOverdue(task) ? 'Overdue · ' : 'Due ') + formatDueDate(task.due_date);
    topRow.appendChild(due);
  }
  card.appendChild(topRow);

  const title = document.createElement('p');
  title.className = 'card-title';
  title.textContent = task.title;
  card.appendChild(title);

  if (task.description) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = task.description;
    card.appendChild(desc);
  }

  const taskTags = (task.tags || '').split(',').filter(Boolean);
  if (taskTags.length > 0) {
    const tagWrap = document.createElement('div');
    tagWrap.className = 'card-tags';
    taskTags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      tagWrap.appendChild(chip);
    });
    card.appendChild(tagWrap);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const timeEl = document.createElement('span');
  timeEl.className = 'card-time';
  timeEl.innerHTML = `<span class="pulse-dot"></span><span class="time-val" data-id="${task.id}">${fmtDuration(liveTotalSeconds(task))}</span>`;
  meta.appendChild(timeEl);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (task.status !== 'done') {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'icon-btn start';
    toggleBtn.title = task.is_running ? 'Pause' : 'Start';
    toggleBtn.textContent = task.is_running ? '⏸' : '▶';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      task.is_running ? pauseTask(task.id) : startTask(task.id);
    });
    actions.appendChild(toggleBtn);

    const completeBtn = document.createElement('button');
    completeBtn.className = 'icon-btn complete';
    completeBtn.title = 'Mark complete';
    completeBtn.textContent = '✓';
    completeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      completeTask(task.id);
    });
    actions.appendChild(completeBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn danger';
  deleteBtn.title = 'Delete';
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });
  actions.appendChild(deleteBtn);

  meta.appendChild(actions);
  card.appendChild(meta);
  return card;
}

// ---------------- Drag & drop ----------------
document.querySelectorAll('.column-body').forEach((col) => {
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    col.classList.add('drag-over');
  });
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('drag-over');
    if (draggingId == null) return;
    const status = col.parentElement.dataset.status;
    const position = col.children.length;
    await api(`/tasks/${draggingId}/move`, {
      method: 'PUT',
      body: JSON.stringify({ status, position }),
    });
    await loadTasks();
  });
});

// ---------------- Task actions ----------------
async function startTask(id) {
  await api(`/tasks/${id}/start`, { method: 'POST' });
  breakPopupShownAt = null;
  await loadTasks();
}

async function pauseTask(id) {
  await api(`/tasks/${id}/pause`, { method: 'POST' });
  await loadTasks();
}

async function completeTask(id) {
  await api(`/tasks/${id}/complete`, { method: 'POST' });
  await loadTasks();
}

async function deleteTask(id) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  await loadTasks();
}

// ---------------- New task modal ----------------
const taskBackdrop = document.getElementById('modal-task-backdrop');

function openNewTaskModal() {
  editingTaskId = null;
  document.getElementById('modal-task-title').textContent = 'New task';
  document.getElementById('input-title').value = '';
  document.getElementById('input-desc').value = '';
  document.getElementById('input-priority').value = 'medium';
  document.getElementById('input-due').value = '';
  document.getElementById('input-tags').value = '';
  taskBackdrop.classList.add('open');
  document.getElementById('input-title').focus();
}

document.getElementById('btn-new-task').addEventListener('click', openNewTaskModal);
document.getElementById('btn-cancel-task').addEventListener('click', () => taskBackdrop.classList.remove('open'));
taskBackdrop.addEventListener('click', (e) => { if (e.target === taskBackdrop) taskBackdrop.classList.remove('open'); });

document.getElementById('btn-save-task').addEventListener('click', async () => {
  const title = document.getElementById('input-title').value.trim();
  const description = document.getElementById('input-desc').value.trim();
  const priority = document.getElementById('input-priority').value;
  const due_date = document.getElementById('input-due').value || null;
  const tags = document.getElementById('input-tags').value.trim();
  if (!title) return;
  await api('/tasks', { method: 'POST', body: JSON.stringify({ title, description, priority, due_date, tags }) });
  taskBackdrop.classList.remove('open');
  await loadTasks();
  await loadTagOptions();
});

document.getElementById('input-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || document.activeElement.id === 'input-title')) {
    document.getElementById('btn-save-task').click();
  }
});

// ---------------- Filters ----------------
document.getElementById('filter-priority').addEventListener('change', (e) => {
  filterPriority = e.target.value;
  render();
});
document.getElementById('filter-tag').addEventListener('change', (e) => {
  filterTag = e.target.value;
  render();
});
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  filterPriority = '';
  filterTag = '';
  document.getElementById('filter-priority').value = '';
  document.getElementById('filter-tag').value = '';
  render();
});

async function loadTagOptions() {
  const tags = await api('/tags');
  const select = document.getElementById('filter-tag');
  const current = select.value;
  select.innerHTML = '<option value="">All</option>' + tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  select.value = tags.includes(current) ? current : '';
}

// ---------------- Dark mode ----------------
const THEME_KEY = 'ledger-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('btn-theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(saved);
})();
document.getElementById('btn-theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------------- Keyboard shortcuts ----------------
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
    [taskBackdrop, breakBackdropRef(), reportsBackdropRef()].forEach((el) => el && el.classList.remove('open'));
    return;
  }
  if (typing) return;

  if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openNewTaskModal();
  } else if (e.key === ' ') {
    const running = tasks.find((t) => t.is_running);
    if (running) {
      e.preventDefault();
      pauseTask(running.id);
    }
  }
});
function breakBackdropRef() { return document.getElementById('modal-break-backdrop'); }
function reportsBackdropRef() { return document.getElementById('modal-reports-backdrop'); }

// ---------------- Live timer polling (updates running card's displayed time) ----------------
// Ticks purely from local data — task.total_seconds + time elapsed since running_since —
// so the displayed number only ever counts up, with no round-trip lag or corrective jumps.
function pollRunningTask() {
  const running = tasks.find((t) => t.is_running);
  if (!running) return;
  const el = document.querySelector(`.time-val[data-id="${running.id}"]`);
  if (el) el.textContent = fmtDuration(liveTotalSeconds(running));
  checkBreakReminder();
}
setInterval(pollRunningTask, 1000);

// ---------------- Break reminder (desktop long-session nudge) ----------------
const breakBackdrop = document.getElementById('modal-break-backdrop');

function checkBreakReminder() {
  if (!continuousStart) return;
  if (snoozeUntil && Date.now() < snoozeUntil) return;
  if (breakPopupShownAt) return; // already showing

  const elapsed = Date.now() - continuousStart;
  if (elapsed >= BREAK_THRESHOLD_MS) {
    const running = tasks.find((t) => t.is_running);
    document.getElementById('break-message').textContent = running
      ? `You've been working on "${running.title}" for over ${Math.floor(BREAK_THRESHOLD_MS / 60000)} minutes straight. Step away for a few minutes.`
      : `You've been working continuously for a while. Step away for a few minutes.`;
    breakBackdrop.classList.add('open');
    breakPopupShownAt = Date.now();
  }
}

document.getElementById('btn-take-break').addEventListener('click', async () => {
  const running = tasks.find((t) => t.is_running);
  breakBackdrop.classList.remove('open');
  if (running) await pauseTask(running.id);
  continuousStart = null;
  breakPopupShownAt = null;
});

document.getElementById('btn-snooze-break').addEventListener('click', () => {
  breakBackdrop.classList.remove('open');
  breakPopupShownAt = null;
  snoozeUntil = Date.now() + SNOOZE_MS;
  continuousStart = Date.now() - (BREAK_THRESHOLD_MS - SNOOZE_MS); // will re-trigger after snooze if still running
});

// Detect tab/desktop refocus: also check immediately when window regains focus
window.addEventListener('focus', checkBreakReminder);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkBreakReminder();
});

// ---------------- Reports ----------------
const reportsBackdrop = document.getElementById('modal-reports-backdrop');
document.getElementById('btn-reports').addEventListener('click', () => {
  reportsBackdrop.classList.add('open');
  loadWeekly();
  loadMonthly();
});
document.getElementById('btn-close-reports').addEventListener('click', () => reportsBackdrop.classList.remove('open'));
reportsBackdrop.addEventListener('click', (e) => { if (e.target === reportsBackdrop) reportsBackdrop.classList.remove('open'); });

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

function renderBarChart(container, items, valueKey, labelKey) {
  container.innerHTML = '';
  const max = Math.max(1, ...items.map((i) => i[valueKey]));
  items.forEach((item) => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const heightPct = Math.max(2, (item[valueKey] / max) * 100);
    col.innerHTML = `
      <span class="bar-value">${item[valueKey] > 0 ? fmtDuration(item[valueKey]) : ''}</span>
      <div class="bar" style="height:${heightPct}%"></div>
      <span class="bar-label">${item[labelKey]}</span>
    `;
    container.appendChild(col);
  });
}

async function loadWeekly() {
  const data = await api('/reports/weekly');
  document.getElementById('week-total-time').textContent = fmtHoursMinutes(data.totalSeconds);
  document.getElementById('week-total-done').textContent = data.totalCompleted;
  renderBarChart(document.getElementById('week-chart'), data.days, 'seconds', 'label');
}

async function loadMonthly() {
  const data = await api('/reports/monthly');
  document.getElementById('month-total-time').textContent = fmtHoursMinutes(data.totalSeconds);
  document.getElementById('month-total-done').textContent = data.totalCompleted;
  document.getElementById('month-name').textContent = `Weekly breakdown — ${data.month}`;

  const weekItems = data.weeks.map((w, i) => ({
    seconds: w.seconds,
    label: `W${i + 1}`,
  }));
  renderBarChart(document.getElementById('month-chart'), weekItems, 'seconds', 'label');

  const topList = document.getElementById('month-top-tasks');
  topList.innerHTML = '';
  if (data.topTasks.length === 0) {
    topList.innerHTML = '<li style="justify-content:center;color:var(--ink-soft);">No tracked time this month</li>';
  } else {
    data.topTasks.forEach((t) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(t.title)}</span><span class="t-time">${fmtDuration(t.seconds)}</span>`;
      topList.appendChild(li);
    });
  }
}

document.getElementById('btn-run-range').addEventListener('click', async () => {
  const start = document.getElementById('range-start').value;
  const end = document.getElementById('range-end').value;
  if (!start || !end) return;

  const data = await api(`/reports/range?start=${start}&end=${end}`);
  document.getElementById('range-summary').style.display = 'flex';
  document.getElementById('range-total-time').textContent = fmtHoursMinutes(data.totalSeconds);
  document.getElementById('range-total-done').textContent = data.completedCount;

  const tbody = document.getElementById('range-table-body');
  tbody.innerHTML = '';

  if (data.tasks.length === 0) {
    document.getElementById('range-table').style.display = 'none';
    document.getElementById('range-empty').style.display = 'block';
  } else {
    document.getElementById('range-table').style.display = 'table';
    document.getElementById('range-empty').style.display = 'none';
    data.tasks.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(t.title)}</td><td>${t.sessions}</td><td>${fmtDuration(t.seconds)}</td>`;
      tbody.appendChild(tr);
    });
  }
});

document.getElementById('btn-export-csv').addEventListener('click', () => {
  const start = document.getElementById('range-start').value;
  const end = document.getElementById('range-end').value;
  if (!start || !end) return;
  window.location.href = `${API}/reports/range/csv?start=${start}&end=${end}`;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Default range dates: last 7 days
(function initRangeDefaults() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  document.getElementById('range-start').value = start.toISOString().slice(0, 10);
  document.getElementById('range-end').value = end.toISOString().slice(0, 10);
})();

// ---------------- Init ----------------
loadTasks();
loadTagOptions();
setInterval(loadTasks, 15000); // periodic full refresh to stay in sync
