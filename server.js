/* =====================================================================
 *  COURT T — server
 *  - Express REST API for players / courts / matches / session
 *  - SQLite persistence (single file, auto-created)
 *  - Shared group-code auth (one code for the whole crew)
 *  - SSE (Server-Sent Events) for live multi-device updates
 * ===================================================================== */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

/* --- SQLite driver: prefer better-sqlite3 (fast, production-grade);
 *     fall back to node:sqlite (built-in since Node 22) with a thin shim
 *     so prepare().run()/get()/all() work the same either way. --- */
let Database;
try {
  Database = require('better-sqlite3');
  console.log('Using better-sqlite3');
} catch (e) {
  console.log('better-sqlite3 not available — falling back to node:sqlite');
  const { DatabaseSync } = require('node:sqlite');
  Database = function (file) {
    const db = new DatabaseSync(file);
    return {
      exec: (sql) => db.exec(sql),
      pragma: (s) => { try { db.exec('PRAGMA ' + s); } catch (e) {} },
      prepare: (sql) => {
        const stmt = db.prepare(sql);
        return {
          run: (...args) => {
            const r = stmt.run(...args);
            return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
          },
          get: (...args) => stmt.get(...args) ?? undefined,
          all: (...args) => stmt.all(...args),
        };
      },
      transaction: (fn) => () => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    };
  };
}

const PORT = process.env.PORT || 3000;
const GROUP_CODE = process.env.GROUP_CODE || 'squash123';   // set a real one in env
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'court-t.db');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- DB setup ---------- */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    rating    REAL NOT NULL DEFAULT 3.5,
    available INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
  );

  CREATE TABLE IF NOT EXISTS courts (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    p1        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    p2        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    court_id  INTEGER REFERENCES courts(id) ON DELETE SET NULL,
    status    TEXT NOT NULL CHECK (status IN ('queued','live','done')) DEFAULT 'queued',
    started_at INTEGER,
    ended_at   INTEGER,
    s1 INTEGER,
    s2 INTEGER,
    seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    active     INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    duration_ms INTEGER
  );

  INSERT OR IGNORE INTO session (id, active) VALUES (1, 0);
`);

/* ---------- simple auth middleware ---------- */
function auth(req, res, next) {
  const code = req.header('X-Group-Code') || req.query.code;
  if (!code || !constantTimeEq(code, GROUP_CODE)) {
    return res.status(401).json({ error: 'bad code' });
  }
  next();
}
function constantTimeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------- SSE (live broadcast) ---------- */
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  const code = req.query.code;
  if (!code || !constantTimeEq(code, GROUP_CODE)) {
    res.status(401).end();
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
  const client = { res };
  sseClients.add(client);
  req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.res.write(payload); } catch (e) {} }
}

/* ---------- auth check route ---------- */
app.post('/api/auth', (req, res) => {
  const { code } = req.body || {};
  if (!code || !constantTimeEq(code, GROUP_CODE)) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });
});

/* ---------- helpers ---------- */
function getSnapshot() {
  const players = db.prepare(`SELECT id, name, rating, available FROM players ORDER BY id`).all()
    .map(p => ({ ...p, available: !!p.available }));
  const courts = db.prepare(`SELECT id, name FROM courts ORDER BY id`).all();
  const matches = db.prepare(
    `SELECT id, p1, p2, court_id AS courtId, status, started_at AS startedAt,
            ended_at AS endedAt, s1, s2, seq FROM matches ORDER BY seq, id`
  ).all();
  const sess = db.prepare(`SELECT active, started_at AS startedAt, duration_ms AS sessionDuration FROM session WHERE id = 1`).get();
  return {
    players, courts, matches,
    session: sess.active ? { active: true, startedAt: sess.startedAt, sessionDuration: sess.sessionDuration } : null,
  };
}

function emitState() { broadcast('state', getSnapshot()); }

/* ---------- state (single GET gives everything) ---------- */
app.get('/api/state', auth, (req, res) => { res.json(getSnapshot()); });

/* ---------- players ---------- */
app.post('/api/players', auth, (req, res) => {
  const { name, rating = 3.5, available = true } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare(`INSERT INTO players (name, rating, available) VALUES (?, ?, ?)`)
    .run(String(name).trim(), clamp(rating, 1, 7), available ? 1 : 0);
  emitState();
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/players/:id', auth, (req, res) => {
  const { id } = req.params;
  const { name, rating, available } = req.body || {};
  const p = db.prepare(`SELECT * FROM players WHERE id = ?`).get(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE players SET
    name = COALESCE(?, name),
    rating = COALESCE(?, rating),
    available = COALESCE(?, available)
    WHERE id = ?`)
    .run(
      name != null ? String(name).trim() : null,
      rating != null ? clamp(rating, 1, 7) : null,
      available != null ? (available ? 1 : 0) : null,
      id
    );
  emitState();
  res.json({ ok: true });
});

