const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL;');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',        -- todo | in_progress | done
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  total_seconds INTEGER NOT NULL DEFAULT 0,   -- cumulative tracked time
  is_running INTEGER NOT NULL DEFAULT 0,      -- 0/1 timer active flag
  running_since TEXT,                         -- ISO timestamp when current run started
  priority TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high
  due_date TEXT,                              -- ISO date (YYYY-MM-DD), optional
  tags TEXT NOT NULL DEFAULT ''               -- comma-separated tag list
);

CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  seconds INTEGER DEFAULT 0,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
`);

// ---------- Lightweight migration for databases created before these columns existed ----------
const existingCols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
if (!existingCols.includes('priority')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`);
}
if (!existingCols.includes('due_date')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN due_date TEXT`);
}
if (!existingCols.includes('tags')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
}

module.exports = db;
