import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { fileTypeFromFile } from 'file-type'
import helmet from 'helmet'
import multer from 'multer'
import nodemailer from 'nodemailer'
import { createAccountsRouter } from './accounts.js'
import { database } from './database.js'
import { constantTimeMatch, createEmailOtp, hashPassword, hashToken, verifyEmailOtp, verifyPassword } from './security.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uploadRoot = resolve(process.env.UPLOAD_DIR || join(projectRoot, 'server/uploads'))
const tempDirectory = join(uploadRoot, 'tmp')
const videoDirectory = join(uploadRoot, 'videos')
const thumbnailDirectory = join(uploadRoot, 'thumbnails')
const profileImageDirectory = join(uploadRoot, 'profiles')
const distDirectory = join(projectRoot, 'dist')
const sessionCookie = 'frame_session'
const sessionLifetime = 7 * 24 * 60 * 60 * 1000
const emailOtpLifetime = 10 * 60 * 1000
const emailOtpMaxAttempts = 5
const acceptedVideoExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const acceptedVideoMimes = new Set(['video/mp4', 'application/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm'])
const acceptedThumbnailMimes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const acceptedProfileMimes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const defaultCreatorName = process.env.VITE_CREATOR_NAME || 'Daniel Wilson'

for (const directory of [tempDirectory, videoDirectory, thumbnailDirectory, profileImageDirectory]) {
  mkdirSync(directory, { recursive: true })
}
rmSync(tempDirectory, { recursive: true, force: true })
mkdirSync(tempDirectory, { recursive: true })

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === '1')
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://images.unsplash.com'],
      mediaSrc: ["'self'", 'https://media.w3.org', 'https://interactive-examples.mdn.mozilla.net'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    },
  },
}))
app.use(express.json({ limit: '32kb' }))
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// Relaxed outside production so Postman collection runs don't trip the limiters.
const rateLimitScale = process.env.NODE_ENV === 'production' ? 1 : 25
const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12 * rateLimitScale, standardHeaders: 'draft-8', legacyHeaders: false })
const passwordRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6 * rateLimitScale, standardHeaders: 'draft-8', legacyHeaders: false })
const uploadRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
const mailTransport = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_SECURE !== 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  })
  : null

function maskEmail(email) {
  const [localPart, domain] = email.split('@')
  return `${localPart.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(localPart.length - 1, 6)))}@${domain}`
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '(***) ***-****'
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '***-****'
  return `(***) ***-${digits.slice(-4)}`
}

function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetime / 1000)}${secure}`)
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`)
}

function loadSession(req, res, next) {
  const token = readCookie(req, sessionCookie)
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  const session = database.prepare(`
    SELECT sessions.token_hash, sessions.csrf_token, sessions.user_id, sessions.state, sessions.expires_at,
      users.email, users.email_2fa_enabled, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'
  `).get(hashToken(token), Date.now())
  if (!session) {
    clearSessionCookie(res)
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' })
  }
  req.session = session
  next()
}

function requireCsrf(req, res, next) {
  if (!constantTimeMatch(req.get('X-CSRF-Token'), req.session.csrf_token)) {
    return res.status(403).json({ error: 'Your session token is invalid. Refresh and try again.' })
  }
  next()
}

function requireTwoFactor(req, res, next) {
  if (req.session.state !== 'authenticated') {
    return res.status(403).json({ error: 'Complete two-factor authentication before continuing.' })
  }
  next()
}

function issueSession(req, res, userId, state) {
  const previousToken = readCookie(req, sessionCookie)
  if (previousToken) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(previousToken))
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  database.prepare('INSERT INTO sessions (token_hash, csrf_token, user_id, state, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), csrfToken, userId, state, Date.now() + sessionLifetime)
  setSessionCookie(res, token)
  return csrfToken
}

function sessionPayload(session) {
  return {
    state: session.state,
    email: session.email,
    csrfToken: session.csrf_token,
    twoFactorEnabled: session.email_2fa_enabled === 1,
    role: session.role,
  }
}

