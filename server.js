const express = require('express');
const path = require('path');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 4000;

// Minimal CORS (no extra dependency needed)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function nowISO() {
  return new Date().toISOString();
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

// Stops a running timer for a task, logs the elapsed seconds, returns updated task
function stopTimerInternal(task) {
  if (!task.is_running) return task;
  const start = new Date(task.running_since);
  const end = new Date();
  const seconds = Math.max(0, Math.round((end - start) / 1000));

  db.prepare(
    `UPDATE time_logs SET end_time = ?, seconds = ?
     WHERE task_id = ? AND end_time IS NULL`
  ).run(end.toISOString(), seconds, task.id);

  db.prepare(
    `UPDATE tasks SET is_running = 0, running_since = NULL, total_seconds = total_seconds + ?
     WHERE id = ?`
  ).run(seconds, task.id);

  return getTask(task.id);
}

// ---------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------

// List all tasks (grouped implicitly by status, ordered by position)
app.get('/api/tasks', (req, res) => {
  const tasks = db
    .prepare('SELECT * FROM tasks ORDER BY status, position ASC, id ASC')
    .all();
  res.json(tasks);
});

// Normalizes a comma/space separated tag string into a clean "tag1,tag2" form
function normalizeTags(raw) {
  if (raw == null) return null;
  const parts = String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(parts)].join(',');
}

const VALID_PRIORITIES = ['low', 'medium', 'high'];

// Create task
app.post('/api/tasks', (req, res) => {
  const { title, description = '', priority = 'medium', due_date = null, tags = '' } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const finalPriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
  const finalTags = normalizeTags(tags) || '';

  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE status = 'todo'`)
    .get().m;

  const info = db
    .prepare(
      `INSERT INTO tasks (title, description, status, position, priority, due_date, tags)
       VALUES (?, ?, 'todo', ?, ?, ?, ?)`
    )
    .run(title.trim(), description, maxPos + 1, finalPriority, due_date || null, finalTags);

  res.json(getTask(info.lastInsertRowid));
});

// Update task (title/description/priority/due date/tags).
// node:sqlite will not bind `undefined`, so every value is resolved to a
// concrete final value (falling back to the task's current value) before binding.
app.put('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { title, description, priority, due_date, tags } = req.body;

  const finalTitle = title != null && title.trim() ? title.trim() : task.title;
  const finalDescription = description != null ? description : task.description;
  const finalPriority = priority != null && VALID_PRIORITIES.includes(priority) ? priority : task.priority;
  const finalTags = tags != null ? normalizeTags(tags) : task.tags;
  // due_date: allow explicitly clearing it by sending due_date: "" or null
  const finalDueDate = due_date !== undefined ? (due_date || null) : task.due_date;

  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?, tags = ? WHERE id = ?`
  ).run(finalTitle, finalDescription, finalPriority, finalDueDate, finalTags, req.params.id);

  res.json(getTask(req.params.id));
});

