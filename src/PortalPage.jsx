import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Clapperboard, Film, KeyRound, Link2, LogOut, ShieldCheck, Upload, X } from 'lucide-react'
import './portal.css'
import './dashboard.css'

const maxFileSize = 500 * 1024 * 1024
const extensions = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const mimeTypes = new Set(['video/mp4', 'application/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm'])

async function api(path, { method = 'GET', data, csrfToken, signal } = {}) {
  const headers = new Headers()
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken)
  if (data && !(data instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: data instanceof FormData ? data : data ? JSON.stringify(data) : undefined,
    signal,
  })
  if (response.status === 204) return null
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.')
  return result
}

const uploadBase = (import.meta.env.VITE_UPLOAD_API_BASE || '').replace(/\/$/, '')

// Uploads go straight to the API origin when configured, avoiding the Netlify proxy's body limit.
async function directUpload(form, csrfToken) {
  if (!uploadBase) return api('/videos', { method: 'POST', data: form, csrfToken })
  const { token } = await api('/videos/upload-token', { method: 'POST', csrfToken })
  const response = await fetch(`${uploadBase}/api/videos/direct`, { method: 'POST', headers: { 'X-Upload-Token': token }, body: form })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'The upload could not be completed.')
  return result
}

// Uploads a file straight from the browser to Cloudinary using a signature from our API.
async function uploadToCloudinary(file, purpose, csrfToken, onProgress) {
  const signed = await api('/media/signature', { method: 'POST', data: { purpose }, csrfToken })
  const form = new FormData()
  form.append('file', file)
  form.append('api_key', signed.apiKey)
  form.append('timestamp', String(signed.timestamp))
  form.append('folder', signed.folder)
  form.append('signature', signed.signature)
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `https://api.cloudinary.com/v1_1/${signed.cloudName}/${signed.resourceType}/upload`)
    request.upload.onprogress = (event) => { if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total) }
    request.onload = () => {
      let body = {}
      try { body = JSON.parse(request.responseText) } catch { body = {} }
      if (request.status >= 200 && request.status < 300) resolve(body)
      else reject(new Error(body.error?.message ? `Cloudinary: ${body.error.message}` : 'The upload to Cloudinary failed.'))
    }
    request.onerror = () => reject(new Error('The upload to Cloudinary failed. Check your connection and try again.'))
    request.send(form)
  })
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function makeThumbnail(file) {
  const source = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = source

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('This video could not be decoded in your browser. Try MP4 or WebM.')), 20000)
    let duration
    const finish = (error, result) => {
      window.clearTimeout(timeout)
      URL.revokeObjectURL(source)
      video.removeAttribute('src')
      video.load()
      if (error) reject(error)
      else resolve(result)
    }
    video.onerror = () => finish(new Error('This video could not be decoded in your browser. Try MP4 or WebM.'))
    video.onloadedmetadata = () => {
      duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0 || video.videoWidth === 0) {
        finish(new Error('This video has no readable duration or image stream.'))
        return
      }
      video.currentTime = Math.min(1, duration * 0.1)
    }
    video.onseeked = () => {
      const scale = Math.min(1, 960 / video.videoWidth)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) return finish(new Error('A preview thumbnail could not be generated.'))
        finish(null, { blob, duration })
      }, 'image/jpeg', 0.84)
    }
    video.load()
  })
}

function formatDuration(seconds) {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

function AuthForm({ busy, error, notice, onForgot, onSubmit }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return <form className="portal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }) }}>
    <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></label>
    <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={256} required /></label>
    {error && <p className="portal-error" role="alert">{error}</p>}
    {notice && <p className="portal-success" role="status">{notice}</p>}
    <button className="portal-button portal-button-orange" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <ArrowUpRight size={16} /></button>
    <p className="portal-switch"><button type="button" onClick={onForgot}>Forgot your password?</button></p>
  </form>
}

function RecoveryForm({ busy, error, notice, onBack, onSubmit }) {
  const [email, setEmail] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [password, setPassword] = useState('')
  return <form className="portal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, recoveryCode, password }) }}>
    <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></label>
    <label>Recovery code<input type="password" autoComplete="off" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} required /><small>Use the recovery code configured by the site owner.</small></label>
    <label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} required /><small>At least 12 characters.</small></label>
    {error && <p className="portal-error" role="alert">{error}</p>}
    {notice && <p className="portal-success" role="status">{notice}</p>}
    <button className="portal-button portal-button-orange" type="submit" disabled={busy}>{busy ? 'Resetting…' : 'Reset password'} <ShieldCheck size={16} /></button>
    <p className="portal-switch"><button type="button" onClick={onBack}>Back to sign in</button></p>
  </form>
}

