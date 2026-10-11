import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
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
import { db } from './database.js'
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
// Email two-factor sign-in is off unless TWO_FACTOR_REQUIRED=true and TWO_FACTOR_EMAIL is set.
const twoFactorRequired = process.env.TWO_FACTOR_REQUIRED === 'true' && Boolean(process.env.TWO_FACTOR_EMAIL)

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
      connectSrc: ["'self'", 'https://api.cloudinary.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com', 'https://www.dailymotion.com', 'https://www.loom.com', 'https://streamable.com'],
      // Linked videos and their thumbnails can come from any https site.
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
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

// ---- Cloudinary (permanent storage for uploaded videos, thumbnails and profile images) ----
// Configure with CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>, or the three
// CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET variables.
function cloudinaryConfig() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME
  let apiKey = process.env.CLOUDINARY_API_KEY
  let apiSecret = process.env.CLOUDINARY_API_SECRET
  if (process.env.CLOUDINARY_URL) {
    try {
      const url = new URL(process.env.CLOUDINARY_URL)
      cloudName ||= url.hostname
      apiKey ||= decodeURIComponent(url.username)
      apiSecret ||= decodeURIComponent(url.password)
    } catch {
      console.error('CLOUDINARY_URL is not a valid cloudinary:// URL.')
    }
  }
  if (!cloudName || !apiKey || !apiSecret) return null
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: (process.env.CLOUDINARY_FOLDER || 'portfolio').replace(/^\/+|\/+$/g, ''),
    // Cloudinary's free plan caps videos at 100 MB and images at 10 MB per file.
    maxVideoBytes: Number(process.env.CLOUDINARY_MAX_VIDEO_MB || 100) * 1024 * 1024,
    maxImageBytes: 10 * 1024 * 1024,
  }
}

const cloudinary = cloudinaryConfig()

function cloudinarySignature(params) {
  const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&')
  return createHash('sha1').update(toSign + cloudinary.apiSecret).digest('hex')
}

// Checks the signature Cloudinary returns with every upload, so only files that really were
// uploaded to this account (and in this site's folder) can be saved.
function verifiedCloudinaryAsset(asset, resourceType) {
  if (!cloudinary || !asset || typeof asset !== 'object') return null
  const { public_id: publicId, version, signature, secure_url: url } = asset
  if (typeof publicId !== 'string' || typeof signature !== 'string' || typeof url !== 'string' || !['string', 'number'].includes(typeof version)) return null
  if (!publicId.startsWith(`${cloudinary.folder}/`)) return null
  const expected = createHash('sha1').update(`public_id=${publicId}&version=${version}${cloudinary.apiSecret}`).digest('hex')
  if (!constantTimeMatch(signature, expected)) return null
  if (!url.startsWith(`https://res.cloudinary.com/${cloudinary.cloudName}/${resourceType}/upload/`)) return null
  return { publicId, url, format: typeof asset.format === 'string' ? asset.format : '', bytes: Number(asset.bytes) || 0 }
}

async function destroyCloudinaryAsset(publicId, resourceType) {
  if (!cloudinary || !publicId) return
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) }
  const body = new URLSearchParams({ ...params, api_key: cloudinary.apiKey, signature: cloudinarySignature(params) })
  try {
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudinary.cloudName}/${resourceType}/destroy`, { method: 'POST', body })
    if (!response.ok) console.error('Cloudinary delete failed:', response.status)
  } catch (error) {
    console.error('Cloudinary delete failed:', error.message)
  }
}

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

async function loadSession(req, res, next) {
  const token = readCookie(req, sessionCookie)
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  const session = await db.get(`
    SELECT sessions.token_hash, sessions.csrf_token, sessions.user_id, sessions.state, sessions.expires_at,
      users.email, users.email_2fa_enabled, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'
  `, hashToken(token), Date.now())
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

async function issueSession(req, res, userId, state) {
  const previousToken = readCookie(req, sessionCookie)
  if (previousToken) await db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(previousToken))
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  await db.run('INSERT INTO sessions (token_hash, csrf_token, user_id, state, expires_at) VALUES (?, ?, ?, ?, ?)', hashToken(token), csrfToken, userId, state, Date.now() + sessionLifetime)
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

async function profileForUser(userId) {
  const profile = await db.get('SELECT * FROM creator_profiles WHERE user_id = ?', userId)
  let tags = []
  try { tags = JSON.parse(profile?.tags_json || '[]') } catch { tags = [] }
  return {
    displayName: profile?.display_name || defaultCreatorName,
    location: profile?.location || process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA',
    bio: profile?.bio || process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.',
    tags: profile ? (Array.isArray(tags) ? tags : []) : ['Filmmaking', 'Motion design', 'Editing'],
    imageUrl: profile?.image_url || (profile?.image_path ? `/api/public/profile/image?v=${encodeURIComponent(profile.updated_at)}` : '/ninja.svg'),
    updatedAt: profile?.updated_at || null,
  }
}

// Optional: profile text is also mirrored to a private GitHub Gist as an extra backup.
const gistConfig = () => process.env.PROFILE_GIST_ID && process.env.PROFILE_GIST_TOKEN
  ? { url: `https://api.github.com/gists/${process.env.PROFILE_GIST_ID}`, headers: { Authorization: `Bearer ${process.env.PROFILE_GIST_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'portfolio-api' } }
  : null

