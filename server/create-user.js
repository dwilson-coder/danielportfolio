import { randomBytes } from 'node:crypto'
import { database } from './database.js'
import { hashPassword } from './security.js'

const email = (process.argv[2] || '').trim().toLowerCase()
const requestedPassword = process.argv[3]
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  throw new Error('Usage: npm run create-user -- you@example.com [development-password]')
}
if (requestedPassword && process.env.NODE_ENV === 'production') {
  throw new Error('Explicit passwords are only allowed in development. Use the generated password in production.')
}
if (requestedPassword && (requestedPassword.length < 8 || requestedPassword.length > 256)) {
  throw new Error('Development passwords must be between 8 and 256 characters.')
}

if (database.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) {
  throw new Error('A creator account already exists. Use the configured password-recovery code to reset it.')
}

const password = requestedPassword || randomBytes(24).toString('base64url')
const credentials = await hashPassword(password)
const result = database.prepare("INSERT INTO users (email, password_salt, password_hash, role) VALUES (?, ?, ?, 'admin')")
  .run(email, credentials.salt, credentials.hash)
database.prepare('INSERT INTO creator_profiles (user_id, display_name, location, bio, tags_json) VALUES (?, ?, ?, ?, ?)')
  .run(Number(result.lastInsertRowid), process.env.VITE_CREATOR_NAME || 'Daniel Wilson', process.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', process.env.VITE_CREATOR_BIO || '', JSON.stringify(['Filmmaking', 'Motion design', 'Editing']))

console.log(`Creator account: ${email}`)
console.log(requestedPassword ? 'Development demo password configured.' : `One-time generated password: ${password}`)
console.log('Save this password securely. Email two-factor verification is required on first sign-in.')