import { useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Camera, CirclePlay, Clapperboard, Code2, Menu, Play, X } from 'lucide-react'
import PortalPage from './PortalPage.jsx'
import SharePanel from './SharePanel.jsx'
import './portfolio.css'

const creatorName = import.meta.env.VITE_CREATOR_NAME || 'Daniel Wilson'
const contactEmail = import.meta.env.VITE_CONTACT_EMAIL || 'basherdan21@gmail.com'

function projectFromUpload(video) {
  const uploadedDate = new Date(`${video.uploadedAt.replace(' ', 'T')}Z`)
  const seconds = Math.round(video.durationSeconds)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  const runtime = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`
  return { ...video, slug: `uploaded-${video.id}`, kind: 'Uploaded film', date: uploadedDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }), runtime, image: video.thumbnailUrl, video: video.videoUrl }
}

const films = [
  { slug: 'the-long-way-home', title: 'The Long Way Home', kind: 'Short film', date: 'Oct 18, 2025', runtime: '0:52', image: 'https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=1400&q=85', video: 'https://media.w3.org/2010/05/sintel/trailer_hd.mp4', description: 'A quiet study of the roads we take to find our way back. Shot at the edge of a long summer, cut for the hush in between.' },
  { slug: 'soft-machines', title: 'Soft Machines', kind: 'Motion design', date: 'Aug 02, 2025', runtime: '0:33', image: 'https://images.unsplash.com/photo-1535223289827-42f1e9919769?auto=format&fit=crop&w=1400&q=85', video: 'https://media.w3.org/2010/05/bunny/trailer.mp4', description: 'Color, code, and unexpected little moments of movement. An experimental motion piece built around the beauty of everyday objects.' },
  { slug: 'blue-hour-club', title: 'Blue Hour Club', kind: 'Music video', date: 'Jun 14, 2025', runtime: '0:05', image: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1400&q=85', video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', description: 'An after-hours portrait of a city in full color, made with friends, found light, and one very patient fog machine.' },
  { slug: 'somewhere-in-between', title: 'Somewhere in Between', kind: 'Brand film', date: 'Apr 26, 2025', runtime: '0:52', image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1400&q=85', video: 'https://media.w3.org/2010/05/sintel/trailer_hd.mp4', description: 'An invitation to take the slower route. A warm, open-road portrait for a brand that believes the detour is the destination.' },
  { slug: 'night-swim', title: 'Night Swim', kind: 'Title sequence', date: 'Feb 09, 2025', runtime: '0:33', image: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=1400&q=85', video: 'https://media.w3.org/2010/05/bunny/trailer.mp4', description: 'A title sequence that drifts between tension and stillness, using layered type and light as its own kind of current.' },
  { slug: 'good-things-grow', title: 'Good Things Grow', kind: 'Documentary', date: 'Dec 11, 2024', runtime: '0:05', image: 'https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?auto=format&fit=crop&w=1400&q=85', video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', description: 'A short documentary about a neighborhood garden, the people who tend it, and what happens when you leave room for things to grow.' },
]

const slides = [
  { title: <>MAKE A<br />LITTLE <span>NOISE.</span></>, note: 'Stories look better in motion.', film: films[0] },
  { title: <>FIND YOUR<br /><span>OWN</span> FRAME.</>, note: 'A different point of view, every time.', film: films[1] },
  { title: <>GOOD THINGS<br />TAKE <span>SHAPE.</span></>, note: 'Made with feeling. Finished with care.', film: films[2] },
]

function Eyebrow({ children, dark = false }) {
  return <p className={`eyebrow${dark ? ' eyebrow-dark' : ''}`}><span className="eyebrow-dot" />{children}</p>
}

function Brand({ footer = false }) {
  return <Link className={`brand${footer ? ' footer-brand' : ''}`} to="/" aria-label="Frame by Frame home"><img src="/logo.svg" alt="" /><span>FRAME<br /><b>BY FRAME</b></span></Link>
}

function Header() {
  const [open, setOpen] = useState(false)
  return <header className="site-header"><div className="header-inner"><Brand /><button className="menu-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open}>{open ? <X /> : <Menu />}</button><nav className={open ? 'main-nav is-open' : 'main-nav'} aria-label="Main navigation" onClick={() => setOpen(false)}><NavLink to="/" end>Selected work</NavLink><NavLink to="/about">About</NavLink><NavLink to="/admin">Admin dashboard</NavLink><a className="nav-contact" href={`mailto:${contactEmail}`}>Let&apos;s talk <ArrowUpRight size={15} /></a></nav></div></header>
}

function Footer() {
  return <footer className="site-footer"><div className="footer-top"><Brand footer /><p>Independent filmmaker &amp; motion designer.<br />Making the ordinary feel a little less ordinary.</p><div className="footer-links"><nav className="footer-nav" aria-label="Footer navigation"><Link to="/">Work</Link><Link to="/about">About</Link><Link to="/admin">Admin</Link><a href={`mailto:${contactEmail}`}>Contact</a></nav><div className="social-links" aria-label="Social links">{import.meta.env.VITE_SOCIAL_INSTAGRAM_URL && <a href={import.meta.env.VITE_SOCIAL_INSTAGRAM_URL} target="_blank" rel="noreferrer" aria-label="Instagram"><Camera /></a>}{import.meta.env.VITE_SOCIAL_YOUTUBE_URL && <a href={import.meta.env.VITE_SOCIAL_YOUTUBE_URL} target="_blank" rel="noreferrer" aria-label="YouTube"><CirclePlay /></a>}{import.meta.env.VITE_SOCIAL_GITHUB_URL && <a href={import.meta.env.VITE_SOCIAL_GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub"><Code2 /></a>}{import.meta.env.VITE_SOCIAL_LINKEDIN_URL && <a href={import.meta.env.VITE_SOCIAL_LINKEDIN_URL} target="_blank" rel="noreferrer" aria-label="LinkedIn"><ArrowUpRight /></a>}</div></div></div><div className="footer-bottom"><span>© 2025 FRAME BY FRAME STUDIO</span><a href="#top">BACK TO TOP ↑</a></div></footer>
}

function Hero() {
  const [index, setIndex] = useState(0)
  const slide = slides[index]
  useEffect(() => { const timer = window.setInterval(() => setIndex((current) => (current + 1) % slides.length), 8000); return () => window.clearInterval(timer) }, [])
  return <section className="hero" id="top" aria-label="Featured work"><video key={index} className="hero-video" src={slide.film.video} poster={slide.film.image} autoPlay muted loop playsInline aria-hidden="true" /><div className="hero-scrim" /><div className="hero-inner"><div className="hero-copy" key={`copy-${index}`}><Eyebrow>INDEPENDENT FILMMAKER &amp; MOTION DESIGNER</Eyebrow><h1 className="hero-title">{slide.title}</h1><p className="hero-note">{slide.note}</p><div className="hero-actions"><Link className="button button-lime" to={`/film/${slide.film.slug}`}>Watch the film <ArrowUpRight size={17} /></Link><a className="text-link" href="#work">Explore the work <ArrowDown size={15} /></a></div></div><div className="hero-controls"><div className="slide-count"><span>0{index + 1}</span><i />0{slides.length}</div><button className="hero-next" onClick={() => setIndex((index + 1) % slides.length)} aria-label="Show next featured film"><ArrowRight /></button></div></div><div className="hero-caption"><span>FILM / MOTION / EVERYTHING IN BETWEEN</span><span>PORTLAND, OR · AVAILABLE WORLDWIDE</span></div></section>
}

function FilmCard({ film, index }) {
  return <Link className="film-card" to={`/film/${film.slug}`} style={{ '--card-index': index }}><div className="film-image-wrap"><img className="film-image" src={film.image} alt={`${film.title} still`} loading="lazy" /><span className="play-button" aria-hidden="true"><Play size={16} fill="currentColor" /></span><span className="film-runtime">{film.runtime}</span></div><div className="film-card-meta"><span>{film.kind}</span><span>{film.date}</span></div><h3>{film.title}<ArrowUpRight size={17} /></h3></Link>
}

function Gallery() {
  const [filter, setFilter] = useState('All work')
  const [uploadedFilms, setUploadedFilms] = useState([])
  const filters = ['All work', 'Film', 'Motion design']
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/portfolio-videos', { signal: controller.signal })
      .then((response) => response.json())
      .then(({ videos }) => setUploadedFilms(videos.map(projectFromUpload)))
      .catch((error) => { if (error.name !== 'AbortError') setUploadedFilms([]) })
    return () => controller.abort()
  }, [])
  const projects = [...uploadedFilms, ...films]
  const visible = filter === 'All work' ? projects : projects.filter((film) => film.kind.toLowerCase().includes(filter.toLowerCase()))
  return <section className="work-section" id="work"><div className="section-heading"><div><Eyebrow dark>A FEW RECENT FAVORITES</Eyebrow><h2>Made to <span>move.</span></h2></div><p className="section-aside">Good stories stay with you.<br />Here are a few of mine.</p></div><div className="gallery-toolbar"><span>{String(visible.length).padStart(2, '0')} PROJECTS</span><div className="filter-list" aria-label="Filter projects">{filters.map((item) => <button key={item} className={filter === item ? 'filter-button is-active' : 'filter-button'} onClick={() => setFilter(item)}>{item}</button>)}</div></div><div className="film-grid">{visible.map((film, index) => <FilmCard key={film.slug} film={film} index={index} />)}</div><div className="work-endnote"><span>THAT&apos;S THE SHORT LIST.</span><Link to="/about">A little about me <ArrowRight size={15} /></Link></div></section>
}

function Home() {
  return <><Hero /><Gallery /><section className="contact-strip"><Eyebrow>HAVE A GOOD ONE IN MIND?</Eyebrow><Link to="/about">Let&apos;s make it happen <ArrowUpRight /></Link></section></>
}

function FilmDetail() {
  const { slug } = useParams()
  const staticFilm = films.find((item) => item.slug === slug)
  const [remoteFilm, setRemoteFilm] = useState(null)
  useEffect(() => {
    if (!slug.startsWith('uploaded-')) return undefined
    const controller = new AbortController()
    fetch(`/api/portfolio-videos/${slug.slice('uploaded-'.length)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Video not found.')))
      .then(({ video }) => setRemoteFilm({ slug, film: projectFromUpload(video) }))
      .catch((error) => { if (error.name !== 'AbortError') setRemoteFilm({ slug, film: null }) })
    return () => controller.abort()
  }, [slug])
  const film = staticFilm || (remoteFilm?.slug === slug ? remoteFilm.film : null)
  if (!film && slug.startsWith('uploaded-') && remoteFilm?.slug !== slug) return <main className="not-found"><p>Opening film…</p></main>
  if (!film) return <main className="not-found"><Eyebrow dark>THAT&apos;S A WRAP</Eyebrow><h1>Film not found.</h1><Link className="button button-dark" to="/">Back to the work <ArrowRight /></Link></main>
  return <main className="detail-page"><div className="detail-topline"><Link to="/" className="back-link"><ArrowLeft size={16} /> All work</Link><span>PROJECT / {film.kind.toUpperCase()}</span></div><div className="player-frame"><video controls playsInline preload="metadata" poster={film.image} src={film.video} /><span className="player-label"><Clapperboard size={14} /> {`${creatorName.toUpperCase()} ORIGINAL`}</span></div><section className="detail-content"><div className="detail-heading"><div><Eyebrow dark>{film.kind.toUpperCase()}</Eyebrow><h1>{film.title}</h1></div><p className="detail-description">{film.description}</p></div><div className="detail-facts"><div><span>UPLOADED</span><strong>{film.date}</strong></div><div><span>RUNTIME</span><strong>{film.runtime}</strong></div><div><span>UPLOADED BY</span><strong>{creatorName}</strong></div><div><span>ROLE</span><strong>Director &amp; editor</strong></div></div><SharePanel film={film} /><section className="comments-panel" aria-labelledby="comments-title"><div><Eyebrow dark>THE CONVERSATION</Eyebrow><h2 id="comments-title">Leave a little note.</h2><p>Comments aren&apos;t switched on for this preview.</p></div><form onSubmit={(event) => event.preventDefault()}><label className="visually-hidden" htmlFor="comment">Write a comment</label><textarea id="comment" placeholder="Your thoughts go here..." disabled /><button type="submit" className="button button-dark" disabled>Post a comment <ArrowUpRight size={15} /></button></form></section></section></main>
}