async function saveProfileBackup(userId) {
  const config = gistConfig()
  if (!config) return
  const { displayName, location, bio, tags } = await profileForUser(userId)
  fetch(config.url, {
    method: 'PATCH',
    headers: { ...config.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'profile.json': { content: JSON.stringify({ displayName, location, bio, tags }, null, 2) } } }),
  }).then((response) => { if (!response.ok) console.error('Profile backup failed:', response.status) })
    .catch((error) => console.error('Profile backup failed:', error.message))
}

async function restoreProfileBackup() {
  const config = gistConfig()
  const owner = config && await publicProfileOwner()
  if (!owner) return
  try {
    const response = await fetch(config.url, { headers: config.headers })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const content = (await response.json()).files?.['profile.json']?.content
    if (!content) return
    const saved = JSON.parse(content)
    if (typeof saved.displayName !== 'string' || !Array.isArray(saved.tags)) return
    await db.run(`
      INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, location = excluded.location,
        bio = excluded.bio, tags_json = excluded.tags_json, updated_at = CURRENT_TIMESTAMP
    `, owner.id, saved.displayName, saved.location || '', saved.bio || '', JSON.stringify(saved.tags))
    console.log('Profile restored from backup.')
  } catch (error) {
    console.error('Profile restore failed:', error.message)
  }
}

async function publicProfileOwner() {
  return await db.get('SELECT id FROM users ORDER BY id LIMIT 1')
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
  const user = await db.get('SELECT id FROM users WHERE email = ?', email)
  if (user) {
    const credentials = await hashPassword(password)
    await db.run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?', credentials.salt, credentials.hash, user.id)
    await db.run('DELETE FROM sessions WHERE user_id = ?', user.id)
  }
  return res.json({ message: 'If that account exists, its password has been reset. Sign in to continue.' })
})

router.get('/public/profile', async (req, res) => {
  const owner = await publicProfileOwner()
  return res.json(owner ? await profileForUser(owner.id) : {
    displayName: defaultCreatorName,
    location: process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA',
    bio: process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.',
    tags: ['Filmmaking', 'Motion design', 'Editing'],
    imageUrl: '/ninja.svg',
  })
})

router.get('/public/profile/image', async (req, res) => {
  const owner = await publicProfileOwner()
  const profile = owner && await db.get('SELECT image_path, image_url FROM creator_profiles WHERE user_id = ?', owner.id)
  if (profile?.image_url) return res.redirect(302, profile.image_url)
  if (!profile?.image_path) return res.status(404).end()
  res.type(extname(profile.image_path))
  res.setHeader('Cache-Control', 'public, max-age=300')
  return createReadStream(profile.image_path).pipe(res)
})

router.get('/profile', loadSession, requireTwoFactor, async (req, res) => res.json(await profileForUser(req.session.user_id)))

router.put('/profile', loadSession, requireCsrf, requireTwoFactor, async (req, res) => {
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
  await db.run(`
    INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      location = excluded.location,
      bio = excluded.bio,
      tags_json = excluded.tags_json,
      updated_at = CURRENT_TIMESTAMP
  `, req.session.user_id, displayName, location, bio, JSON.stringify(tags.map((tag) => tag.trim())))
  saveProfileBackup(req.session.user_id).catch((error) => console.error('Profile backup failed:', error.message))
  return res.json(await profileForUser(req.session.user_id))
})

