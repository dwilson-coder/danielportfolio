import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const databasePath = resolve(process.env.DATABASE_PATH || 'server/data/portfolio.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })

export const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

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

const videoColumns = new Set(database.prepare('PRAGMA table_info(videos)').all().map((column) => column.name))
if (!videoColumns.has('description')) database.exec("ALTER TABLE videos ADD COLUMN description TEXT NOT NULL DEFAULT ''")
if (!videoColumns.has('is_public')) database.exec('ALTER TABLE videos ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1')

const userColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map((column) => column.name))
if (!userColumns.has('email_otp_hash')) database.exec('ALTER TABLE users ADD COLUMN email_otp_hash TEXT')
if (!userColumns.has('email_otp_expires_at')) database.exec('ALTER TABLE users ADD COLUMN email_otp_expires_at INTEGER')
if (!userColumns.has('email_otp_attempts')) database.exec('ALTER TABLE users ADD COLUMN email_otp_attempts INTEGER NOT NULL DEFAULT 0')
if (!userColumns.has('email_2fa_enabled')) database.exec('ALTER TABLE users ADD COLUMN email_2fa_enabled INTEGER NOT NULL DEFAULT 0')

if (!userColumns.has('role')) database.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
if (!userColumns.has('status')) database.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
if (!userColumns.has('display_name')) database.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
// The original single-owner account becomes the first admin.
database.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')")

database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
database.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(Date.now())