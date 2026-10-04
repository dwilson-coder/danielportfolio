import { randomBytes } from 'node:crypto'
import express from 'express'
import { database } from './database.js'
import { hashPassword, hashToken, verifyPassword } from './security.js'

const roles = ['user', 'admin']
const userStatuses = ['active', 'disabled']
const requestStatuses = ['pending', 'approved', 'rejected']
const passwordResetLifetime = 60 * 60 * 1000

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const normalizeEmail = (value) => text(value).toLowerCase()
const validPassword = (value) => typeof value === 'string' && value.length >= 12 && value.length <= 256
const passwordError = 'Password must be between 12 and 256 characters.'

function parseId(value) {
  return /^\d{1,12}$/.test(value) ? Number(value) : null
}

function parsePaging(query) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), 100)
  const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0)
  return { limit, offset }
}

function userPayload(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    twoFactorEnabled: user.email_2fa_enabled === 1,
    createdAt: user.created_at,
  }
}

function requestPayload(request) {
  return {
    id: request.id,
    email: request.email,
    displayName: request.display_name,
    message: request.message,
    status: request.status,
    reviewNote: request.review_note,
    reviewedBy: request.reviewed_by,
    reviewedAt: request.reviewed_at,
    createdAt: request.created_at,
  }
}

function activeAdminCount() {
  return database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count
}