app.delete('/api/players/:id', auth, (req, res) => {
  db.prepare(`DELETE FROM players WHERE id = ?`).run(req.params.id);
  emitState();
  res.json({ ok: true });
});

/* ---------- courts ---------- */
app.post('/api/courts', auth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const info = db.prepare(`INSERT INTO courts (name) VALUES (?)`).run(String(name).trim());
  emitState();
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/courts/:id', auth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  db.prepare(`UPDATE courts SET name = ? WHERE id = ?`).run(String(name).trim(), req.params.id);
  emitState();
  res.json({ ok: true });
});

app.delete('/api/courts/:id', auth, (req, res) => {
  const hasActive = db.prepare(
    `SELECT 1 FROM matches WHERE court_id = ? AND status IN ('queued','live') LIMIT 1`
  ).get(req.params.id);
  if (hasActive) return res.status(400).json({ error: 'court in use' });
  db.prepare(`DELETE FROM courts WHERE id = ?`).run(req.params.id);
  emitState();
  res.json({ ok: true });
});

/* ---------- session / schedule ---------- */
app.post('/api/session/start', auth, (req, res) => {
  const { sessionDuration } = req.body || {};
  const dur = Math.max(30, Math.min(360, parseInt(sessionDuration) || 120)) * 60000;

  const available = db.prepare(`SELECT id, rating FROM players WHERE available = 1`).all();
  if (available.length < 2) return res.status(400).json({ error: 'need 2+ available players' });
  const courts = db.prepare(`SELECT id FROM courts ORDER BY id`).all();
  if (courts.length === 0) return res.status(400).json({ error: 'add a court first' });

  const tx = db.transaction(() => {
    // clear any old queued/live matches
    db.prepare(`DELETE FROM matches WHERE status IN ('queued','live')`).run();
    // set session active
    db.prepare(`UPDATE session SET active = 1, started_at = ?, duration_ms = ? WHERE id = 1`)
      .run(Date.now(), dur);
    // build round-robin
    const pairs = buildRoundRobin(available);
    const ins = db.prepare(
      `INSERT INTO matches (p1, p2, court_id, status, seq) VALUES (?, ?, ?, 'queued', ?)`
    );
    let seq = 0;
    for (const round of pairs) {
      round.sort((a, b) => ratingGap(a, available) - ratingGap(b, available));
      for (let i = 0; i < round.length; i += courts.length) {
        const slot = round.slice(i, i + courts.length);
        slot.forEach(([p1, p2], idx) => {
          ins.run(p1, p2, courts[idx % courts.length].id, ++seq);
        });
      }
    }
  });
  tx();
  emitState();
  res.json({ ok: true });
});