function profileForUser(userId) {
  const profile = database.prepare('SELECT * FROM creator_profiles WHERE user_id = ?').get(userId)
  let tags = []
  try { tags = JSON.parse(profile?.tags_json || '[]') } catch { tags = [] }
  return {
    displayName: profile?.display_name || defaultCreatorName,
    location: profile?.location || process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA',
    bio: profile?.bio || process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.',
    tags: profile ? (Array.isArray(tags) ? tags : []) : ['Filmmaking', 'Motion design', 'Editing'],
    imageUrl: profile?.image_path ? `/api/public/profile/image?v=${encodeURIComponent(profile.updated_at)}` : '/ninja.svg',
    updatedAt: profile?.updated_at || null,
  }
}

function publicProfileOwner() {
  return database.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function passwordMatches(user, password) {
  if (!user) {
    await hashPassword(password)
    return false
  }
  return verifyPassword(password, user.password_salt, user.password_hash)
}

const upload = multer({
  storage: multer.diskStorage({
    destination: tempDirectory,
    filename: (req, file, callback) => {
      const filename = randomUUID()
      req.uploadTempPaths ??= []
      req.uploadTempPaths.push(join(tempDirectory, filename))
      callback(null, filename)
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 2, fields: 4, parts: 6 },
  fileFilter: (req, file, callback) => {
    if (file.fieldname === 'video' && acceptedVideoExtensions.has(extname(file.originalname).toLowerCase()) && acceptedVideoMimes.has(file.mimetype)) {
      return callback(null, true)
    }
    if (file.fieldname === 'thumbnail' && acceptedThumbnailMimes.has(file.mimetype)) return callback(null, true)
    callback(new Error('Choose an MP4, M4V, MOV, or WebM video and a generated image thumbnail.'))
  },
}).fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])

const profileImageUpload = multer({
  storage: multer.diskStorage({
    destination: tempDirectory,
    filename: (req, file, callback) => {
      const filename = randomUUID()
      req.uploadTempPaths ??= []
      req.uploadTempPaths.push(join(tempDirectory, filename))
      callback(null, filename)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => acceptedProfileMimes.has(file.mimetype)
    ? callback(null, true)
    : callback(new Error('Choose a JPEG, PNG, or WebP profile image.')),
}).single('image')

const router = express.Router()

router.get('/health', (req, res) => res.json({ status: 'ok' }))

router.get('/auth/session', loadSession, (req, res) => res.json(sessionPayload(req.session)))

router.post('/auth/forgot-password', passwordRateLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const recoveryCode = typeof req.body.recoveryCode === 'string' ? req.body.recoveryCode : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  if (!isValidEmail(email) || password.length < 12 || password.length > 256) {
    return res.status(400).json({ error: 'Enter a valid email and a password between 12 and 256 characters.' })
  }
  if (!process.env.PORTAL_RECOVERY_CODE || !constantTimeMatch(recoveryCode, process.env.PORTAL_RECOVERY_CODE)) {
    return res.status(403).json({ error: 'Recovery code is invalid.' })
  }
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (user) {
    const credentials = await hashPassword(password)
    database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(credentials.salt, credentials.hash, user.id)
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
  }
  return res.json({ message: 'If that account exists, its password has been reset. Sign in and complete two-factor verification.' })
})

router.get('/public/profile', (req, res) => {
  const owner = publicProfileOwner()
  return res.json(owner ? profileForUser(owner.id) : {
    displayName: defaultCreatorName,
    location: process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA',
    bio: process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.',
    tags: ['Filmmaking', 'Motion design', 'Editing'],
    imageUrl: '/ninja.svg',
  })
})

router.get('/public/profile/image', (req, res) => {
  const owner = publicProfileOwner()
  const profile = owner && database.prepare('SELECT image_path FROM creator_profiles WHERE user_id = ?').get(owner.id)
  if (!profile?.image_path) return res.status(404).end()
  res.type(extname(profile.image_path))
  res.setHeader('Cache-Control', 'public, max-age=300')
  return createReadStream(profile.image_path).pipe(res)
})

router.get('/profile', loadSession, requireTwoFactor, (req, res) => res.json(profileForUser(req.session.user_id)))

router.put('/profile', loadSession, requireCsrf, requireTwoFactor, (req, res) => {
  const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : ''
  const location = typeof req.body.location === 'string' ? req.body.location.trim() : ''
  const bio = typeof req.body.bio === 'string' ? req.body.bio.trim() : ''
  const tags = Array.isArray(req.body.tags) ? req.body.tags : null
  if (!displayName || displayName.length > 80 || !location || location.length > 100 || bio.length > 600) {
    return res.status(400).json({ error: 'Name (1–80), location (1–100), and bio (up to 600 characters) are required.' })
  }
  if (!tags || tags.length > 8 || tags.some((tag) => typeof tag !== 'string' || tag.trim().length < 1 || tag.trim().length > 24)) {
    return res.status(400).json({ error: 'Add up to 8 tags, each between 1 and 24 characters.' })
  }
  database.prepare(`
    INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      location = excluded.location,
      bio = excluded.bio,
      tags_json = excluded.tags_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(req.session.user_id, displayName, location, bio, JSON.stringify(tags.map((tag) => tag.trim())))
  return res.json(profileForUser(req.session.user_id))
})

router.put('/profile/image', loadSession, requireCsrf, requireTwoFactor, (req, res, next) => {
  profileImageUpload(req, res, (error) => error ? next(error) : next())
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a profile image first.' })
  if (req.file.size > 5 * 1024 * 1024) {
    rmSync(req.file.path, { force: true })
    return res.status(413).json({ error: 'Profile images must be 5 MB or smaller.' })
  }
  const imageType = await fileTypeFromFile(req.file.path)
  if (!imageType || !acceptedProfileMimes.has(imageType.mime)) {
    rmSync(req.file.path, { force: true })
    return res.status(415).json({ error: 'Choose a JPEG, PNG, or WebP profile image.' })
  }
  const current = database.prepare('SELECT image_path FROM creator_profiles WHERE user_id = ?').get(req.session.user_id)
  const imagePath = join(profileImageDirectory, `${randomUUID()}.${imageType.ext}`)
  renameSync(req.file.path, imagePath)
  database.prepare(`
    INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json, image_path)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, updated_at = CURRENT_TIMESTAMP
  `).run(req.session.user_id, defaultCreatorName, process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', '', '[]', imagePath)
  if (current?.image_path) rmSync(current.image_path, { force: true })
  return res.json(profileForUser(req.session.user_id))
})

function streamVideoRange(req, res, video) {
  res.type(video.mime_type)
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(video.original_name)}"`)
  const size = statSync(video.video_path).size
  res.setHeader('Accept-Ranges', 'bytes')
  const requestedRange = req.get('Range')
  if (!requestedRange) {
    res.setHeader('Content-Length', size)
    return createReadStream(video.video_path).pipe(res)
  }
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(requestedRange)
  const start = rangeMatch ? Number(rangeMatch[1] || 0) : size
  const end = rangeMatch && rangeMatch[2] ? Math.min(Number(rangeMatch[2]), size - 1) : size - 1
  if (!rangeMatch || start >= size || start > end) {
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }
  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.setHeader('Content-Length', end - start + 1)
  return createReadStream(video.video_path, { start, end }).pipe(res)
}

function publicVideoPayload(video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    originalName: video.original_name,
    mimeType: video.mime_type,
    durationSeconds: video.duration_seconds,
    uploadedAt: video.created_at,
    uploadedBy: profileForUser(video.user_id).displayName,
    videoUrl: `/api/portfolio-videos/${video.id}/file`,
    thumbnailUrl: `/api/portfolio-videos/${video.id}/thumbnail`,
  }
}

router.get('/portfolio-videos', (req, res) => {
  const owner = publicProfileOwner()
  if (!owner) return res.json({ videos: [] })
  const videos = database.prepare('SELECT * FROM videos WHERE user_id = ? AND is_public = 1 ORDER BY created_at DESC').all(owner.id)
  return res.json({ videos: videos.map(publicVideoPayload) })
})

router.get('/portfolio-videos/:id', (req, res) => {
  const video = database.prepare('SELECT * FROM videos WHERE id = ? AND is_public = 1').get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  return res.json({ video: publicVideoPayload(video) })
})

router.get('/portfolio-videos/:id/file', (req, res) => {
  const video = database.prepare('SELECT * FROM videos WHERE id = ? AND is_public = 1').get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  return streamVideoRange(req, res, video)
})

router.get('/portfolio-videos/:id/thumbnail', (req, res) => {
  const video = database.prepare('SELECT thumbnail_path FROM videos WHERE id = ? AND is_public = 1').get(req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  res.type('image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  return createReadStream(video.thumbnail_path).pipe(res)
})

router.post('/videos/recovery-code', passwordRateLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const recoveryCode = typeof req.body.recoveryCode === 'string' ? req.body.recoveryCode : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  if (!isValidEmail(email) || password.length < 12 || password.length > 256) {
    return res.status(400).json({ error: 'Enter a valid email and a password between 12 and 256 characters.' })
  }
  if (!process.env.PORTAL_RECOVERY_CODE || !constantTimeMatch(recoveryCode, process.env.PORTAL_RECOVERY_CODE)) {
    return res.status(403).json({ error: 'Recovery code is invalid.' })
  }
  const user = database.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (user) {
    const credentials = await hashPassword(password)
    database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(credentials.salt, credentials.hash, user.id)
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
  }
  return res.json({ message: 'If that account exists, its password has been reset. Sign in and complete two-factor verification.' })
})

router.post('/auth/login', passwordRateLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  if (!isValidEmail(email) || password.length > 256 || !(await passwordMatches(database.prepare('SELECT * FROM users WHERE email = ?').get(email), password))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const user = database.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (user.status !== 'active') return res.status(401).json({ error: 'Email or password is incorrect.' })
  const state = 'authenticated'
  const csrfToken = issueSession(req, res, user.id, state)
  return res.json({ state, email, csrfToken, twoFactorEnabled: user.email_2fa_enabled === 1, role: user.role })
})

router.post('/auth/email-code/send', authRateLimit, loadSession, requireCsrf, async (req, res) => {
  if (!['setup_required', 'two_factor_pending'].includes(req.session.state)) {
    return res.status(409).json({ error: 'This session is not waiting for email verification.' })
  }
  const recipient = process.env.TWO_FACTOR_EMAIL
  if (!isValidEmail(recipient)) return res.status(503).json({ error: 'Email two-factor delivery is not configured.' })
  const devConsoleDelivery = !mailTransport && process.env.NODE_ENV !== 'production'
  if (!mailTransport && !devConsoleDelivery) return res.status(503).json({ error: 'Email delivery is unavailable. Configure the SMTP settings and try again.' })

  const { code, hash } = createEmailOtp(req.session.user_id)
  database.prepare('UPDATE users SET email_otp_hash = ?, email_otp_expires_at = ?, email_otp_attempts = 0 WHERE id = ?')
    .run(hash, Date.now() + emailOtpLifetime, req.session.user_id)
  if (devConsoleDelivery) {
    console.log(`[dev] Email 2FA code for ${req.session.email}: ${code}`)
    res.setHeader('X-Dev-OTP', code)
    return res.json({ message: 'SMTP is not configured; the verification code was printed to the API server console (development only).' })
  }
  try {
    await mailTransport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipient,
      subject: 'Your Frame by Frame sign-in code',
      text: `Your Frame by Frame verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
    })
  } catch (error) {
    database.prepare('UPDATE users SET email_otp_hash = NULL, email_otp_expires_at = NULL WHERE id = ?').run(req.session.user_id)
    console.error('Unable to send sign-in code:', error.message)
    return res.status(503).json({ error: 'The verification email could not be sent. Check the SMTP settings and try again.' })
  }
  return res.json({ message: `A verification code was sent to ${maskEmail(recipient)}.` })
})

router.post('/auth/email-code/verify', authRateLimit, loadSession, requireCsrf, (req, res) => {
  if (!['setup_required', 'two_factor_pending'].includes(req.session.state)) {
    return res.status(409).json({ error: 'This session is not waiting for email verification.' })
  }
  const user = database.prepare('SELECT email_otp_hash, email_otp_expires_at, email_otp_attempts FROM users WHERE id = ?')
    .get(req.session.user_id)
  if (!user.email_otp_hash || !user.email_otp_expires_at || user.email_otp_expires_at <= Date.now()) {
    return res.status(401).json({ error: 'That verification code expired. Send a new code.' })
  }
  if (user.email_otp_attempts >= emailOtpMaxAttempts) {
    database.prepare('UPDATE users SET email_otp_hash = NULL, email_otp_expires_at = NULL WHERE id = ?').run(req.session.user_id)
    return res.status(429).json({ error: 'Too many code attempts. Send a new verification code.' })
  }
  if (!verifyEmailOtp(req.session.user_id, req.body.code, user.email_otp_hash)) {
    database.prepare('UPDATE users SET email_otp_attempts = email_otp_attempts + 1 WHERE id = ?').run(req.session.user_id)
    return res.status(401).json({ error: 'That verification code is incorrect.' })
  }
  database.prepare('UPDATE users SET email_2fa_enabled = 1, email_otp_hash = NULL, email_otp_expires_at = NULL, email_otp_attempts = 0 WHERE id = ?')
    .run(req.session.user_id)
  database.prepare("UPDATE sessions SET state = 'authenticated' WHERE token_hash = ?").run(req.session.token_hash)
  return res.json({ state: 'authenticated', email: req.session.email, csrfToken: req.session.csrf_token, twoFactorEnabled: true, role: req.session.role })
})

router.post('/auth/logout', loadSession, requireCsrf, (req, res) => {
  database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.session.token_hash)
  clearSessionCookie(res)
  return res.status(204).end()
})

router.get('/videos', loadSession, requireTwoFactor, (req, res) => {
  const videos = database.prepare(`
    SELECT id, title, description, original_name, mime_type, duration_seconds, size_bytes, created_at
    FROM videos WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.session.user_id).map((video) => ({
    ...video,
    videoUrl: `/api/videos/${video.id}/file`,
    thumbnailUrl: `/api/videos/${video.id}/thumbnail`,
  }))
  return res.json({ videos })
})

router.get('/videos/thumbnails', loadSession, requireTwoFactor, (req, res) => {
  const thumbnails = database.prepare('SELECT id, title, created_at FROM videos WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.session.user_id)
    .map((video) => ({ ...video, thumbnailUrl: `/api/videos/${video.id}/thumbnail` }))
  return res.json({ thumbnails })
})

router.get('/videos/export', loadSession, requireTwoFactor, (req, res) => {
  const videos = database.prepare(`
    SELECT id, title, description, original_name, mime_type, duration_seconds, size_bytes, created_at
    FROM videos WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.session.user_id).map((video) => ({
    ...video,
    fileUrl: `/api/videos/${video.id}/file`,
    thumbnailUrl: `/api/videos/${video.id}/thumbnail`,
  }))
  res.setHeader('Content-Disposition', 'attachment; filename="video-details.json"')
  return res.json({ exportedAt: new Date().toISOString(), count: videos.length, videos })
})

router.get('/videos/:id/file', loadSession, requireTwoFactor, (req, res) => {
  const video = database.prepare('SELECT video_path, mime_type, original_name FROM videos WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.user_id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  res.type(video.mime_type)
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(video.original_name)}"`)
  const size = statSync(video.video_path).size
  res.setHeader('Accept-Ranges', 'bytes')
  const requestedRange = req.get('Range')
  if (!requestedRange) {
    res.setHeader('Content-Length', size)
    return createReadStream(video.video_path).pipe(res)
  }

  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(requestedRange)
  const start = rangeMatch ? Number(rangeMatch[1] || 0) : size
  const end = rangeMatch && rangeMatch[2] ? Math.min(Number(rangeMatch[2]), size - 1) : size - 1
  if (!rangeMatch || start >= size || start > end) {
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }

  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.setHeader('Content-Length', end - start + 1)
  return createReadStream(video.video_path, { start, end }).pipe(res)
})

router.get('/videos/:id/thumbnail', loadSession, requireTwoFactor, (req, res) => {
  const video = database.prepare('SELECT thumbnail_path FROM videos WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.session.user_id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  res.type('image/jpeg')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  return createReadStream(video.thumbnail_path).pipe(res)
})

// Short-lived single-use tokens let the browser upload straight to this API,
// bypassing the Netlify proxy's request-size limit without cross-site cookies.
const uploadTokens = new Map()
const uploadOrigins = (process.env.UPLOAD_ALLOWED_ORIGINS || 'https://danielwilsonportfolio.netlify.app').split(',').map((origin) => origin.trim()).filter(Boolean)

function uploadCors(req, res, next) {
  const origin = req.get('Origin')
  if (origin && uploadOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'X-Upload-Token, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
}

function loadUploadToken(req, res, next) {
  const token = req.get('X-Upload-Token') || ''
  const entry = uploadTokens.get(token)
  uploadTokens.delete(token)
  if (!entry || entry.expires < Date.now()) return res.status(401).json({ error: 'Upload authorization expired. Try again.' })
  const session = database.prepare(`
    SELECT users.id AS user_id, users.email, users.email_2fa_enabled, users.role, 'authenticated' AS state
    FROM users WHERE users.id = ? AND users.status = 'active'
  `).get(entry.userId)
  if (!session) return res.status(401).json({ error: 'Upload authorization expired. Try again.' })
  req.session = session
  next()
}

router.post('/videos/upload-token', loadSession, requireCsrf, requireTwoFactor, (req, res) => {
  for (const [key, value] of uploadTokens) if (value.expires < Date.now()) uploadTokens.delete(key)
  const token = randomBytes(32).toString('base64url')
  uploadTokens.set(token, { userId: req.session.user_id, expires: Date.now() + 5 * 60 * 1000 })
  return res.json({ token })
})

const handleUpload = [uploadRateLimit, (req, res, next) => {
  upload(req, res, (error) => error ? next(error) : next())
}, async (req, res) => {
  const videoFile = req.files?.video?.[0]
  const thumbnailFile = req.files?.thumbnail?.[0]
  if (!videoFile || !thumbnailFile) {
    for (const file of [videoFile, thumbnailFile]) if (file) rmSync(file.path, { force: true })
    return res.status(400).json({ error: 'A video and generated thumbnail are required.' })
  }
  if (thumbnailFile.size > 8 * 1024 * 1024) {
    rmSync(videoFile.path, { force: true })
    rmSync(thumbnailFile.path, { force: true })
    return res.status(413).json({ error: 'Generated thumbnails must be 8 MB or smaller.' })
  }

  const detectedVideo = await fileTypeFromFile(videoFile.path)
  const detectedThumbnail = await fileTypeFromFile(thumbnailFile.path)
  if (!detectedVideo || !acceptedVideoMimes.has(detectedVideo.mime) || !['mp4', 'webm', 'mov'].includes(detectedVideo.ext)) {
    rmSync(videoFile.path, { force: true })
    rmSync(thumbnailFile.path, { force: true })
    return res.status(415).json({ error: 'The uploaded file is not a supported MP4, M4V, MOV, or WebM video.' })
  }
  if (!detectedThumbnail || !acceptedThumbnailMimes.has(detectedThumbnail.mime)) {
    rmSync(videoFile.path, { force: true })
    rmSync(thumbnailFile.path, { force: true })
    return res.status(415).json({ error: 'The generated thumbnail must be a JPEG, PNG, or WebP image.' })
  }

  const duration = Number(req.body.duration)
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 140) : ''
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : ''
  if (!title || description.length > 1200 || !Number.isFinite(duration) || duration <= 0 || duration > 6 * 60 * 60) {
    rmSync(videoFile.path, { force: true })
    rmSync(thumbnailFile.path, { force: true })
    return res.status(400).json({ error: 'Provide a title and a supported video duration.' })
  }

  const id = randomUUID()
  const videoPath = join(videoDirectory, `${id}.${detectedVideo.ext}`)
  const thumbnailPath = join(thumbnailDirectory, `${id}.jpg`)
  renameSync(videoFile.path, videoPath)
  renameSync(thumbnailFile.path, thumbnailPath)
  const basename = videoFile.originalname.split(/[\\/]/).pop()
  const originalName = [...basename].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 240)
  database.prepare(`
    INSERT INTO videos (id, user_id, title, description, original_name, mime_type, duration_seconds, size_bytes, video_path, thumbnail_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.session.user_id, title, description, originalName, detectedVideo.mime, duration, videoFile.size, videoPath, thumbnailPath)

  return res.status(201).json({
    video: { id, title, description, originalName, mimeType: detectedVideo.mime, durationSeconds: duration, videoUrl: `/api/videos/${id}/file`, thumbnailUrl: `/api/videos/${id}/thumbnail` },
  })
}]

router.post('/videos', loadSession, requireCsrf, requireTwoFactor, ...handleUpload)
router.options('/videos/direct', uploadCors)
router.post('/videos/direct', uploadCors, loadUploadToken, ...handleUpload)

router.use(createAccountsRouter({
  loadSession,
  requireCsrf,
  requireTwoFactor,
  passwordRateLimit,
  mailTransport,
  isValidEmail,
  clearSessionCookie,
}))

app.use('/api', router)
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }))

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDirectory, { index: false, maxAge: '1h' }))
  app.get(/.*/, (req, res) => res.sendFile(join(distDirectory, 'index.html')))
}

app.use((error, req, res, next) => {
  for (const path of req.uploadTempPaths || []) rmSync(path, { force: true })
  const files = Object.values(req.files || {}).flat()
  for (const file of files) rmSync(file.path, { force: true })
  if (req.file) rmSync(req.file.path, { force: true })
  if (res.headersSent) return next(error)
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Video must be 500 MB or smaller.' : 'The upload could not be processed.' })
  }
  if (error.message?.startsWith('Choose an MP4')) return res.status(415).json({ error: error.message })
  console.error('Portal request failed:', error.message)
  return res.status(500).json({ error: 'The request could not be completed.' })
})

async function seedDevelopmentDemoOwner() {
  if (!(process.argv.includes('--demo') || process.env.SEED_DEMO_OWNER === 'true') || database.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return
  const email = process.env.PORTAL_DEMO_EMAIL || 'admin@example.com'
  const password = process.env.PORTAL_DEMO_PASSWORD || 'REDACTED'
  const credentials = await hashPassword(password)
  const result = database.prepare("INSERT INTO users (email, password_salt, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(email, credentials.salt, credentials.hash)
  database.prepare('INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json) VALUES (?, ?, ?, ?, ?)')
    .run(Number(result.lastInsertRowid), defaultCreatorName, process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.', JSON.stringify(['Filmmaking', 'Motion design', 'Editing']))
  console.log(`Development demo account initialized: ${email}. Authenticator setup is required on first sign-in.`)
}

await seedDevelopmentDemoOwner()

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'
const server = createServer(app)
server.listen(port, host, () => console.log(`Portal API listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))