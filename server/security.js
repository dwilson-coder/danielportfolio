import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const developmentSecretPath = resolve('server/data/.dev-secret')

if (process.env.NODE_ENV === 'production' && (process.env.SESSION_SECRET || '').length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production.')
}
if (process.env.NODE_ENV === 'production' && (process.env.PORTAL_RECOVERY_CODE || '').length < 32) {
  throw new Error('PORTAL_RECOVERY_CODE must contain at least 32 characters in production.')
}

if (!process.env.SESSION_SECRET && process.env.NODE_ENV !== 'production') {
  mkdirSync(dirname(developmentSecretPath), { recursive: true })
  if (!existsSync(developmentSecretPath)) {
    writeFileSync(developmentSecretPath, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' })
  }
}

export const sessionSecret = process.env.SESSION_SECRET || readFileSync(developmentSecretPath, 'utf8').trim()

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return { salt, hash: hash.toString('hex') }
}

export async function verifyPassword(password, salt, storedHash) {
  const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const expected = Buffer.from(storedHash, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function constantTimeMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function createEmailOtp(userId) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hash = createHmac('sha256', sessionSecret).update(`${userId}:${code}`).digest('hex')
  return { code, hash }
}

export function verifyEmailOtp(userId, code, storedHash) {
  if (!/^\d{6}$/.test(code) || typeof storedHash !== 'string') return false
  const hash = createHmac('sha256', sessionSecret).update(`${userId}:${code}`).digest('hex')
  return constantTimeMatch(hash, storedHash)
}
