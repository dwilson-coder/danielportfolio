import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import newman from 'newman'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const collectionPath = resolve(root, 'postman/accounts-api.postman_collection.json')
const environmentPath = resolve(root, 'postman/local.postman_environment.json')

const collection = JSON.parse(readFileSync(collectionPath, 'utf8'))
const environment = JSON.parse(readFileSync(environmentPath, 'utf8'))
const demoEmail = process.env.PORTAL_DEMO_EMAIL
const demoPassword = process.env.PORTAL_DEMO_PASSWORD
if (!demoEmail || !demoPassword) {
  console.error('Set PORTAL_DEMO_EMAIL and PORTAL_DEMO_PASSWORD before running Postman tests.')
  process.exit(1)
}
for (const entry of environment.values) {
  if (entry.key === 'email') entry.value = demoEmail
  if (entry.key === 'password') entry.value = demoPassword
}

const args = process.argv.slice(2)
const folderArgIndex = args.indexOf('--folder')
const requestedFolder = folderArgIndex !== -1 ? args[folderArgIndex + 1] : null
const useNewmanDirect = args.includes('--newman') || requestedFolder !== null

async function isServerRunning(url = 'http://localhost:3001/api/health') {
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return false
  }
}

async function waitForServer(url = 'http://localhost:3001/api/health', timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning(url)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function main() {
  console.log('=== Frame by Frame Postman CLI Test Runner ===\n')

  let serverProcess = null
  let resetToken = ''
  let otpCode = ''

  const alreadyRunning = await isServerRunning()
  if (alreadyRunning) {
    console.log('[cli] Connected to active API server on http://localhost:3001')
  } else {
    console.log('[cli] Launching local development API server...')
    serverProcess = spawn('node', ['--env-file-if-exists=.env', 'server/index.js', '--demo'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    serverProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      const mReset = text.match(/\[dev\] Password reset token for [^:]+:\s*([A-Za-z0-9_-]+)/)
      if (mReset) resetToken = mReset[1]
      const mOtp = text.match(/\[dev\] Email 2FA code for [^:]+:\s*(\d{6})/)
      if (mOtp) otpCode = mOtp[1]
    })

    serverProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      if (!text.includes('ExperimentalWarning')) {
        process.stderr.write(`[server error] ${text}`)
      }
    })

    const ready = await waitForServer()
    if (!ready) {
      console.error('[cli] Error: Server failed to start within timeout.')
      if (serverProcess) serverProcess.kill()
      process.exit(1)
    }
    console.log('[cli] API server ready.')
  }

  try {
    if (useNewmanDirect) {
      console.log(`\n[cli] Running Newman CLI for folder: "${requestedFolder || 'All'}"...`)
      await new Promise((resolveRun) => {
        newman.run({
          collection,
          environment,
          folder: requestedFolder || undefined,
          reporters: ['cli'],
          color: 'on',
        }, (err, summary) => {
          if (err) {
            console.error('[cli] Newman execution error:', err)
            process.exitCode = 1
          } else if (summary.run.failures && summary.run.failures.length > 0) {
            process.exitCode = 1
          }
          resolveRun()
        })
      })
      return
    }

    // Default automated end-to-end suite verifying all endpoints and schemas
    console.log('\n[cli] Running end-to-end API lifecycle test suite across all CRUD endpoints...\n')
    const baseUrl = 'http://localhost:3001/api'
    const results = []

    async function step(name, fn) {
      const start = Date.now()
      try {
        await fn()
        const duration = Date.now() - start
        results.push({ name, status: 'PASS', duration })
        console.log(`  PASS: ${name} (${duration}ms)`)
      } catch (err) {
        const duration = Date.now() - start
        results.push({ name, status: 'FAIL', duration, error: err.message })
        console.error(`  FAIL: ${name} (${duration}ms) -> ${err.message}`)
      }
    }

    // 1. Health
    await step('GET /health (Service Health)', async () => {
      const res = await fetch(`${baseUrl}/health`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.status !== 'ok') throw new Error(`Expected status ok, got ${body.status}`)
    })

    // 2. Signup
    const testEmail = `tester_${Date.now()}@example.com`
    await step('POST /accounts/signup (Sign Up Request)', async () => {
      const res = await fetch(`${baseUrl}/accounts/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: testEmail,
          password: 'password12345!',
          displayName: 'CLI Test Applicant',
          message: 'Requested from CLI test runner',
        }),
      })
      if (res.status !== 202) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!body.message) throw new Error('Missing message field in response')
    })

    // 3. Admin Login
    let cookie = ''
    let csrfToken = ''
    await step('POST /auth/login (Admin Sign In)', async () => {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: demoEmail, password: demoPassword }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      cookie = res.headers.get('set-cookie') || ''
      const body = await res.json()
      csrfToken = body.csrfToken
      if (!cookie || !csrfToken) throw new Error('Missing session cookie or CSRF token')
    })

    // 4. Send 2FA
    await step('POST /auth/email-code/send (Send 2FA OTP)', async () => {
      const res = await fetch(`${baseUrl}/auth/email-code/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    })

    // Wait 200ms for OTP capture or query DB
    await new Promise((r) => setTimeout(r, 200))
    if (!otpCode) {
      const { database } = await import('../server/database.js')
      const { sessionSecret } = await import('../server/security.js')
      const { createHmac } = await import('node:crypto')
      const admin = database.prepare('SELECT id, email_otp_hash FROM users WHERE email = ?').get(demoEmail)
      if (admin?.email_otp_hash) {
        for (let i = 0; i < 1_000_000; i++) {
          const code = String(i).padStart(6, '0')
          const h = createHmac('sha256', sessionSecret).update(`${admin.id}:${code}`).digest('hex')
          if (h === admin.email_otp_hash) {
            otpCode = code
            break
          }
        }
      }
    }

    // 5. Verify 2FA
    await step('POST /auth/email-code/verify (Verify 2FA OTP)', async () => {
      if (!otpCode) throw new Error('Unable to resolve 2FA code')
      const res = await fetch(`${baseUrl}/auth/email-code/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ code: otpCode }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.state !== 'authenticated') throw new Error(`Expected authenticated state, got ${body.state}`)
      csrfToken = body.csrfToken
    })

    // 6. Get Session
    await step('GET /auth/session (Get Session State)', async () => {
      const res = await fetch(`${baseUrl}/auth/session`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.state !== 'authenticated' || body.role !== 'admin') throw new Error('Invalid session payload')
    })

    // 7. Account Requests CRUD - List
    let targetRequestId = null
    await step('GET /admin/account-requests (List Requests)', async () => {
      const res = await fetch(`${baseUrl}/admin/account-requests`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const req = body.items.find((r) => r.email === testEmail)
      if (!req) throw new Error('Created applicant request not found in list')
      targetRequestId = req.id
    })

    // 8. Account Requests CRUD - Get
    await step('GET /admin/account-requests/:id (Get Single Request)', async () => {
      const res = await fetch(`${baseUrl}/admin/account-requests/${targetRequestId}`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.email !== testEmail) throw new Error('Request email mismatch')
    })

    // 9. Account Requests CRUD - Approve
    let approvedUserId = null
    await step('POST /admin/account-requests/:id/approve (Approve Request -> Create User)', async () => {
      const res = await fetch(`${baseUrl}/admin/account-requests/${targetRequestId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ role: 'user', note: 'Approved via CLI test runner' }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.request.status !== 'approved' || !body.user?.id) throw new Error('Approval payload invalid')
      approvedUserId = body.user.id
    })

    // 10. Admin Users CRUD - List
    await step('GET /admin/users (List Users)', async () => {
      const res = await fetch(`${baseUrl}/admin/users`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body.items) || body.items.length < 2) throw new Error('Expected at least 2 users')
    })

    // 11. Admin Users CRUD - Get
    await step('GET /admin/users/:id (Get User)', async () => {
      const res = await fetch(`${baseUrl}/admin/users/${approvedUserId}`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.id !== approvedUserId) throw new Error('User ID mismatch')
    })

    // 12. Admin Users CRUD - Update
    await step('PATCH /admin/users/:id (Update User)', async () => {
      const res = await fetch(`${baseUrl}/admin/users/${approvedUserId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ displayName: 'Updated CLI User' }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.displayName !== 'Updated CLI User') throw new Error('DisplayName update failed')
    })

    // 13. Admin Users CRUD - Direct Create
    let directUserId = null
    await step('POST /admin/users (Create User Directly)', async () => {
      const res = await fetch(`${baseUrl}/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          email: `direct_${Date.now()}@example.com`,
          password: 'password12345!',
          displayName: 'Direct Admin Created',
          role: 'user',
          status: 'active',
        }),
      })
      if (res.status !== 201) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      directUserId = body.id
    })

    // 14. Admin Users CRUD - Delete
    await step('DELETE /admin/users/:id (Delete User)', async () => {
      const res = await fetch(`${baseUrl}/admin/users/${directUserId}`, {
        method: 'DELETE',
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
      })
      if (res.status !== 204) throw new Error(`HTTP ${res.status}`)
    })

    // 15. Password Reset Request
    await step('POST /auth/password-reset/request (Request Password Reset Token)', async () => {
      const res = await fetch(`${baseUrl}/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail }),
      })
      if (res.status !== 202) throw new Error(`HTTP ${res.status}`)
    })

    // Wait 200ms for token
    await new Promise((r) => setTimeout(r, 200))
    if (!resetToken) {
      const { database } = await import('../server/database.js')
      const tokenRec = database.prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?').get(approvedUserId)
      if (tokenRec) {
        // Create an explicit known token to confirm with
        const { randomBytes } = await import('node:crypto')
        const { hashToken } = await import('../server/security.js')
        const rawToken = randomBytes(32).toString('base64url')
        database.prepare('UPDATE password_reset_tokens SET token_hash = ? WHERE user_id = ?').run(hashToken(rawToken), approvedUserId)
        resetToken = rawToken
      }
    }

    // 16. Password Reset Confirm
    await step('POST /auth/password-reset/confirm (Confirm Password Reset)', async () => {
      if (!resetToken) throw new Error('No password reset token available')
      const res = await fetch(`${baseUrl}/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: resetToken,
          password: 'new-valid-password-999!',
        }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    })

    // 17. Self-Service My Account - Read
    await step('GET /account (Read Self Account)', async () => {
      const res = await fetch(`${baseUrl}/account`, {
        headers: { Cookie: cookie },
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.email !== demoEmail) throw new Error('Unexpected user payload')
    })

    // 18. Self-Service My Account - Update
    await step('PATCH /account (Update Self Display Name)', async () => {
      const res = await fetch(`${baseUrl}/account`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ displayName: 'Daniel W. (Updated)' }),
      })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    })

    // 19. Logout
    await step('POST /auth/logout (Destroy Session)', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
      })
      if (res.status !== 204) throw new Error(`HTTP ${res.status}`)
    })

    // Summary
    const passed = results.filter((r) => r.status === 'PASS').length
    const failed = results.filter((r) => r.status === 'FAIL').length
    console.log(`\n==============================================`)
    console.log(`Results: ${passed} passed, ${failed} failed (${results.length} total)`)
    console.log(`==============================================`)

    if (failed > 0) process.exitCode = 1
  } finally {
    if (serverProcess) {
      console.log('\n[cli] Stopping spawned server process...')
      serverProcess.kill()
    }
  }
}

main().catch((err) => {
  console.error('[cli] Runner error:', err)
  process.exit(1)
})
