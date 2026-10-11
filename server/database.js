import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createClient } from '@libsql/client'

// Production stores everything in a hosted Turso (libSQL) database so data survives
// Render restarts. Without TURSO_DATABASE_URL, a local SQLite file is used instead.
export const usingRemoteDatabase = Boolean(process.env.TURSO_DATABASE_URL)
const localPath = process.env.DATABASE_PATH || 'server/data/portfolio.sqlite'
export const databasePath = usingRemoteDatabase ? process.env.TURSO_DATABASE_URL : resolve(localPath)

if (!usingRemoteDatabase) mkdirSync(dirname(resolve(localPath)), { recursive: true })

const client = createClient(usingRemoteDatabase
  ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: `file:${localPath.replace(/\\/g, '/')}` })

function plainRow(result, row) {
  const object = {}
  result.columns.forEach((column, index) => { object[column] = row[index] })
  return object
}

const statement = (sql, args) => ({ sql, args: args.map((value) => (value === undefined ? null : value)) })

export const db = {
  async get(sql, ...args) {
    const result = await client.execute(statement(sql, args))
    return result.rows[0] ? plainRow(result, result.rows[0]) : undefined
  },
  async all(sql, ...args) {
    const result = await client.execute(statement(sql, args))
    return result.rows.map((row) => plainRow(result, row))
  },
  async run(sql, ...args) {
    const result = await client.execute(statement(sql, args))
    return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid) }
  },
  // Runs several statements atomically. Each entry is [sql, ...args].
  async batch(entries) {
    const results = await client.batch(entries.map(([sql, ...args]) => statement(sql, args)), 'write')
    return results.map((result) => ({ changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid) }))
  },
  async exec(sql) {
    await client.executeMultiple(sql)
  },
}

if (!usingRemoteDatabase) await db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')

await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    pending_totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    email_2fa_enabled INTEGER NOT NULL DEFAULT 0,
    email_otp_hash TEXT,
    email_otp_expires_at INTEGER,
    email_otp_attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('setup_required', 'two_factor_pending', 'authenticated')),
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    video_path TEXT NOT NULL,
    thumbnail_path TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS creator_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Pittsburgh, PA',
    bio TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    image_path TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS account_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS account_requests_one_pending ON account_requests(email) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS videos_owner ON videos(user_id, created_at DESC);
`)

async function columnsOf(table) {
  return new Set((await db.all(`PRAGMA table_info(${table})`)).map((column) => column.name))
}

async function addMissingColumns(table, definitions) {
  const existing = await columnsOf(table)
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

await addMissingColumns('videos', {
  description: "TEXT NOT NULL DEFAULT ''",
  is_public: 'INTEGER NOT NULL DEFAULT 1',
  // 'file' = stored on this server's disk, 'cloudinary' = Cloudinary upload, 'youtube' = linked YouTube video.
  source: "TEXT NOT NULL DEFAULT 'file'",
  video_url: 'TEXT',
  thumbnail_url: 'TEXT',
  youtube_id: 'TEXT',
  cloudinary_video_id: 'TEXT',
  cloudinary_thumbnail_id: 'TEXT',
})

await addMissingColumns('users', {
  email_otp_hash: 'TEXT',
  email_otp_expires_at: 'INTEGER',
  email_otp_attempts: 'INTEGER NOT NULL DEFAULT 0',
  email_2fa_enabled: 'INTEGER NOT NULL DEFAULT 0',
  role: "TEXT NOT NULL DEFAULT 'user'",
  status: "TEXT NOT NULL DEFAULT 'active'",
  display_name: "TEXT NOT NULL DEFAULT ''",
})

await addMissingColumns('creator_profiles', {
  image_url: 'TEXT',
  image_public_id: 'TEXT',
})

// The original single-owner account becomes the first admin.
await db.run("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')")

await db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now())
await db.run('DELETE FROM password_reset_tokens WHERE expires_at <= ?', Date.now())

// Deletes a user and everything that belongs to them. Done explicitly because a hosted
// database connection may not enforce ON DELETE CASCADE.
export async function deleteUserCascade(userId) {
  await db.batch([
    ['DELETE FROM sessions WHERE user_id = ?', userId],
    ['DELETE FROM password_reset_tokens WHERE user_id = ?', userId],
    ['DELETE FROM videos WHERE user_id = ?', userId],
    ['DELETE FROM creator_profiles WHERE user_id = ?', userId],
    ['UPDATE account_requests SET reviewed_by = NULL WHERE reviewed_by = ?', userId],
    ['DELETE FROM users WHERE id = ?', userId],
  ])
}
