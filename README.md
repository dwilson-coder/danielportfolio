# Frame by Frame

![Frame by Frame portfolio](https://raw.githubusercontent.com/dwilson-coder/danielportfolio/refs/heads/main/og.jpg)

A dark, responsive film and motion-design portfolio with an authenticated creator portal for managing private video uploads.

## Stack

- React 19 and Vite 8
- Express 5 API with Node.js 24 and built-in SQLite
- SQLite-backed accounts, sessions, TOTP enrollment, and video metadata
- Local disk storage for uploaded videos and generated thumbnails

## Local setup

Use Node.js 24 or newer. Copy `.env.example` to `.env`, set a private `PORTAL_INVITE_CODE`, and install the dependencies:

```sh
npm install
npm run dev
```

The Vite site runs at `http://localhost:5173`; `/api` requests are proxied to the API on port `3001`. Open `/portal` and create the first local account with the invite code. The portal immediately guides that account through authenticator setup. Later accounts require the same invite code. Choose **Creator portal** in the site navigation to return to sign-in.

## Security and storage

- Passwords are hashed with Node scrypt and per-user salts. Login and registration requests are rate-limited.
- Sessions use random, database-backed tokens in `HttpOnly`, `SameSite=Strict` cookies. Upload and account-management requests require a session CSRF token.
- Authenticator secrets are encrypted at rest. Video listing, playback, thumbnails, and uploads require an authenticated session with verified two-factor authentication.
- Set a unique `SESSION_SECRET` with at least 32 characters and a private `PORTAL_INVITE_CODE` before deployment. Production sessions require HTTPS and use `Secure` cookies.
- Uploaded files are limited to 500 MB and accepted only as MP4, M4V, MOV, or WebM after checking their detected file signatures. The thumbnail is generated from a decoded video frame in the browser; the API verifies the uploaded thumbnail format.
- SQLite data and media live under `server/data/` and `server/uploads/` by default. Both are excluded from git. Back up both folders to preserve accounts, metadata, and video files.

The database uses Node's built-in `node:sqlite` module. Node may print an experimental-feature warning for this module.

## Production

1. Configure `.env` with the deployed `VITE_SITE_URL`, social profile URLs, `SESSION_SECRET`, `PORTAL_INVITE_CODE`, and persistent database/upload paths.
2. Build and start the combined Express app behind an HTTPS reverse proxy:

```sh
npm run build
npm start
```

3. Keep `server/data/` and `server/uploads/` on persistent storage. Set `TRUST_PROXY=1` only when the app is behind a trusted reverse proxy.

The default Open Graph and Twitter share image is `https://raw.githubusercontent.com/dwilson-coder/danielportfolio/refs/heads/main/og.jpg`. Update `VITE_SITE_URL` after deployment so canonical and share URLs reference the live site. Replace the example YouTube, LinkedIn, and Instagram values in `.env` with the creator's profiles.

## Commands

- `npm run dev` starts the API and Vite development server together.
- `npm run build` creates the production client and PWA assets.
- `npm run lint` runs Oxlint.
- `npm start` serves the production build and API.

## Ninja illustration credit

The About-page ninja illustration is Twemoji by Twitter, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