// Move task (change status/column and/or position)
app.put('/api/tasks/:id/move', (req, res) => {
  let task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { status, position = 0 } = req.body;
  const validStatuses = ['todo', 'in_progress', 'done'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // If leaving in_progress while running, stop the timer first
  if (task.status === 'in_progress' && status !== 'in_progress' && task.is_running) {
    task = stopTimerInternal(task);
  }

  const completed_at = status === 'done' ? nowISO() : null;

  db.prepare(
    `UPDATE tasks SET status = ?, position = ?, completed_at = ? WHERE id = ?`
  ).run(status, position, completed_at, req.params.id);

  res.json(getTask(req.params.id));
});

// Distinct list of tags currently in use (for filter dropdown)
app.get('/api/tags', (req, res) => {
  const rows = db.prepare(`SELECT tags FROM tasks WHERE tags != ''`).all();
  const tagSet = new Set();
  rows.forEach((r) => r.tags.split(',').forEach((t) => t && tagSet.add(t)));
  res.json([...tagSet].sort());
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------
// Timer control: start / pause / complete
// ---------------------------------------------------------------

// Start (or resume) timer on a task. Pauses any other currently running task.
app.post('/api/tasks/:id/start', (req, res) => {
  let task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Pause any other running task (only one active timer at a time)
  const otherRunning = db.prepare(`SELECT * FROM tasks WHERE is_running = 1 AND id != ?`).all(req.params.id);
  otherRunning.forEach((t) => stopTimerInternal(t));

  if (!task.is_running) {
    const start = nowISO();
    db.prepare(
      `UPDATE tasks SET is_running = 1, running_since = ?, status = CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END WHERE id = ?`
    ).run(start, req.params.id);
    db.prepare(`INSERT INTO time_logs (task_id, start_time) VALUES (?, ?)`).run(req.params.id, start);
  }

  res.json(getTask(req.params.id));
});

// Pause timer
app.post('/api/tasks/:id/pause', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updated = stopTimerInternal(task);
  res.json(updated);
});

// Mark complete (stops timer if running, moves to done)
app.post('/api/tasks/:id/complete', (req, res) => {
  let task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  task = stopTimerInternal(task);

  const maxPos = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE status = 'done'`)
    .get().m;

  db.prepare(
    `UPDATE tasks SET status = 'done', completed_at = ?, position = ? WHERE id = ?`
  ).run(nowISO(), maxPos + 1, req.params.id);

  res.json(getTask(req.params.id));
});

// Get "live" elapsed seconds for a running task (for frontend polling)
app.get('/api/tasks/:id/elapsed', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  let live = task.total_seconds;
  if (task.is_running && task.running_since) {
    live += Math.max(0, Math.round((Date.now() - new Date(task.running_since).getTime()) / 1000));
  }
  res.json({ total_seconds: live, is_running: !!task.is_running });
});

// ---------------------------------------------------------------
// Reports & summaries
// ---------------------------------------------------------------

// Custom date-range report: time spent per task + totals
app.get('/api/reports/range', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params (YYYY-MM-DD) required' });
  }
  const startISO = `${start}T00:00:00.000Z`;
  const endISO = `${end}T23:59:59.999Z`;

  const rows = db
    .prepare(
      `SELECT t.id as task_id, t.title, t.status,
              SUM(l.seconds) as seconds,
              COUNT(l.id) as sessions
       FROM time_logs l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.end_time IS NOT NULL AND l.start_time >= ? AND l.start_time <= ?
       GROUP BY t.id
       ORDER BY seconds DESC`
    )
    .all(startISO, endISO);

  const completed = db
    .prepare(
      `SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND completed_at >= ? AND completed_at <= ?`
    )
    .get(startISO, endISO).c;

  const totalSeconds = rows.reduce((s, r) => s + (r.seconds || 0), 0);

  res.json({ start, end, tasks: rows, totalSeconds, completedCount: completed });
});

// CSV export for a custom date range — same data as /api/reports/range, as a downloadable file
app.get('/api/reports/range/csv', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params (YYYY-MM-DD) required' });
  }
  const startISO = `${start}T00:00:00.000Z`;
  const endISO = `${end}T23:59:59.999Z`;

  const rows = db
    .prepare(
      `SELECT t.title, t.status, t.priority, t.tags,
              SUM(l.seconds) as seconds,
              COUNT(l.id) as sessions
       FROM time_logs l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.end_time IS NOT NULL AND l.start_time >= ? AND l.start_time <= ?
       GROUP BY t.id
       ORDER BY seconds DESC`
    )
    .all(startISO, endISO);

  const escapeCsv = (val) => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['Task', 'Status', 'Priority', 'Tags', 'Sessions', 'Seconds', 'Hours'];
  const lines = [header.join(',')];
  rows.forEach((r) => {
    lines.push(
      [
        escapeCsv(r.title),
        escapeCsv(r.status),
        escapeCsv(r.priority),
        escapeCsv(r.tags),
        r.sessions,
        r.seconds,
        (r.seconds / 3600).toFixed(2),
      ].join(',')
    );
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="report_${start}_to_${end}.csv"`);
  res.send(lines.join('\n'));
});

// Weekly summary (current week, Mon-Sun) + daily breakdown
app.get('/api/reports/weekly', (req, res) => {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Mon=0
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - day);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dayStart = new Date(d);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);

    const seconds = db
      .prepare(
        `SELECT COALESCE(SUM(seconds),0) as s FROM time_logs
         WHERE end_time IS NOT NULL AND start_time >= ? AND start_time <= ?`
      )
      .get(dayStart.toISOString(), dayEnd.toISOString()).s;

    const completed = db
      .prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='done' AND completed_at >= ? AND completed_at <= ?`)
      .get(dayStart.toISOString(), dayEnd.toISOString()).c;

    days.push({
      date: dayStart.toISOString().slice(0, 10),
      label: dayStart.toLocaleDateString('en-US', { weekday: 'short' }),
      seconds,
      completed,
    });
  }

  const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
  const totalCompleted = days.reduce((s, d) => s + d.completed, 0);

  res.json({ rangeStart: days[0].date, rangeEnd: days[6].date, days, totalSeconds, totalCompleted });
});

// Monthly summary (current month) + weekly breakdown within month
app.get('/api/reports/monthly', (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const totalSeconds = db
    .prepare(
      `SELECT COALESCE(SUM(seconds),0) as s FROM time_logs
       WHERE end_time IS NOT NULL AND start_time >= ? AND start_time <= ?`
    )
    .get(monthStart.toISOString(), monthEnd.toISOString()).s;

  const totalCompleted = db
    .prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='done' AND completed_at >= ? AND completed_at <= ?`)
    .get(monthStart.toISOString(), monthEnd.toISOString()).c;

  // Weekly buckets within the month
  const weeks = [];
  let cursor = new Date(monthStart);
  while (cursor <= monthEnd) {
    const wStart = new Date(cursor);
    const wEnd = new Date(cursor);
    wEnd.setDate(wEnd.getDate() + 6);
    const effectiveEnd = wEnd > monthEnd ? monthEnd : wEnd;

    const seconds = db
      .prepare(
        `SELECT COALESCE(SUM(seconds),0) as s FROM time_logs
         WHERE end_time IS NOT NULL AND start_time >= ? AND start_time <= ?`
      )
      .get(wStart.toISOString(), new Date(effectiveEnd.getTime() + 999).toISOString()).s;

    weeks.push({
      start: wStart.toISOString().slice(0, 10),
      end: effectiveEnd.toISOString().slice(0, 10),
      seconds,
    });

    cursor.setDate(cursor.getDate() + 7);
  }

  // Top tasks this month
  const topTasks = db
    .prepare(
      `SELECT t.title, SUM(l.seconds) as seconds
       FROM time_logs l JOIN tasks t ON t.id = l.task_id
       WHERE l.end_time IS NOT NULL AND l.start_time >= ? AND l.start_time <= ?
       GROUP BY t.id ORDER BY seconds DESC LIMIT 5`
    )
    .all(monthStart.toISOString(), monthEnd.toISOString());

  res.json({
    month: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    totalSeconds,
    totalCompleted,
    weeks,
    topTasks,
  });
});

app.listen(PORT, () => {
  console.log(`Task Tracker running at http://localhost:${PORT}`);
});
