const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Fixed whitelist of products the dashboard tracks. Anything else is rejected
// at the collect endpoint so a typo never silently creates a phantom project.
const PROJECTS = Object.freeze(['greenpoly', 'pet-mbti', 'id-photo', 'followmate']);

function createStore(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      event TEXT NOT NULL,
      anon_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      props TEXT
    );
    CREATE INDEX IF NOT EXISTS events_project_day_idx ON events (project, day);
    CREATE INDEX IF NOT EXISTS events_project_anon_idx ON events (project, anon_id);
  `);

  const insertStmt = database.prepare(
    'INSERT INTO events (project, event, anon_id, ts, day, props) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // Local calendar day (YYYY-MM-DD) so "today" matches the operator's timezone.
  function dayKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function record({ project, event, anonId, ts, props }) {
    const when = Number.isFinite(ts) ? ts : Date.now();
    insertStmt.run(project, event, anonId, when, dayKey(when), props ? JSON.stringify(props) : null);
  }

  // Per-(project, day) rollup. DAU = distinct anon_id that day; newUsers = anon_id
  // whose very first event across all time landed on that day; events = raw count.
  function summary(days) {
    const span = Math.max(1, Math.min(365, Number(days) || 30));
    const rows = database.prepare(`
      WITH firsts AS (
        SELECT project, anon_id, MIN(day) AS first_day FROM events GROUP BY project, anon_id
      )
      SELECT
        e.project AS project,
        e.day AS day,
        COUNT(DISTINCT e.anon_id) AS dau,
        COUNT(*) AS events,
        COUNT(DISTINCT CASE WHEN f.first_day = e.day THEN e.anon_id END) AS newUsers
      FROM events e
      JOIN firsts f ON f.project = e.project AND f.anon_id = e.anon_id
      WHERE e.day >= ?
      GROUP BY e.project, e.day
      ORDER BY e.day ASC
    `).all(cutoffDay(span));
    return rows;
  }

  function cutoffDay(span) {
    const d = new Date();
    d.setDate(d.getDate() - (span - 1));
    return dayKey(d.getTime());
  }

  function close() {
    database.close();
  }

  return { record, summary, dayKey, close, database };
}

module.exports = { createStore, PROJECTS };