function revokeSessions(userId) {
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

function isUniqueViolation(error) {
  return typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed')
}

export function createAccountsRouter({
  loadSession, requireCsrf, requireTwoFactor, passwordRateLimit,
  mailTransport, isValidEmail, clearSessionCookie,
}) {
  const router = express.Router()
  router.use((req, res, next) => {
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') req.body = {}
    next()
  })

  const requireAdmin = (req, res, next) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' })
    next()
  }
  const authed = [loadSession, requireTwoFactor]
  const authedWrite = [loadSession, requireCsrf, requireTwoFactor]
  const adminRead = [...authed, requireAdmin]
  const adminWrite = [...authedWrite, requireAdmin]

  async function sendResetEmail(email, token) {
    const body = `Use this token to reset your Frame by Frame password: ${token}\nIt expires in 60 minutes. If you did not request it, ignore this email.`
    if (mailTransport) {
      await mailTransport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'Reset your Frame by Frame password',
        text: body,
      })
    } else if (process.env.NODE_ENV !== 'production') {
      console.log(`[dev] Password reset token for ${email}: ${token}`)
    }
  }

  // ---- Public: sign-up requests and password reset ----

  router.post('/accounts/signup', passwordRateLimit, async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const displayName = text(req.body.displayName)
    const message = text(req.body.message)
    if (!isValidEmail(email) || !validPassword(req.body.password) || displayName.length > 80 || message.length > 500) {
      return res.status(400).json({ error: `Enter a valid email, a display name up to 80 characters, a message up to 500 characters. ${passwordError}` })
    }
    const credentials = await hashPassword(req.body.password)
    const taken = database.prepare('SELECT 1 FROM users WHERE email = ?').get(email)
    if (!taken) {
      try {
        database.prepare('INSERT INTO account_requests (email, display_name, message, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)')
          .run(email, displayName, message, credentials.salt, credentials.hash)
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    // Identical response whether or not the email is known, to prevent account enumeration.
    return res.status(202).json({ message: 'Your account request was received. An administrator will review it.' })
  })

  router.post('/auth/password-reset/request', passwordRateLimit, async (req, res) => {
    const email = normalizeEmail(req.body.email)
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    const user = database.prepare("SELECT id, email FROM users WHERE email = ? AND status = 'active'").get(email)
    if (user) {
      const token = randomBytes(32).toString('base64url')
      database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id)
      database.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), user.id, Date.now() + passwordResetLifetime)
      try {
        await sendResetEmail(user.email, token)
      } catch (error) {
        console.error('Unable to send password reset email:', error.message)
      }
    }
    return res.status(202).json({ message: 'If that account exists, a password reset email has been sent.' })
  })

  router.post('/auth/password-reset/confirm', passwordRateLimit, async (req, res) => {
    const token = text(req.body.token)
    if (!token || token.length > 128 || !validPassword(req.body.password)) {
      return res.status(400).json({ error: `A reset token is required. ${passwordError}` })
    }
    const record = database.prepare('SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?').get(hashToken(token))
    if (!record || record.expires_at <= Date.now()) {
      return res.status(400).json({ error: 'That reset token is invalid or has expired.' })
    }
    const credentials = await hashPassword(req.body.password)
    database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(credentials.salt, credentials.hash, record.user_id)
    database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(record.user_id)
    revokeSessions(record.user_id)
    return res.json({ message: 'Your password has been reset. Sign in with the new password.' })
  })

  // ---- Signed-in user: own account ----

  router.get('/account', ...authed, (req, res) => {
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id)
    return res.json(userPayload(user))
  })

  router.patch('/account', ...authedWrite, async (req, res) => {
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id)
    const next = { email: user.email, display_name: user.display_name }
    if (req.body.displayName !== undefined) {
      next.display_name = text(req.body.displayName)
      if (next.display_name.length > 80) return res.status(400).json({ error: 'Display name must be 80 characters or fewer.' })
    }
    if (req.body.email !== undefined) {
      next.email = normalizeEmail(req.body.email)
      if (!isValidEmail(next.email)) return res.status(400).json({ error: 'Enter a valid email address.' })
      if (next.email !== user.email.toLowerCase()) {
        if (typeof req.body.currentPassword !== 'string' || !(await verifyPassword(req.body.currentPassword, user.password_salt, user.password_hash))) {
          return res.status(403).json({ error: 'Current password is required to change your email.' })
        }
      }
    }
    try {
      database.prepare('UPDATE users SET email = ?, display_name = ? WHERE id = ?').run(next.email, next.display_name, user.id)
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'That email is already in use.' })
      throw error
    }
    return res.json(userPayload(database.prepare('SELECT * FROM users WHERE id = ?').get(user.id)))
  })

  router.post('/account/password', ...authedWrite, async (req, res) => {
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id)
    if (typeof req.body.currentPassword !== 'string' || !(await verifyPassword(req.body.currentPassword, user.password_salt, user.password_hash))) {
      return res.status(403).json({ error: 'Current password is incorrect.' })
    }
    if (!validPassword(req.body.newPassword)) return res.status(400).json({ error: passwordError })
    const credentials = await hashPassword(req.body.newPassword)
    database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(credentials.salt, credentials.hash, user.id)
    revokeSessions(user.id)
    clearSessionCookie(res)
    return res.json({ message: 'Password updated. Sign in again with the new password.' })
  })

  router.delete('/account', ...authedWrite, async (req, res) => {
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id)
    if (typeof req.body.currentPassword !== 'string' || !(await verifyPassword(req.body.currentPassword, user.password_salt, user.password_hash))) {
      return res.status(403).json({ error: 'Current password is incorrect.' })
    }
    if (user.role === 'admin' && activeAdminCount() <= 1) {
      return res.status(409).json({ error: 'The last active administrator cannot be deleted.' })
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    clearSessionCookie(res)
    return res.status(204).end()
  })

  // ---- Admin: users ----

  router.get('/admin/users', ...adminRead, (req, res) => {
    const { limit, offset } = parsePaging(req.query)
    const where = []
    const params = []
    if (req.query.status !== undefined) {
      if (!userStatuses.includes(req.query.status)) return res.status(400).json({ error: `status must be one of: ${userStatuses.join(', ')}.` })
      where.push('status = ?')
      params.push(req.query.status)
    }
    if (req.query.role !== undefined) {
      if (!roles.includes(req.query.role)) return res.status(400).json({ error: `role must be one of: ${roles.join(', ')}.` })
      where.push('role = ?')
      params.push(req.query.role)
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      where.push("(email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')")
      const pattern = `%${req.query.q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`
      params.push(pattern, pattern)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = database.prepare(`SELECT COUNT(*) AS count FROM users ${clause}`).get(...params).count
    const items = database.prepare(`SELECT * FROM users ${clause} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limit, offset)
    return res.json({ items: items.map(userPayload), total, limit, offset })
  })

  router.post('/admin/users', ...adminWrite, async (req, res) => {
    const email = normalizeEmail(req.body.email)
    const displayName = text(req.body.displayName)
    const role = req.body.role ?? 'user'
    const status = req.body.status ?? 'active'
    if (!isValidEmail(email) || !validPassword(req.body.password) || displayName.length > 80 || !roles.includes(role) || !userStatuses.includes(status)) {
      return res.status(400).json({ error: `Provide a valid email, a display name up to 80 characters, role (${roles.join('/')}), and status (${userStatuses.join('/')}). ${passwordError}` })
    }
    const credentials = await hashPassword(req.body.password)
    try {
      const result = database.prepare('INSERT INTO users (email, password_salt, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(email, credentials.salt, credentials.hash, displayName, role, status)
      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid))
      return res.status(201).set('Location', `/api/admin/users/${user.id}`).json(userPayload(user))
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'A user with that email already exists.' })
      throw error
    }
  })

  router.get('/admin/users/:id', ...adminRead, (req, res) => {
    const id = parseId(req.params.id)
    const user = id && database.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    return res.json(userPayload(user))
  })

  router.patch('/admin/users/:id', ...adminWrite, async (req, res) => {
    const id = parseId(req.params.id)
    const user = id && database.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'User not found.' })

    const next = { email: user.email, display_name: user.display_name, role: user.role, status: user.status }
    if (req.body.email !== undefined) {
      next.email = normalizeEmail(req.body.email)
      if (!isValidEmail(next.email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    }
    if (req.body.displayName !== undefined) {
      next.display_name = text(req.body.displayName)
      if (next.display_name.length > 80) return res.status(400).json({ error: 'Display name must be 80 characters or fewer.' })
    }
    if (req.body.role !== undefined) {
      if (!roles.includes(req.body.role)) return res.status(400).json({ error: `role must be one of: ${roles.join(', ')}.` })
      next.role = req.body.role
    }
    if (req.body.status !== undefined) {
      if (!userStatuses.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${userStatuses.join(', ')}.` })
      next.status = req.body.status
    }
    if (req.body.password !== undefined && !validPassword(req.body.password)) return res.status(400).json({ error: passwordError })

    const losesAdmin = user.role === 'admin' && user.status === 'active' && (next.role !== 'admin' || next.status !== 'active')
    if (losesAdmin && activeAdminCount() <= 1) {
      return res.status(409).json({ error: 'The last active administrator cannot be demoted or disabled.' })
    }

    try {
      database.prepare('UPDATE users SET email = ?, display_name = ?, role = ?, status = ? WHERE id = ?')
        .run(next.email, next.display_name, next.role, next.status, id)
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'A user with that email already exists.' })
      throw error
    }
    if (req.body.password !== undefined) {
      const credentials = await hashPassword(req.body.password)
      database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(credentials.salt, credentials.hash, id)
    }
    if (req.body.password !== undefined || next.status === 'disabled' || next.role !== user.role) revokeSessions(id)
    return res.json(userPayload(database.prepare('SELECT * FROM users WHERE id = ?').get(id)))
  })

  router.delete('/admin/users/:id', ...adminWrite, (req, res) => {
    const id = parseId(req.params.id)
    const user = id && database.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    if (user.id === req.session.user_id) return res.status(409).json({ error: 'Use DELETE /api/account to delete your own account.' })
    if (user.role === 'admin' && user.status === 'active' && activeAdminCount() <= 1) {
      return res.status(409).json({ error: 'The last active administrator cannot be deleted.' })
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(id)
    return res.status(204).end()
  })

  // ---- Admin: account requests ----

  router.get('/admin/account-requests', ...adminRead, (req, res) => {
    const { limit, offset } = parsePaging(req.query)
    const params = []
    let clause = ''
    if (req.query.status !== undefined) {
      if (!requestStatuses.includes(req.query.status)) return res.status(400).json({ error: `status must be one of: ${requestStatuses.join(', ')}.` })
      clause = 'WHERE status = ?'
      params.push(req.query.status)
    }
    const total = database.prepare(`SELECT COUNT(*) AS count FROM account_requests ${clause}`).get(...params).count
    const items = database.prepare(`SELECT * FROM account_requests ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
    return res.json({ items: items.map(requestPayload), total, limit, offset })
  })

  router.get('/admin/account-requests/:id', ...adminRead, (req, res) => {
    const id = parseId(req.params.id)
    const request = id && database.prepare('SELECT * FROM account_requests WHERE id = ?').get(id)
    if (!request) return res.status(404).json({ error: 'Account request not found.' })
    return res.json(requestPayload(request))
  })

  router.post('/admin/account-requests/:id/approve', ...adminWrite, (req, res) => {
    const id = parseId(req.params.id)
    const request = id && database.prepare('SELECT * FROM account_requests WHERE id = ?').get(id)
    if (!request) return res.status(404).json({ error: 'Account request not found.' })
    if (request.status !== 'pending') return res.status(409).json({ error: `This request was already ${request.status}.` })
    const role = req.body.role ?? 'user'
    if (!roles.includes(role)) return res.status(400).json({ error: `role must be one of: ${roles.join(', ')}.` })
    const note = text(req.body.note)
    if (note.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer.' })

    database.exec('BEGIN')
    try {
      const result = database.prepare('INSERT INTO users (email, password_salt, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
        .run(request.email, request.password_salt, request.password_hash, request.display_name, role)
      database.prepare("UPDATE account_requests SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(note, req.session.user_id, id)
      database.exec('COMMIT')
      const user = database.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid))
      return res.json({ request: requestPayload(database.prepare('SELECT * FROM account_requests WHERE id = ?').get(id)), user: userPayload(user) })
    } catch (error) {
      database.exec('ROLLBACK')
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'A user with that email already exists.' })
      throw error
    }
  })

  router.post('/admin/account-requests/:id/reject', ...adminWrite, (req, res) => {
    const id = parseId(req.params.id)
    const request = id && database.prepare('SELECT * FROM account_requests WHERE id = ?').get(id)
    if (!request) return res.status(404).json({ error: 'Account request not found.' })
    if (request.status !== 'pending') return res.status(409).json({ error: `This request was already ${request.status}.` })
    const note = text(req.body.note)
    if (note.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer.' })
    database.prepare("UPDATE account_requests SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(note, req.session.user_id, id)
    return res.json(requestPayload(database.prepare('SELECT * FROM account_requests WHERE id = ?').get(id)))
  })

  router.delete('/admin/account-requests/:id', ...adminWrite, (req, res) => {
    const id = parseId(req.params.id)
    const request = id && database.prepare('SELECT id FROM account_requests WHERE id = ?').get(id)
    if (!request) return res.status(404).json({ error: 'Account request not found.' })
    database.prepare('DELETE FROM account_requests WHERE id = ?').run(id)
    return res.status(204).end()
  })

  return router
}