app.post('/api/session/end', auth, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM matches WHERE status IN ('queued','live')`).run();
    db.prepare(`UPDATE session SET active = 0, started_at = NULL, duration_ms = NULL WHERE id = 1`).run();
  });
  tx();
  emitState();
  res.json({ ok: true });
});

/* ---------- match actions ---------- */
app.post('/api/matches/:id/start', auth, (req, res) => {
  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.status !== 'queued') return res.status(400).json({ error: 'not queued' });

  // court must be free
  const courtBusy = db.prepare(
    `SELECT 1 FROM matches WHERE court_id = ? AND status = 'live' LIMIT 1`
  ).get(m.court_id);
  let courtId = m.court_id;
  if (courtBusy) {
    // try any free court
    const free = db.prepare(`
      SELECT id FROM courts
      WHERE id NOT IN (SELECT court_id FROM matches WHERE status = 'live' AND court_id IS NOT NULL)
      LIMIT 1`).get();
    if (!free) return res.status(409).json({ error: 'all courts busy' });
    courtId = free.id;
  }

  // neither player may already be live
  const playing = db.prepare(
    `SELECT 1 FROM matches WHERE status = 'live' AND (p1 IN (?, ?) OR p2 IN (?, ?)) LIMIT 1`
  ).get(m.p1, m.p2, m.p1, m.p2);
  if (playing) return res.status(409).json({ error: 'player already on court' });

  db.prepare(`UPDATE matches SET status='live', started_at=?, court_id=? WHERE id=?`)
    .run(Date.now(), courtId, m.id);
  emitState();
  res.json({ ok: true });
});

app.post('/api/matches/:id/finish', auth, (req, res) => {
  const { s1, s2 } = req.body || {};
  const a = parseInt(s1), b = parseInt(s2);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
    return res.status(400).json({ error: 'invalid scores' });
  }
  if (a === b) return res.status(400).json({ error: 'no ties' });

  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.status !== 'live') return res.status(400).json({ error: 'not live' });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE matches SET status='done', ended_at=?, s1=?, s2=? WHERE id=?`)
      .run(Date.now(), a, b, m.id);
    // rating update (simple Elo-ish)
    const p1 = db.prepare(`SELECT rating FROM players WHERE id = ?`).get(m.p1);
    const p2 = db.prepare(`SELECT rating FROM players WHERE id = ?`).get(m.p2);
    if (p1 && p2) {
      const expected = 1 / (1 + Math.pow(10, (p2.rating - p1.rating)));
      const score = a > b ? 1 : 0;
      const K = 0.2;
      const delta = K * (score - expected);
      const newP1 = clamp(+(p1.rating + delta).toFixed(2), 1, 7);
      const newP2 = clamp(+(p2.rating - delta).toFixed(2), 1, 7);
      db.prepare(`UPDATE players SET rating = ? WHERE id = ?`).run(newP1, m.p1);
      db.prepare(`UPDATE players SET rating = ? WHERE id = ?`).run(newP2, m.p2);
    }
  });
  tx();
  emitState();
  res.json({ ok: true });
});

app.post('/api/matches/:id/skip', auth, (req, res) => {
  const m = db.prepare(`SELECT * FROM matches WHERE id = ?`).get(req.params.id);
  if (!m || m.status !== 'queued') return res.status(400).json({ error: 'not queued' });
  const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM matches`).get().s;
  db.prepare(`UPDATE matches SET seq = ? WHERE id = ?`).run(maxSeq + 1, m.id);
  emitState();
  res.json({ ok: true });
});

app.delete('/api/matches/:id', auth, (req, res) => {
  db.prepare(`DELETE FROM matches WHERE id = ?`).run(req.params.id);
  emitState();
  res.json({ ok: true });
});

/* ---------- scheduler (circle method) ---------- */
function buildRoundRobin(players) {
  const list = players.map(p => ({ id: p.id }));
  if (list.length % 2 === 1) list.push({ id: '__bye__' });
  const n = list.length;
  const rounds = [];
  const rotating = list.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    const a = list[0];
    const b = rotating[0];
    if (a.id !== '__bye__' && b.id !== '__bye__') round.push([a.id, b.id]);
    for (let i = 1; i < n / 2; i++) {
      const x = rotating[i];
      const y = rotating[rotating.length - i];
      if (x.id !== '__bye__' && y.id !== '__bye__') round.push([x.id, y.id]);
    }
    rounds.push(round);
    rotating.unshift(rotating.pop());
  }
  return rounds;
}
function ratingGap([a, b], players) {
  const pa = players.find(p => p.id === a);
  const pb = players.find(p => p.id === b);
  return Math.abs((pa?.rating ?? 0) - (pb?.rating ?? 0));
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n))); }

/* ---------- health + start ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, t: Date.now() }));

app.listen(PORT, () => {
  console.log(`Court T listening on :${PORT}`);
  console.log(`Group code: ${GROUP_CODE === 'squash123' ? 'squash123 (DEFAULT — change via GROUP_CODE env var)' : '*** (env)'}`);
});
