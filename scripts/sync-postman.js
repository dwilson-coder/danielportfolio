import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const postmanDir = resolve(root, 'postman')
const environmentPath = resolve(postmanDir, 'local.postman_environment.json')

// Load environment variables from .env
try {
  const envContent = readFileSync(resolve(root, '.env'), 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      if (!process.env[key]) process.env[key] = val
    }
  }
} catch {}

const args = process.argv.slice(2)
function getArg(flag) {
  const index = args.indexOf(flag)
  return index !== -1 ? args[index + 1] : null
}

const apiKey = getArg('--api-key') || process.env.POSTMAN_API_KEY
const workspaceId = getArg('--workspace') || process.env.POSTMAN_WORKSPACE_ID

console.log('=== Postman CLI Cloud Sync Utility ===\n')

if (!apiKey) {
  console.log(`To upload and sync your collections and environments to Postman via CLI:

1. Obtain a Postman API Key:
   Visit: https://go.postman.co/settings/me/api-keys and click "Generate API Key"

2. Run:
   node scripts/sync-postman.js --api-key <YOUR_POSTMAN_API_KEY> [--workspace <WORKSPACE_ID>]
   or set POSTMAN_API_KEY in your .env file and run:
   npm run postman:sync
`)
  process.exit(0)
}

const headers = {
  'X-Api-Key': apiKey,
  'Content-Type': 'application/json',
}

async function syncAllToPostman() {
  // Find all collection files in postman/
  const collectionFiles = readdirSync(postmanDir)
    .filter((file) => file.endsWith('.postman_collection.json'))
    .map((file) => join(postmanDir, file))

  const environmentJson = JSON.parse(readFileSync(environmentPath, 'utf8'))

  let existingCollections = []
  let existingEnvironments = []

  if (workspaceId) {
    const wsRes = await fetch(`https://api.getpostman.com/workspaces/${workspaceId}`, { headers })
    if (wsRes.ok) {
      const wsData = await wsRes.json()
      console.log(`[cli] Connected to workspace: "${wsData.workspace?.name}" (${workspaceId})`)
      existingCollections = wsData.workspace?.collections || []
      existingEnvironments = wsData.workspace?.environments || []
    }
  }

  // 1. Sync All Collections
  for (const file of collectionFiles) {
    const colJson = JSON.parse(readFileSync(file, 'utf8'))
    const colName = colJson.info.name
    const existing = existingCollections.find((c) => c.name === colName)

    if (existing) {
      console.log(`[cli] Updating collection "${colName}" (${existing.id})...`)
      const res = await fetch(`https://api.getpostman.com/collections/${existing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ collection: colJson }),
      })
      const data = await res.json()
      if (!res.ok) {
        console.error(`[cli] Failed to update collection "${colName}":`, data?.error?.message || data)
      } else {
        console.log(`[cli] Collection "${colName}" updated successfully!`)
      }
    } else {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''
      console.log(`[cli] Creating collection "${colName}"...`)
      const res = await fetch(`https://api.getpostman.com/collections${qs}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ collection: colJson }),
      })
      const data = await res.json()
      if (!res.ok) {
        console.error(`[cli] Failed to create collection "${colName}":`, data?.error?.message || data)
      } else {
        console.log(`[cli] Collection "${colName}" created successfully! (ID: ${data.collection.id})`)
      }
    }
  }

  // 2. Sync Environment
  const envExisting = existingEnvironments.find((e) => e.name === environmentJson.name)
  if (envExisting) {
    console.log(`[cli] Updating environment "${environmentJson.name}" (${envExisting.id})...`)
    const envRes = await fetch(`https://api.getpostman.com/environments/${envExisting.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ environment: environmentJson }),
    })
    const envData = await envRes.json()
    if (!envRes.ok) {
      console.error(`[cli] Failed to update environment:`, envData?.error?.message || envData)
    } else {
      console.log(`[cli] Environment "${environmentJson.name}" updated successfully!`)
    }
  } else {
    const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''
    console.log(`[cli] Creating environment "${environmentJson.name}"...`)
    const envRes = await fetch(`https://api.getpostman.com/environments${qs}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ environment: environmentJson }),
    })
    const envData = await envRes.json()
    if (!envRes.ok) {
      console.error(`[cli] Failed to create environment:`, envData?.error?.message || envData)
    } else {
      console.log(`[cli] Environment "${environmentJson.name}" created successfully! (ID: ${envData.environment.id})`)
    }
  }

  console.log('\n==============================================')
  console.log('[cli] All collections and routes synced to Postman!')
  if (workspaceId) {
    console.log(`[cli] Workspace link: https://go.postman.co/workspace/${workspaceId}`)
  }
  console.log('==============================================\n')
}

syncAllToPostman().catch((err) => {
  console.error('[cli] Sync failed:', err.message)
  process.exit(1)
})