// Local-disk profile image upload, used when Cloudinary isn't configured (local development).
router.put('/profile/image', loadSession, requireCsrf, requireTwoFactor, (req, res, next) => {
  if (cloudinary) return res.status(409).json({ error: 'Profile images are stored in Cloudinary. Refresh the page and try again.' })
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
  const current = await db.get('SELECT image_path, image_public_id FROM creator_profiles WHERE user_id = ?', req.session.user_id)
  const imagePath = join(profileImageDirectory, `${randomUUID()}.${imageType.ext}`)
  renameSync(req.file.path, imagePath)
  await db.run(`
    INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json, image_path)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET image_path = excluded.image_path, image_url = NULL, image_public_id = NULL, updated_at = CURRENT_TIMESTAMP
  `, req.session.user_id, defaultCreatorName, process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', '', '[]', imagePath)
  if (current?.image_path) rmSync(current.image_path, { force: true })
  return res.json(await profileForUser(req.session.user_id))
})

// Cloudinary profile image: the browser uploads to Cloudinary, then sends the signed result here.
router.put('/profile/image/cloudinary', loadSession, requireCsrf, requireTwoFactor, async (req, res) => {
  if (!cloudinary) return res.status(409).json({ error: 'Cloudinary storage is not configured.' })
  const image = verifiedCloudinaryAsset(req.body.image, 'image')
  if (!image) return res.status(400).json({ error: 'The uploaded image could not be verified. Try again.' })
  const current = await db.get('SELECT image_path, image_public_id FROM creator_profiles WHERE user_id = ?', req.session.user_id)
  await db.run(`
    INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json, image_url, image_public_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET image_url = excluded.image_url, image_public_id = excluded.image_public_id, image_path = NULL, updated_at = CURRENT_TIMESTAMP
  `, req.session.user_id, defaultCreatorName, process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', '', '[]', image.url, image.publicId)
  if (current?.image_public_id && current.image_public_id !== image.publicId) void destroyCloudinaryAsset(current.image_public_id, 'image')
  if (current?.image_path) rmSync(current.image_path, { force: true })
  return res.json(await profileForUser(req.session.user_id))
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

// Where a video plays from and its thumbnail, by storage source. `scope` picks the
// public or the signed-in route for files kept on this server's disk.
function videoMedia(video, scope) {
  if (video.source === 'youtube') {
    return {
      source: 'link',
      provider: 'youtube',
      providerName: 'YouTube',
      videoUrl: null,
      embedUrl: `https://www.youtube-nocookie.com/embed/${video.youtube_id}?rel=0`,
      watchUrl: `https://www.youtube.com/watch?v=${video.youtube_id}`,
      thumbnailUrl: video.thumbnail_url || `https://i.ytimg.com/vi/${video.youtube_id}/hqdefault.jpg`,
    }
  }
  if (video.source === 'link') {
    return {
      source: 'link',
      provider: video.provider,
      providerName: linkProviders[video.provider]?.name || 'Link',
      videoUrl: video.video_url || null,
      embedUrl: video.embed_url || null,
      watchUrl: video.external_url,
      thumbnailUrl: video.thumbnail_url || '/og.jpg',
    }
  }
  if (video.source === 'cloudinary') return { source: 'cloudinary', videoUrl: video.video_url, thumbnailUrl: video.thumbnail_url }
  const base = scope === 'public' ? '/api/portfolio-videos' : '/api/videos'
  return { source: 'file', videoUrl: `${base}/${video.id}/file`, thumbnailUrl: `${base}/${video.id}/thumbnail` }
}

async function publicVideoPayload(video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    originalName: video.source === 'file' ? video.original_name : '',
    mimeType: video.mime_type,
    durationSeconds: video.duration_seconds,
    uploadedAt: video.created_at,
    uploadedBy: (await profileForUser(video.user_id)).displayName,
    ...videoMedia(video, 'public'),
  }
}

function privateVideoPayload(video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    original_name: video.original_name,
    mime_type: video.mime_type,
    duration_seconds: video.duration_seconds,
    size_bytes: video.size_bytes,
    created_at: video.created_at,
    ...videoMedia(video, 'private'),
  }
}

router.get('/portfolio-videos', async (req, res) => {
  const owner = await publicProfileOwner()
  if (!owner) return res.json({ videos: [] })
  const videos = await db.all('SELECT * FROM videos WHERE user_id = ? AND is_public = 1 ORDER BY created_at DESC', owner.id)
  return res.json({ videos: await Promise.all(videos.map(publicVideoPayload)) })
})

router.get('/portfolio-videos/:id', async (req, res) => {
  const video = await db.get('SELECT * FROM videos WHERE id = ? AND is_public = 1', req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  return res.json({ video: await publicVideoPayload(video) })
})

router.get('/portfolio-videos/:id/file', async (req, res) => {
  const video = await db.get("SELECT * FROM videos WHERE id = ? AND is_public = 1 AND source = 'file'", req.params.id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  return streamVideoRange(req, res, video)
})

router.get('/portfolio-videos/:id/thumbnail', async (req, res) => {
  const video = await db.get("SELECT thumbnail_path FROM videos WHERE id = ? AND is_public = 1 AND source = 'file'", req.params.id)
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
  const user = await db.get('SELECT id FROM users WHERE email = ?', email)
  if (user) {
    const credentials = await hashPassword(password)
    await db.run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?', credentials.salt, credentials.hash, user.id)
    await db.run('DELETE FROM sessions WHERE user_id = ?', user.id)
  }
  return res.json({ message: 'If that account exists, its password has been reset. Sign in to continue.' })
})

router.post('/auth/login', passwordRateLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  if (!isValidEmail(email) || password.length > 256 || !(await passwordMatches(await db.get('SELECT * FROM users WHERE email = ?', email), password))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' })
  }
  const user = await db.get('SELECT * FROM users WHERE email = ?', email)
  if (user.status !== 'active') return res.status(401).json({ error: 'Email or password is incorrect.' })
  const twoFactorEnabled = user.email_2fa_enabled === 1
  const state = !twoFactorRequired ? 'authenticated' : (twoFactorEnabled ? 'two_factor_pending' : 'setup_required')
  const csrfToken = await issueSession(req, res, user.id, state)
  return res.json({ state, email, csrfToken, twoFactorEnabled, role: user.role })
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
  await db.run('UPDATE users SET email_otp_hash = ?, email_otp_expires_at = ?, email_otp_attempts = 0 WHERE id = ?', hash, Date.now() + emailOtpLifetime, req.session.user_id)
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
    await db.run('UPDATE users SET email_otp_hash = NULL, email_otp_expires_at = NULL WHERE id = ?', req.session.user_id)
    console.error('Unable to send sign-in code:', error.message)
    return res.status(503).json({ error: 'The verification email could not be sent. Check the SMTP settings and try again.' })
  }
  return res.json({ message: `A verification code was sent to ${maskEmail(recipient)}.` })
})

router.post('/auth/email-code/verify', authRateLimit, loadSession, requireCsrf, async (req, res) => {
  if (!['setup_required', 'two_factor_pending'].includes(req.session.state)) {
    return res.status(409).json({ error: 'This session is not waiting for email verification.' })
  }
  const user = await db.get('SELECT email_otp_hash, email_otp_expires_at, email_otp_attempts FROM users WHERE id = ?', req.session.user_id)
  if (!user.email_otp_hash || !user.email_otp_expires_at || user.email_otp_expires_at <= Date.now()) {
    return res.status(401).json({ error: 'That verification code expired. Send a new code.' })
  }
  if (user.email_otp_attempts >= emailOtpMaxAttempts) {
    await db.run('UPDATE users SET email_otp_hash = NULL, email_otp_expires_at = NULL WHERE id = ?', req.session.user_id)
    return res.status(429).json({ error: 'Too many code attempts. Send a new verification code.' })
  }
  if (!verifyEmailOtp(req.session.user_id, req.body.code, user.email_otp_hash)) {
    await db.run('UPDATE users SET email_otp_attempts = email_otp_attempts + 1 WHERE id = ?', req.session.user_id)
    return res.status(401).json({ error: 'That verification code is incorrect.' })
  }
  await db.run('UPDATE users SET email_2fa_enabled = 1, email_otp_hash = NULL, email_otp_expires_at = NULL, email_otp_attempts = 0 WHERE id = ?', req.session.user_id)
  await db.run("UPDATE sessions SET state = 'authenticated' WHERE token_hash = ?", req.session.token_hash)
  return res.json({ state: 'authenticated', email: req.session.email, csrfToken: req.session.csrf_token, twoFactorEnabled: true, role: req.session.role })
})

router.post('/auth/logout', loadSession, requireCsrf, async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token_hash = ?', req.session.token_hash)
  clearSessionCookie(res)
  return res.status(204).end()
})

router.get('/videos', loadSession, requireTwoFactor, async (req, res) => {
  const videos = await db.all('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC', req.session.user_id)
  return res.json({ videos: videos.map(privateVideoPayload) })
})

router.get('/videos/thumbnails', loadSession, requireTwoFactor, async (req, res) => {
  const videos = await db.all('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC', req.session.user_id)
  const thumbnails = videos.map((video) => ({ id: video.id, title: video.title, created_at: video.created_at, source: video.source, thumbnailUrl: videoMedia(video, 'private').thumbnailUrl }))
  return res.json({ thumbnails })
})

router.get('/videos/export', loadSession, requireTwoFactor, async (req, res) => {
  const videos = (await db.all('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC', req.session.user_id)).map((video) => {
    const media = videoMedia(video, 'private')
    return {
      id: video.id,
      title: video.title,
      description: video.description,
      original_name: video.original_name,
      mime_type: video.mime_type,
      duration_seconds: video.duration_seconds,
      size_bytes: video.size_bytes,
      created_at: video.created_at,
      source: media.source,
      fileUrl: media.videoUrl,
      linkUrl: media.watchUrl || null,
      thumbnailUrl: media.thumbnailUrl,
    }
  })
  res.setHeader('Content-Disposition', 'attachment; filename="video-details.json"')
  return res.json({ exportedAt: new Date().toISOString(), count: videos.length, videos })
})

router.get('/videos/:id/file', loadSession, requireTwoFactor, async (req, res) => {
  const video = await db.get("SELECT video_path, mime_type, original_name FROM videos WHERE id = ? AND user_id = ? AND source = 'file'", req.params.id, req.session.user_id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  return streamVideoRange(req, res, video)
})

router.get('/videos/:id/thumbnail', loadSession, requireTwoFactor, async (req, res) => {
  const video = await db.get("SELECT thumbnail_path FROM videos WHERE id = ? AND user_id = ? AND source = 'file'", req.params.id, req.session.user_id)
  if (!video) return res.status(404).json({ error: 'Video not found.' })
  res.type('image/jpeg')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  return createReadStream(video.thumbnail_path).pipe(res)
})

// ---- Storage configuration and Cloudinary signed uploads ----

router.get('/media/config', loadSession, requireTwoFactor, (req, res) => res.json({
  storage: cloudinary ? 'cloudinary' : 'local',
  maxVideoBytes: cloudinary ? cloudinary.maxVideoBytes : 500 * 1024 * 1024,
  maxImageBytes: cloudinary ? cloudinary.maxImageBytes : 8 * 1024 * 1024,
}))

const cloudinaryFolders = { video: 'videos', thumbnail: 'thumbnails', profile: 'profiles' }

router.post('/media/signature', uploadRateLimit, loadSession, requireCsrf, requireTwoFactor, (req, res) => {
  if (!cloudinary) return res.status(409).json({ error: 'Cloudinary storage is not configured.' })
  const purpose = req.body.purpose
  if (!Object.hasOwn(cloudinaryFolders, purpose)) return res.status(400).json({ error: 'purpose must be video, thumbnail, or profile.' })
  const params = { folder: `${cloudinary.folder}/${cloudinaryFolders[purpose]}`, timestamp: Math.floor(Date.now() / 1000) }
  return res.json({
    cloudName: cloudinary.cloudName,
    apiKey: cloudinary.apiKey,
    resourceType: purpose === 'video' ? 'video' : 'image',
    ...params,
    signature: cloudinarySignature(params),
  })
})

function videoFields(body) {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 140) : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!title) return { error: 'Add a project title.' }
  if (description.length > 1200) return { error: 'Descriptions can be up to 1,200 characters.' }
  return { title, description }
}

