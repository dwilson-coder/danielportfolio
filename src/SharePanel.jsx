import { useMemo, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Share2 } from 'lucide-react'

const platforms = [
  { id: 'instagram', name: 'Instagram', limit: 2200, hashtags: 5, openUrl: 'https://www.instagram.com/', note: 'Instagram has no web share link. Copy the caption, then post from the app with the thumbnail.' },
  { id: 'tiktok', name: 'TikTok', limit: 2200, hashtags: 4, openUrl: 'https://www.tiktok.com/upload', note: 'Copy the caption, then paste it when you upload.' },
  { id: 'youtube', name: 'YouTube', limit: 5000, hashtags: 3, openUrl: 'https://studio.youtube.com/', note: 'Paste into the description. Use the thumbnail as the custom thumbnail.' },
  { id: 'x', name: 'Twitter / X', limit: 280, hashtags: 2, link: true, openUrl: (text, url) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` },
  { id: 'bluesky', name: 'BlueSky', limit: 300, hashtags: 2, link: true, openUrl: (text, url) => `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text} ${url}`)}` },
  { id: 'linkedin', name: 'LinkedIn', limit: 3000, hashtags: 3, link: true, openUrl: (text, url) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(`${text}\n${url}`)}` },
]

const lengths = [
  { id: 'short', label: 'Short', fraction: 0.25 },
  { id: 'medium', label: 'Medium', fraction: 0.6 },
  { id: 'long', label: 'Long', fraction: 1 },
]

function trimToLength(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, Math.max(0, max - 1))
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (sentenceEnd > max * 0.5) return cut.slice(0, sentenceEnd + 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:\s]+$/, '')}…`
}

export function buildCaption({ film, platform, length, url, customLimit }) {
  const description = (film.description || '').replace(/\s+/g, ' ').trim()
  const tags = [film.kind, 'filmmaking', 'shortfilm', 'motiondesign', 'video']
    .map((tag) => `#${tag.replace(/[^a-z0-9]/gi, '').toLowerCase()}`)
    .filter((tag, index, all) => tag.length > 1 && all.indexOf(tag) === index)
    .slice(0, platform.hashtags)
    .join(' ')
  const title = film.title
  const fixed = [title, tags, platform.link ? '' : url].filter(Boolean).join('\n\n').length + 4
  const budget = Math.max(0, (customLimit || platform.limit) - fixed - (platform.id === 'x' ? 24 : 0) - (platform.id === 'bluesky' ? url.length + 1 : 0))
  const wanted = Math.round(description.length * length.fraction)
  const body = trimToLength(description, Math.min(wanted, budget))
  return [title, body, tags, platform.link ? '' : url].filter(Boolean).join('\n\n')
}

export default function SharePanel({ film }) {
  const [open, setOpen] = useState(false)
  const [platformId, setPlatformId] = useState('instagram')
  const [lengthId, setLengthId] = useState('medium')
  const [copied, setCopied] = useState(false)
  const [edited, setEdited] = useState(null)
  const platform = platforms.find((item) => item.id === platformId)
  const length = lengths.find((item) => item.id === lengthId)
  const url = typeof window === 'undefined' ? '' : window.location.href
  const generated = useMemo(() => buildCaption({ film, platform, length, url }), [film, platform, length, url])
  const text = edited ?? generated
  const over = text.length > platform.limit

  function choose(setter, value) {
    setter(value)
    setEdited(null)
    setCopied(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function downloadThumbnail() {
    try {
      const response = await fetch(film.image)
      const blob = await response.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${film.slug}-thumbnail.${blob.type.includes('png') ? 'png' : 'jpg'}`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch {
      window.open(film.image, '_blank', 'noopener')
    }
  }

  const target = typeof platform.openUrl === 'function' ? platform.openUrl(text, url) : platform.openUrl

  return <section className="share-panel">
    <button type="button" className="button button-dark" onClick={() => setOpen(!open)} aria-expanded={open}><Share2 size={15} /> Share</button>
    {open && <div className="share-body">
      <div className="share-platforms" role="group" aria-label="Choose a platform">
        {platforms.map((item) => <button key={item.id} type="button" className={item.id === platformId ? 'active' : ''} aria-pressed={item.id === platformId} onClick={() => choose(setPlatformId, item.id)}>{item.name}</button>)}
      </div>
      <div className="share-lengths" role="group" aria-label="Text length">
        <span>LENGTH</span>
        {lengths.map((item) => <button key={item.id} type="button" className={item.id === lengthId ? 'active' : ''} aria-pressed={item.id === lengthId} onClick={() => choose(setLengthId, item.id)}>{item.label}</button>)}
      </div>
      <label className="visually-hidden" htmlFor="share-text">Share text</label>
      <textarea id="share-text" rows={8} value={text} onChange={(event) => { setEdited(event.target.value); setCopied(false) }} />
      <p className={`share-count${over ? ' over' : ''}`}>{text.length} / {platform.limit} characters{over ? ' — over the limit for ' + platform.name : ''}</p>
      {platform.note && <p className="share-note">{platform.note}</p>}
      <div className="share-thumb">
        {film.image && <img src={film.image} alt={`${film.title} thumbnail`} />}
        {film.image && <button type="button" className="button button-light" onClick={downloadThumbnail}><Download size={15} /> Download thumbnail</button>}
      </div>
      <div className="share-actions">
        <button type="button" className="button button-dark" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy text'}</button>
        <a className="button button-light" href={target} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> Open {platform.name}</a>
      </div>
    </div>}
  </section>
}
