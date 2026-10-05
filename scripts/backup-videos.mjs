// Usage: node scripts/backup-videos.mjs [baseUrl] [outDir]
// Env: BACKUP_EMAIL, BACKUP_PASSWORD
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const base = (process.argv[2] || 'https://danielwilsonportfolio.netlify.app').replace(/\/$/, '')
const outDir = process.argv[3] || 'video-backup'
const { BACKUP_EMAIL: email, BACKUP_PASSWORD: password } = process.env
if (!email || !password) throw new Error('Set BACKUP_EMAIL and BACKUP_PASSWORD.')

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
if (!login.ok) throw new Error(`Login failed (${login.status}).`)
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const get = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } })

const details = await (await get('/api/videos/export')).json()
mkdirSync(join(outDir, 'videos'), { recursive: true })
writeFileSync(join(outDir, 'video-details.json'), JSON.stringify(details, null, 2))

for (const video of details.videos) {
  const name = `${video.id}-${video.original_name}`.replace(/[\\/:*?"<>|]/g, '_')
  const res = await get(video.fileUrl)
  if (!res.ok) { console.error(`Skipped ${video.title}: ${res.status}`); continue }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(join(outDir, 'videos', name)))
  console.log(`Saved ${name}`)
}
console.log(`Done: ${details.count} video(s) in ${outDir}`)