async function reusableThumbnail(videoId, userId) {
  if (typeof videoId !== 'string' || !videoId) return null
  const video = await db.get('SELECT * FROM videos WHERE id = ? AND user_id = ?', videoId, userId)
  if (!video || video.source === 'file') return null
  return { url: videoMedia(video, 'private').thumbnailUrl, publicId: null }
}

// Saves a video the browser already uploaded to Cloudinary.
router.post('/videos/cloudinary', loadSession, requireCsrf, requireTwoFactor, async (req, res) => {
  if (!cloudinary) return res.status(409).json({ error: 'Cloudinary storage is not configured.' })
  const fields = videoFields(req.body)
  if (fields.error) return res.status(400).json({ error: fields.error })
  const video = verifiedCloudinaryAsset(req.body.video, 'video')
  if (!video) return res.status(400).json({ error: 'The uploaded video could not be verified. Upload it again.' })
  const thumbnail = req.body.reuseThumbnailOf
    ? await reusableThumbnail(req.body.reuseThumbnailOf, req.session.user_id)
    : verifiedCloudinaryAsset(req.body.thumbnail, 'image')
  if (!thumbnail) return res.status(400).json({ error: 'The thumbnail could not be verified. Choose it again.' })
  const duration = Number(req.body.duration) || Number(req.body.video?.duration) || 0
  if (!Number.isFinite(duration) || duration < 0 || duration > 6 * 60 * 60) return res.status(400).json({ error: 'The video duration is not supported.' })

  const id = randomUUID()
  const originalName = typeof req.body.originalName === 'string'
    ? [...req.body.originalName.split(/[\\/]/).pop()].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 240)
    : ''
  await db.run(`
    INSERT INTO videos (id, user_id, title, description, original_name, mime_type, duration_seconds, size_bytes, video_path, thumbnail_path,
      source, video_url, thumbnail_url, cloudinary_video_id, cloudinary_thumbnail_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 'cloudinary', ?, ?, ?, ?)
  `, id, req.session.user_id, fields.title, fields.description, originalName || `${video.publicId}.${video.format || 'mp4'}`,
  `video/${video.format === 'mov' ? 'quicktime' : video.format || 'mp4'}`, duration, video.bytes || 0, video.url, thumbnail.url, video.publicId, thumbnail.publicId)
  return res.status(201).json({ video: privateVideoPayload(await db.get('SELECT * FROM videos WHERE id = ?', id)) })
})