function About() {
  const [profile, setProfile] = useState({ displayName: creatorName, location: import.meta.env.VITE_CREATOR_LOCATION || 'Pittsburgh, PA', bio: 'Independent filmmaker and motion designer, drawn to small details and big feelings.', tags: ['Filmmaking', 'Motion design', 'Editing'], imageUrl: '/ninja.svg' })
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/public/profile', { signal: controller.signal }).then((response) => response.json()).then(setProfile).catch((error) => { if (error.name !== 'AbortError') return })
    return () => controller.abort()
  }, [])
  return <main className="about-page"><div className="about-topline"><Eyebrow dark>A PERSON BEHIND THE PICTURES</Eyebrow><span>BASED IN {profile.location.toUpperCase()}</span></div><section className="about-intro"><div className="about-copy"><h1>Hey, I&apos;m<br /><span>{profile.displayName}.</span><br />I make things<br />that make you feel.</h1><p>{profile.bio}</p><a className="button button-dark" href={`mailto:${contactEmail}`}>Have a project in mind? <ArrowUpRight size={16} /></a></div><div className="portrait-frame"><div className="portrait"><img src={profile.imageUrl} alt={`Portrait of ${profile.displayName}`} onError={(event) => { event.currentTarget.src = '/ninja.svg' }} /></div><span className="portrait-stamp">DIRECTOR<br />&amp; DESIGNER</span></div></section><section className="about-details"><div><Eyebrow dark>THE SHORT VERSION</Eyebrow><h2>Curious by nature.<br />Careful by craft.</h2></div><div className="about-story"><p>I like a film that leaves a little room for you to bring your own story. Whether I&apos;m shaping a brand world, cutting a short, or making type dance, I start with the same question: what should this feel like?</p><p>The answer usually arrives somewhere along the way, in a happy accident, a quiet observation, or a very late export.</p><div className="about-tags">{profile.tags.map((tag) => <span key={tag}>{tag.toUpperCase()}</span>)}</div></div></section><section className="about-contact"><span>HAVE SOMETHING IN MIND?</span><a href={`mailto:${contactEmail}`}>Let&apos;s make a little noise. <ArrowUpRight size={20} /></a></section></main>
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }) }, [pathname])
  return null
}

export default function App() {
  return <BrowserRouter><ScrollToTop /><Header /><Routes><Route path="/" element={<Home />} /><Route path="/film/:slug" element={<FilmDetail />} /><Route path="/about" element={<About />} /><Route path="/admin" element={<PortalPage />} /><Route path="/portal" element={<PortalPage />} /></Routes><Footer /></BrowserRouter>
}