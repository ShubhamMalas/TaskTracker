# Ledger — Daily Task Tracker

A Kanban-style task tracker (To do / In progress / Done) with time tracking,
pause/resume, break reminders, and weekly/monthly/custom-range reports.

Backend: **Node.js + Express**. Database: **SQLite** (via `better-sqlite3`, a native
JS binding — no separate DB server needed). Frontend: plain **HTML/CSS/JS**.

## Setup

Requires [Node.js](https://nodejs.org) (v18+ recommended).

```bash
cd task-tracker
npm install
npm start
```

Then open **http://localhost:4000** in your browser.

The SQLite database file is created automatically at `db/tracker.db` on first run.

## Features

- **Kanban board** — To do, In progress, Done columns.
- **Add / delete tasks**, with optional notes, priority, due date, and tags.
- **Drag and drop** cards between columns to move them.
- **Time tracking** — Start/pause a timer per task. Only one task runs at a time;
  starting a new one auto-pauses whatever was previously running.
- **Complete** — one click marks a task done and stops its timer.
- **Priority levels** — low / medium / high, shown as a colored badge on each card.
- **Due dates** — optional per task; overdue tasks are highlighted in red on the board.
- **Tags** — comma-separated labels per task; filter the board by tag or priority
  using the filter bar under the header.
- **Dark mode** — toggle in the top bar, remembers your choice, and respects your
  system preference on first load.
- **Keyboard shortcuts** — `N` opens the new-task modal, `Space` pauses whichever
  task is currently running, `Esc` closes any open modal.
- **Break reminders** — if you work continuously on one task for 45+ minutes
  (configurable in `public/js/app.js` → `BREAK_THRESHOLD_MS`), a popup asks you
  to take a break, with a 5-minute snooze option.
- **Reports**:
  - **This week** — bar chart of time tracked per day + tasks completed.
  - **This month** — weekly breakdown bar chart + top 5 tasks by time spent.
  - **Custom range** — pick any start/end date to get total time, tasks completed,
    a per-task time breakdown table, and a **CSV export** button.

## Project structure

```
task-tracker/
├── server.js              # Express server + REST API
├── db/
│   ├── database.js        # SQLite schema & connection
│   └── tracker.db         # created on first run
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js           # board rendering, drag/drop, timers, reports UI
└── package.json
```

## API overview

| Method | Route                          | Purpose                          |
|--------|---------------------------------|-----------------------------------|
| GET    | /api/tasks                     | List all tasks                    |
| POST   | /api/tasks                     | Create task (title, description, priority, due_date, tags) |
| PUT    | /api/tasks/:id                 | Edit title/description/priority/due_date/tags (partial updates supported) |
| PUT    | /api/tasks/:id/move             | Change column/position            |
| DELETE | /api/tasks/:id                 | Delete task                       |
| POST   | /api/tasks/:id/start            | Start/resume timer                |
| POST   | /api/tasks/:id/pause            | Pause timer                       |
| POST   | /api/tasks/:id/complete         | Mark done + stop timer            |
| GET    | /api/tasks/:id/elapsed          | Live elapsed seconds              |
| GET    | /api/tags                      | Distinct list of tags in use      |
| GET    | /api/reports/weekly             | Current week summary              |
| GET    | /api/reports/monthly            | Current month summary             |
| GET    | /api/reports/range?start=&end=  | Custom date-range report          |
| GET    | /api/reports/range/csv?start=&end= | Custom date-range report as CSV download |

## Notes on the break reminder

The reminder is based on **continuous active-timer duration**, tracked in the
browser tab — it checks how long a task's timer has been running uninterrupted
and pops up a break suggestion. It also re-checks whenever you return to the
tab/window (e.g. after being away), so it catches you as soon as you're back
at the desktop. Snoozing pushes the next check out by 5 minutes.