// ---- Video links (YouTube, Vimeo, Dailymotion, Loom, Streamable, direct files, any web page) ----

const videoFileExtensions = /\.(mp4|m4v|webm|mov|ogv|ogg)$/i
const linkProviders = {
  youtube: { name: 'YouTube', oembed: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}` },
  vimeo: { name: 'Vimeo', oembed: (url) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}` },
  dailymotion: { name: 'Dailymotion', oembed: (url) => `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(url)}` },
  loom: { name: 'Loom', oembed: (url) => `https://www.loom.com/v1/oembed?format=json&url=${encodeURIComponent(url)}` },
  streamable: { name: 'Streamable', oembed: (url) => `https://api.streamable.com/oembed.json?url=${encodeURIComponent(url)}` },
  file: { name: 'Video file' },
  page: { name: 'Web page' },
}

function youtubeIdFrom(url) {
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  let id = null
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v')
    else id = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] || null
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
}

// Works out which service a link belongs to and how to play it.
function classifyVideoLink(input) {
  if (typeof input !== 'string' || input.trim().length > 2000) return null
  const raw = input.trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return classifyVideoLink(`https://www.youtube.com/watch?v=${raw}`)
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.replace(/^www\./, '').toLowerCase()

  const youtubeId = youtubeIdFrom(url)
  if (youtubeId) {
    return { provider: 'youtube', providerId: youtubeId, watchUrl: `https://www.youtube.com/watch?v=${youtubeId}`, embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0`, thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` }
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const match = host === 'player.vimeo.com'
      ? /^\/video\/(\d+)/.exec(url.pathname)
      : /^\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/)?(\d+)(?:\/([0-9a-f]+))?/.exec(url.pathname)
    if (match) {
      const hash = match[2] || url.searchParams.get('h')
      return { provider: 'vimeo', providerId: match[1], watchUrl: `https://vimeo.com/${match[1]}${hash ? `/${hash}` : ''}`, embedUrl: `https://player.vimeo.com/video/${match[1]}${hash ? `?h=${hash}` : ''}`, thumbnailUrl: null }
    }
  }
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = host === 'dai.ly' ? url.pathname.slice(1) : /^\/(?:embed\/)?video\/([a-zA-Z0-9]+)/.exec(url.pathname)?.[1]
    if (id && /^[a-zA-Z0-9]+$/.test(id)) return { provider: 'dailymotion', providerId: id, watchUrl: `https://www.dailymotion.com/video/${id}`, embedUrl: `https://www.dailymotion.com/embed/video/${id}`, thumbnailUrl: `https://www.dailymotion.com/thumbnail/video/${id}` }
  }
  if (host === 'loom.com') {
    const id = /^\/(?:share|embed)\/([0-9a-f]{20,})/.exec(url.pathname)?.[1]
    if (id) return { provider: 'loom', providerId: id, watchUrl: `https://www.loom.com/share/${id}`, embedUrl: `https://www.loom.com/embed/${id}`, thumbnailUrl: null }
  }
  if (host === 'streamable.com') {
    const id = /^\/(?:e\/|o\/)?([a-z0-9]+)$/i.exec(url.pathname)?.[1]
    if (id) return { provider: 'streamable', providerId: id, watchUrl: `https://streamable.com/${id}`, embedUrl: `https://streamable.com/e/${id}`, thumbnailUrl: null }
  }
  if (url.protocol === 'https:' && videoFileExtensions.test(url.pathname)) {
    return { provider: 'file', providerId: null, watchUrl: url.href, embedUrl: null, videoUrl: url.href, thumbnailUrl: null }
  }
  return { provider: 'page', providerId: null, watchUrl: url.href, embedUrl: null, thumbnailUrl: null }
}