function CodeForm({ code, setCode, busy, error, onSubmit, label = 'Email verification code' }) {
  return <form className="portal-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
    <label>{label}<input className="totp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" required /></label>
    {error && <p className="portal-error" role="alert">{error}</p>}
    <button className="portal-button portal-button-orange" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify code'} <ShieldCheck size={16} /></button>
  </form>
}

function ProfileEditor({ profile, csrfToken, onSaved, mediaConfig }) {
  const [displayName, setDisplayName] = useState(profile.displayName)
  const [location, setLocation] = useState(profile.location)
  const [bio, setBio] = useState(profile.bio)
  const [tags, setTags] = useState(profile.tags.join(', '))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function saveProfile(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const result = await api('/profile', {
        method: 'PUT',
        csrfToken,
        data: { displayName, location, bio, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) },
      })
      onSaved(result)
      setNotice('Profile saved. Your public About page is updated.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function uploadProfileImage(event) {
    const image = event.target.files?.[0]
    event.target.value = ''
    if (!image) return
    setError('')
    setNotice('')
    if (mediaConfig.storage === 'cloudinary' && image.size > mediaConfig.maxImageBytes) {
      setError(`Profile images must be ${formatMegabytes(mediaConfig.maxImageBytes)} or smaller.`)
      return
    }
    setBusy(true)
    try {
      if (mediaConfig.storage === 'cloudinary') {
        const uploaded = await uploadToCloudinary(image, 'profile', csrfToken)
        onSaved(await api('/profile/image/cloudinary', { method: 'PUT', csrfToken, data: { image: uploaded } }))
      } else {
        const form = new FormData()
        form.append('image', image, image.name)
        onSaved(await api('/profile/image', { method: 'PUT', csrfToken, data: form }))
      }
      setNotice('Profile image saved. Your About page is updated.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="profile-editor"><div className="portal-section-heading"><div><p className="portal-kicker"><span /> YOUR PUBLIC PROFILE</p><h2>Edit About page.</h2></div></div><div className="profile-editor-grid"><div className="profile-avatar-control"><img src={profile.imageUrl} alt="Current public profile" onError={(event) => { event.currentTarget.src = '/ninja.svg' }} /><label className="portal-button portal-button-orange">Change image<input className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadProfileImage} /></label><span>JPEG, PNG, or WebP · 5 MB max</span></div><form className="profile-fields" onSubmit={saveProfile}><label>Display name<input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} required /><small>{displayName.length}/80</small></label><label>Location<input value={location} maxLength={100} onChange={(event) => setLocation(event.target.value)} required /><small>{location.length}/100</small></label><label>Short bio<textarea value={bio} maxLength={600} rows={5} onChange={(event) => setBio(event.target.value)} /><small>{bio.length}/600 characters</small></label><label>Tags, separated by commas<input value={tags} maxLength={230} onChange={(event) => setTags(event.target.value)} placeholder="Filmmaking, Motion design, Editing" /><small>Up to 8 tags, 24 characters each</small></label>{error && <p className="portal-error" role="alert">{error}</p>}{notice && <p className="portal-success" role="status">{notice}</p>}<button className="portal-button portal-button-orange" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save public profile'} <Check size={16} /></button></form></div></section>
}

function PortalPage() {
  const [session, setSession] = useState(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [authView, setAuthView] = useState('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [emailCodeSent, setEmailCodeSent] = useState(false)
  const [videos, setVideos] = useState([])
  const [profile, setProfile] = useState({ displayName: 'Daniel Wilson', location: 'Pittsburgh, PA', bio: '', tags: ['Filmmaking', 'Motion design', 'Editing'], imageUrl: '/ninja.svg' })
  const [thumbnailLibrary, setThumbnailLibrary] = useState([])
  const [selectedThumbnailId, setSelectedThumbnailId] = useState('generated')
  const [file, setFile] = useState(null)
  const [thumbnail, setThumbnail] = useState(null)
  const [thumbnailPreview, setThumbnailPreview] = useState('')
  const [duration, setDuration] = useState(0)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState('')
  const [mediaConfig, setMediaConfig] = useState({ storage: 'local', maxVideoBytes: maxFileSize, maxImageBytes: 8 * 1024 * 1024 })
  const [addMode, setAddMode] = useState('upload')
  const [uploadProgress, setUploadProgress] = useState(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkPreview, setLinkPreview] = useState(null)
  const [linkTitle, setLinkTitle] = useState('')
  const [linkDescription, setLinkDescription] = useState('')
  const [linkThumbnail, setLinkThumbnail] = useState('')
  const previewRef = useRef('')

  async function loadDashboard(signal) {
    const [videoResult, profileResult, thumbnailResult, mediaResult] = await Promise.all([
      api('/videos', { signal }),
      api('/profile', { signal }),
      api('/videos/thumbnails', { signal }),
      api('/media/config', { signal }),
    ])
    setVideos(videoResult.videos)
    setProfile(profileResult)
    setThumbnailLibrary(thumbnailResult.thumbnails)
    setMediaConfig(mediaResult)
  }

  useEffect(() => {
    const controller = new AbortController()
    api('/auth/session', { signal: controller.signal })
      .then(async (current) => {
        if (current.state === 'authenticated') {
          await loadDashboard(controller.signal)
        } else if (['setup_required', 'two_factor_pending'].includes(current.state)) {
          setSession(current)
          await sendEmailCode(current)
        }
        setSession(current)
      })
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setSession(null)
      })
      .finally(() => { if (!controller.signal.aborted) setSessionLoaded(true) })
    return () => controller.abort()
  }, [])

  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current) }, [])

  async function sendEmailCode(currentSession = session) {
    if (!currentSession) return
    setError('')
    setBusy(true)
    try {
      const result = await api('/auth/email-code/send', { method: 'POST', csrfToken: currentSession.csrfToken })
      setEmailCodeSent(true)
      setNotice(result.message)
    } catch (requestError) {
      setEmailCodeSent(false)
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitCredentials(credentials) {
    setError('')
    setBusy(true)
    try {
      const result = await api('/auth/login', { method: 'POST', data: credentials })
      setSession(result)
      setCode('')
      setEmailCodeSent(false)
      if (result.state === 'authenticated') {
        await loadDashboard()
      } else {
        await sendEmailCode(result)
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitRecovery(credentials) {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const result = await api('/auth/forgot-password', { method: 'POST', data: credentials })
      setNotice(result.message)
      setAuthView('login')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode() {
    setError('')
    setBusy(true)
    try {
      const result = await api('/auth/email-code/verify', { method: 'POST', data: { code }, csrfToken: session.csrfToken })
      await loadDashboard()
      setSession(result)
      setEmailCodeSent(false)
      setCode('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    try { await api('/auth/logout', { method: 'POST', csrfToken: session.csrfToken }) } catch { /* The session may already have expired. */ }
    setSession(null)
    setAuthView('login')
    setVideos([])
    setThumbnailLibrary([])
    setEmailCodeSent(false)
    setError('')
  }

  async function chooseFile(nextFile) {
    setError('')
    setNotice('')
    if (!nextFile) return
    const extension = `.${nextFile.name.split('.').pop().toLowerCase()}`
    if (!extensions.has(extension) || !mimeTypes.has(nextFile.type)) {
      setError('Choose an MP4, M4V, MOV, or WebM video file.')
      return
    }
    if (nextFile.size > mediaConfig.maxVideoBytes) {
      setError(`Videos must be ${formatMegabytes(mediaConfig.maxVideoBytes)} or smaller. For longer films, add a YouTube link instead.`)
      return
    }
    setBusy(true)
    try {
      const generated = await makeThumbnail(nextFile)
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = URL.createObjectURL(generated.blob)
      setThumbnailPreview(previewRef.current)
      setThumbnail(generated.blob)
      setSelectedThumbnailId('generated')
      setDuration(generated.duration)
      setTitle(nextFile.name.replace(/\.[^.]+$/, '').slice(0, 140))
      setFile(nextFile)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragging(false)
    void chooseFile(event.dataTransfer.files[0])
  }

  function resetUpload() {
    setFile(null)
    setThumbnail(null)
    setTitle('')
    setDescription('')
    setDuration(0)
    setSelectedThumbnailId('generated')
    setThumbnailPreview('')
    previewRef.current = ''
  }

  async function refreshLibrary() {
    const [videoResult, thumbnailResult] = await Promise.all([api('/videos'), api('/videos/thumbnails')])
    setVideos(videoResult.videos)
    setThumbnailLibrary(thumbnailResult.thumbnails)
  }

  async function chosenThumbnailBlob() {
    if (selectedThumbnailId === 'generated') return thumbnail
    const selected = thumbnailLibrary.find((item) => item.id === selectedThumbnailId)
    if (!selected) throw new Error('Choose a thumbnail again before uploading.')
    const response = await fetch(selected.thumbnailUrl, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('The saved thumbnail could not be loaded.')
    return response.blob()
  }

  async function uploadVideo(event) {
    event.preventDefault()
    if (!file || !thumbnail || !session) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mediaConfig.storage === 'cloudinary') {
        setUploadProgress(0)
        const uploadedVideo = await uploadToCloudinary(file, 'video', session.csrfToken, setUploadProgress)
        const selected = thumbnailLibrary.find((item) => item.id === selectedThumbnailId)
        const data = { title, description, duration, originalName: file.name, video: uploadedVideo }
        if (selected && selected.source !== 'file') data.reuseThumbnailOf = selected.id
        else data.thumbnail = await uploadToCloudinary(await chosenThumbnailBlob(), 'thumbnail', session.csrfToken)
        await api('/videos/cloudinary', { method: 'POST', data, csrfToken: session.csrfToken })
      } else {
        const form = new FormData()
        form.append('title', title)
        form.append('description', description)
        form.append('duration', String(duration))
        form.append('video', file, file.name)
        form.append('thumbnail', await chosenThumbnailBlob(), 'thumbnail.jpg')
        await directUpload(form, session.csrfToken)
      }
      await refreshLibrary()
      setNotice('Video uploaded and added to your library.')
      resetUpload()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
      setUploadProgress(null)
    }
  }

  function clearLink() {
    setLinkUrl('')
    setLinkPreview(null)
    setLinkTitle('')
    setLinkDescription('')
    setLinkThumbnail('')
  }

  async function checkVideoLink(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const preview = await api('/videos/link/preview', { method: 'POST', data: { url: linkUrl }, csrfToken: session.csrfToken })
      setLinkPreview(preview)
      setLinkTitle(preview.title || '')
      setLinkDescription('')
      setLinkThumbnail('')
    } catch (requestError) {
      setLinkPreview(null)
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function addVideoLink(event) {
    event.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await api('/videos/link', { method: 'POST', data: { url: linkUrl, title: linkTitle, description: linkDescription, thumbnailUrl: linkThumbnail }, csrfToken: session.csrfToken })
      await refreshLibrary()
      setNotice(`${linkPreview.providerName} video added to your library.`)
      clearLink()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const selectedThumbnail = selectedThumbnailId === 'generated'
    ? thumbnailPreview
    : thumbnailLibrary.find((item) => item.id === selectedThumbnailId)?.thumbnailUrl || thumbnailPreview

  if (!sessionLoaded) return <main className="portal-page"><p className="portal-loading">Opening creator portal…</p></main>

  return <main className="portal-page">
    <div className="portal-heading"><div><p className="portal-kicker"><span /> CREATOR STUDIO</p><h1>{session?.state === 'authenticated' ? 'Creator dashboard.' : 'Your work, in motion.'}</h1><p>{session?.state === 'authenticated' ? `Signed in as ${session.email}` : 'Sign in to manage your films and motion work.'}</p></div>{session?.state === 'authenticated' && <button className="portal-quiet-button" type="button" onClick={signOut}><LogOut size={16} /> Sign out</button>}</div>

    {!session && <section className="portal-auth"><div className="portal-auth-mark"><KeyRound size={20} /><span>PRIVATE CREATOR ACCESS</span></div><h2>{authView === 'forgot' ? 'Reset your password.' : 'Welcome back.'}</h2><p className="portal-lede">{authView === 'forgot' ? 'Verify with the site recovery code to set a new password.' : 'Sign in with your email and password.'}</p>{authView === 'forgot' ? <RecoveryForm busy={busy} error={error} notice={notice} onBack={() => { setAuthView('login'); setError('') }} onSubmit={submitRecovery} /> : <AuthForm busy={busy} error={error} notice={notice} onForgot={() => { setAuthView('forgot'); setError(''); setNotice('') }} onSubmit={submitCredentials} />}</section>}

    {['setup_required', 'two_factor_pending'].includes(session?.state) && <section className="portal-auth"><div className="portal-auth-mark"><ShieldCheck size={20} /><span>EMAIL SECOND FACTOR</span></div><h2>Check your email.</h2><p className="portal-lede">{session.state === 'setup_required' ? 'Verify the first email code to activate email two-factor sign-in.' : 'Enter the latest six-digit sign-in code sent to the designated 2FA email.'}</p>{notice && <p className="portal-success" role="status">{notice}</p>}<CodeForm code={code} setCode={setCode} busy={busy} error={error} onSubmit={verifyCode} label="Email verification code" /><button className="portal-quiet-button resend-email-code" type="button" disabled={busy} onClick={() => sendEmailCode()}>{busy ? 'Sending…' : emailCodeSent ? 'Resend email code' : 'Send email code'} <ArrowUpRight size={15} /></button></section>}

    {session?.state === 'authenticated' && <div className="portal-library">
      <ProfileEditor profile={profile} csrfToken={session.csrfToken} onSaved={setProfile} mediaConfig={mediaConfig} />
      <section className="upload-section">
        <div className="portal-section-heading"><div><p className="portal-kicker"><span /> ADD TO THE REEL</p><h2>{addMode === 'link' ? 'Add a video link.' : 'Upload a video.'}</h2></div><span className="upload-limit">{addMode === 'link' ? 'YOUTUBE · VIMEO · DAILYMOTION · LOOM · STREAMABLE · ANY LINK' : `MP4 · M4V · MOV · WEBM / UP TO ${formatMegabytes(mediaConfig.maxVideoBytes)}`}</span></div>
        <div className="add-mode-switch" role="tablist" aria-label="How to add a video">
          <button type="button" role="tab" aria-selected={addMode === 'upload'} className={addMode === 'upload' ? 'add-mode is-active' : 'add-mode'} onClick={() => { setAddMode('upload'); setError(''); setNotice('') }}><Upload size={15} /> Upload a file</button>
          <button type="button" role="tab" aria-selected={addMode === 'link'} className={addMode === 'link' ? 'add-mode is-active' : 'add-mode'} onClick={() => { setAddMode('link'); setError(''); setNotice('') }}><Link2 size={15} /> Video link</button>
        </div>
        {addMode === 'link' && <div className="youtube-add">
          <form className="youtube-link-form" onSubmit={checkVideoLink}>
            <label>Video URL<input type="url" inputMode="url" value={linkUrl} onChange={(event) => { setLinkUrl(event.target.value); setLinkPreview(null) }} placeholder="https://vimeo.com/… · https://youtu.be/… · https://example.com/film.mp4" required /><small>YouTube, Vimeo, Dailymotion, Loom, Streamable, a direct .mp4 or .webm file, or any page that hosts your video.</small></label>
            <button className="portal-button portal-button-orange" type="submit" disabled={busy || !linkUrl.trim()}>{busy && !linkPreview ? 'Checking…' : 'Check link'} <ArrowUpRight size={16} /></button>
          </form>
          {linkPreview && <form className="upload-preview youtube-preview" onSubmit={addVideoLink}>
            <img src={linkThumbnail.trim() || linkPreview.thumbnailUrl || '/og.jpg'} alt="Video thumbnail" onError={(event) => { event.currentTarget.src = '/og.jpg' }} />
            <div className="upload-preview-info"><label>Project title<input value={linkTitle} maxLength={140} onChange={(event) => setLinkTitle(event.target.value)} required /></label><small>{linkTitle.length}/140</small><p>{linkPreview.providerName}{linkPreview.author ? ` · ${linkPreview.author}` : ''}{linkPreview.durationSeconds ? ` · ${formatDuration(linkPreview.durationSeconds)}` : ''} · {linkPreview.embedUrl || linkPreview.videoUrl ? 'plays on your site' : 'opens on the original site'}</p></div>
            <button className="portal-button portal-button-orange" type="submit" disabled={busy || !linkTitle.trim()}>{busy ? 'Saving…' : 'Add to library'} <Check size={16} /></button>
            <button className="remove-file" type="button" aria-label="Clear video link" onClick={clearLink}><X size={18} /></button>
            <label className="upload-description">Thumbnail image URL (optional)<input className="link-thumbnail-input" type="url" inputMode="url" value={linkThumbnail} onChange={(event) => setLinkThumbnail(event.target.value)} placeholder={linkPreview.thumbnailUrl ? 'Leave empty to use the thumbnail shown' : 'https://… .jpg or .png'} /><small>{linkPreview.thumbnailUrl ? 'Replaces the thumbnail found for this video.' : 'No thumbnail was found for this link, so a default image is used unless you add one.'}</small></label>
            <label className="upload-description">Description<textarea value={linkDescription} maxLength={1200} rows={4} onChange={(event) => setLinkDescription(event.target.value)} /><small>{linkDescription.length}/1200 characters</small></label>
          </form>}
        </div>}
        {addMode === 'upload' && <>
        <input id="video-upload" className="visually-hidden" type="file" accept=".mp4,.m4v,.mov,.webm,video/mp4,video/x-m4v,video/quicktime,video/webm" onChange={(event) => void chooseFile(event.target.files[0])} />
        <label className={`drop-zone${dragging ? ' is-dragging' : ''}`} htmlFor="video-upload" onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}><span className="drop-icon"><Upload size={20} /></span><strong>Drop a video here, or browse files</strong><span>MP4, M4V, MOV, or WebM. Thumbnail generated from a video frame.</span></label>
        {file && thumbnailPreview && <form className="upload-preview" onSubmit={uploadVideo}>
          <img src={selectedThumbnail} alt="Selected video thumbnail" />
          <div className="upload-preview-info"><label>Project title<input value={title} maxLength={140} onChange={(event) => setTitle(event.target.value)} required /></label><small>{title.length}/140</small><p>{file.name} · {formatDuration(duration)} · {(file.size / (1024 * 1024)).toFixed(1)} MB</p></div>
          <button className="portal-button portal-button-orange" type="submit" disabled={busy || !title.trim()}>{busy ? (uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%` : 'Uploading…') : 'Upload video'} <Upload size={16} /></button>
          <button className="remove-file" type="button" aria-label="Remove selected video" disabled={busy} onClick={resetUpload}><X size={18} /></button>
          <label className="upload-description">Description<textarea value={description} maxLength={1200} rows={4} onChange={(event) => setDescription(event.target.value)} /><small>{description.length}/1200 characters</small></label>
          <div className="thumbnail-library"><span className="thumbnail-library-title">CHOOSE A THUMBNAIL</span><div className="thumbnail-options">
            <button className={selectedThumbnailId === 'generated' ? 'thumbnail-option selected' : 'thumbnail-option'} type="button" aria-pressed={selectedThumbnailId === 'generated'} onClick={() => setSelectedThumbnailId('generated')}><img src={thumbnailPreview} alt="Newly generated frame" /><span>New frame</span></button>
            {thumbnailLibrary.map((item) => <button key={item.id} className={selectedThumbnailId === item.id ? 'thumbnail-option selected' : 'thumbnail-option'} type="button" aria-pressed={selectedThumbnailId === item.id} onClick={() => setSelectedThumbnailId(item.id)}><img src={item.thumbnailUrl} alt={`${item.title} thumbnail`} /><span>{item.title}</span></button>)}
          </div></div>
        </form>}
        </>}
        {error && <p className="portal-error" role="alert">{error}</p>}{notice && <p className="portal-success" role="status"><Check size={16} /> {notice}</p>}
      </section>

      <section className="library-section"><div className="portal-section-heading"><div><p className="portal-kicker"><span /> YOUR UPLOADS</p><h2>In the library <span>{String(videos.length).padStart(2, '0')}</span></h2></div></div>{videos.length === 0 ? <div className="empty-library"><Film size={22} /><p>Your uploaded and linked films will appear here.</p></div> : <div className="uploaded-grid">{videos.map((video) => <article className="uploaded-card" key={video.id}><div className="uploaded-poster"><img src={video.thumbnailUrl} alt={`${video.title} thumbnail`} /><span>{video.source === 'link' ? (video.duration_seconds > 0 ? formatDuration(video.duration_seconds) : video.providerName.toUpperCase()) : formatDuration(video.duration_seconds)}</span></div><h3>{video.title}</h3><p>{video.description}</p><p>{new Date(`${video.created_at.replace(' ', 'T')}Z`).toLocaleDateString()} · {video.source === 'link' ? `${video.providerName} link` : `${(video.size_bytes / (1024 * 1024)).toFixed(1)} MB`}</p>{video.source === 'link'
          ? <a className="uploaded-player uploaded-youtube-link" href={video.watchUrl} target="_blank" rel="noreferrer">Open on {video.providerName} <ArrowUpRight size={13} /></a>
          : <video className="uploaded-player" controls playsInline preload="none" poster={video.thumbnailUrl} src={video.videoUrl} aria-label={`Watch ${video.title}`} />}</article>)}</div>}</section>
    </div>}

    <p className="portal-footnote"><Clapperboard size={14} /> PRIVATE LIBRARY</p>
  </main>
}

export default PortalPage