function isPrivateAddress(address) {
  if (address.includes(':')) {
    const value = address.toLowerCase()
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.')
  }
  const [a, b] = address.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// Fetches a public URL from the server with a timeout and size cap, refusing private network addresses.
async function fetchPublic(target, { method = 'GET', maxBytes = 512 * 1024 } = {}) {
  let url = new URL(target)
  let response
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const addresses = await lookup(url.hostname, { all: true }).catch(() => [])
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return null
    response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrameByFramePortfolio/1.0)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.5' } })
    const location = response.status >= 300 && response.status < 400 && response.headers.get('location')
    if (!location) break
    url = new URL(location, url)
    if (hop === 3) return null
  }
  if (method === 'HEAD' || !response.body) return { response, text: '' }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (size < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  reader.cancel().catch(() => {})
  return { response, text: Buffer.concat(chunks).toString('utf8') }
}

function metaContent(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i')
  const tag = pattern.exec(html)?.[0]
  const value = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1]
  return value ? value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : ''
}

function httpsUrlOrNull(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// Fills in title, thumbnail and duration from the service, when it will tell us.
async function linkDetails(link) {
  const provider = linkProviders[link.provider]
  const details = { title: '', author: '', thumbnailUrl: link.thumbnailUrl, durationSeconds: 0 }
  try {
    if (provider.oembed) {
      const result = await fetchPublic(provider.oembed(link.watchUrl))
      if (result?.response.status === 404) return { ...details, missing: true }
      if (result?.response.status === 401 || result?.response.status === 403) return { ...details, private: true }
      if (result?.response.ok) {
        const data = JSON.parse(result.text)
        details.title = typeof data.title === 'string' ? data.title.slice(0, 140) : ''
        details.author = typeof data.author_name === 'string' ? data.author_name : ''
        details.thumbnailUrl = details.thumbnailUrl || httpsUrlOrNull(data.thumbnail_url)
        details.durationSeconds = Number(data.duration) > 0 ? Number(data.duration) : 0
      }
    } else if (link.provider === 'page') {
      const result = await fetchPublic(link.watchUrl)
      const type = result?.response.headers.get('content-type') || ''
      if (type.startsWith('video/')) return { ...details, provider: 'file', videoUrl: link.watchUrl }
      if (result?.response.ok && type.includes('html')) {
        details.title = (metaContent(result.text, 'og:title') || /<title[^>]*>([^<]*)<\/title>/i.exec(result.text)?.[1] || '').trim().slice(0, 140)
        const image = metaContent(result.text, 'og:image') || metaContent(result.text, 'twitter:image')
        details.thumbnailUrl = image ? httpsUrlOrNull(new URL(image, link.watchUrl).href) : null
      }
    }
  } catch {
    // Details are optional; the link still works without them.
  }
  return details
}

async function resolveVideoLink(input) {
  const link = classifyVideoLink(input)
  if (!link) return { error: 'Paste a full video link that starts with https://.' }
  const details = await linkDetails(link)
  if (details.missing) return { error: `That ${linkProviders[link.provider].name} video could not be found. Check that it is public or unlisted.` }
  if (details.private) return { error: `That ${linkProviders[link.provider].name} video is private or doesn't allow embedding.` }
  const provider = details.provider || link.provider
  return {
    link: {
      ...link,
      provider,
      providerName: linkProviders[provider].name,
      videoUrl: details.videoUrl || link.videoUrl || null,
      title: details.title,
      author: details.author,
      thumbnailUrl: details.thumbnailUrl || null,
      durationSeconds: details.durationSeconds,
    },
  }
}

router.post('/videos/link/preview', loadSession, requireCsrf, requireTwoFactor, async (req, res) => {
  const { link, error } = await resolveVideoLink(req.body.url)
  if (error) return res.status(400).json({ error })
  return res.json({
    provider: link.provider,
    providerName: link.providerName,
    title: link.title,
    author: link.author,
    thumbnailUrl: link.thumbnailUrl,
    durationSeconds: link.durationSeconds,
    embedUrl: link.embedUrl,
    videoUrl: link.videoUrl,
    watchUrl: link.watchUrl,
  })
})

router.post('/videos/link', loadSession, requireCsrf, requireTwoFactor, async (req, res) => {
  const fields = videoFields(req.body)
  if (fields.error) return res.status(400).json({ error: fields.error })
  const customThumbnail = typeof req.body.thumbnailUrl === 'string' && req.body.thumbnailUrl.trim() ? httpsUrlOrNull(req.body.thumbnailUrl.trim()) : null
  if (typeof req.body.thumbnailUrl === 'string' && req.body.thumbnailUrl.trim() && !customThumbnail) {
    return res.status(400).json({ error: 'The thumbnail link must start with https://.' })
  }
  const { link, error } = await resolveVideoLink(req.body.url)
  if (error) return res.status(400).json({ error })
  const id = randomUUID()
  await db.run(`
    INSERT INTO videos (id, user_id, title, description, original_name, mime_type, duration_seconds, size_bytes, video_path, thumbnail_path,
      source, provider, youtube_id, embed_url, external_url, video_url, thumbnail_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', 'link', ?, ?, ?, ?, ?, ?)
  `, id, req.session.user_id, fields.title, fields.description, link.watchUrl.slice(0, 240), `video/${link.provider}`, link.durationSeconds,
  link.provider, link.provider === 'youtube' ? link.providerId : null, link.embedUrl, link.watchUrl, link.videoUrl, customThumbnail || link.thumbnailUrl)
  return res.status(201).json({ video: privateVideoPayload(await db.get('SELECT * FROM videos WHERE id = ?', id)) })
})

// ---- Local-disk uploads (used when Cloudinary isn't configured) ----

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

async function loadUploadToken(req, res, next) {
  const token = req.get('X-Upload-Token') || ''
  const entry = uploadTokens.get(token)
  uploadTokens.delete(token)
  if (!entry || entry.expires < Date.now()) return res.status(401).json({ error: 'Upload authorization expired. Try again.' })
  const session = await db.get(`
    SELECT users.id AS user_id, users.email, users.email_2fa_enabled, users.role, 'authenticated' AS state
    FROM users WHERE users.id = ? AND users.status = 'active'
  `, entry.userId)
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
  if (cloudinary) return res.status(409).json({ error: 'Videos are stored in Cloudinary. Refresh the page and try again.' })
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
  await db.run(`
    INSERT INTO videos (id, user_id, title, description, original_name, mime_type, duration_seconds, size_bytes, video_path, thumbnail_path, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file')
  `, id, req.session.user_id, title, description, originalName, detectedVideo.mime, duration, videoFile.size, videoPath, thumbnailPath)

  return res.status(201).json({ video: privateVideoPayload(await db.get('SELECT * FROM videos WHERE id = ?', id)) })
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
  if (!(process.argv.includes('--demo') || process.env.SEED_DEMO_OWNER === 'true') || (await db.get('SELECT COUNT(*) AS count FROM users')).count > 0) return
  const email = process.env.PORTAL_DEMO_EMAIL
  const password = process.env.PORTAL_DEMO_PASSWORD
  if (!email || !password) {
    console.warn('Demo owner not seeded: set PORTAL_DEMO_EMAIL and PORTAL_DEMO_PASSWORD.')
    return
  }
  const credentials = await hashPassword(password)
  const result = await db.run("INSERT INTO users (email, password_salt, password_hash, role) VALUES (?, ?, ?, 'admin')", email, credentials.salt, credentials.hash)
  await db.run('INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json) VALUES (?, ?, ?, ?, ?)', Number(result.lastInsertRowid), defaultCreatorName, process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', process.env.VITE_CREATOR_BIO || 'Independent filmmaker and motion designer, drawn to small details and big feelings.', JSON.stringify(['Filmmaking', 'Motion design', 'Editing']))
  console.log(`Demo admin account created: ${email}.`)
}

// With 2FA off, drop sessions stuck waiting for an email code so those browsers return to the sign-in form.
if (!twoFactorRequired) await db.run("DELETE FROM sessions WHERE state != 'authenticated'")

await seedDevelopmentDemoOwner()
await restoreProfileBackup()

const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'
const server = createServer(app)
server.listen(port, host, () => console.log(`Portal API listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))