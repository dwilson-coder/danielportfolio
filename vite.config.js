import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['favicon.svg', 'logo.svg'],
    manifest: {
      name: 'Frame by Frame | Daniel Wilson',
      short_name: 'Frame by Frame',
      description: 'Independent film and motion design by Daniel Wilson.',
      theme_color: '#171916',
      background_color: '#171916',
      display: 'standalone',
      start_url: '/',
      icons: [{ src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    },
    workbox: { runtimeCaching: [{
      urlPattern: ({ url }) => url.hostname === 'images.unsplash.com',
      handler: 'CacheFirst',
      options: { cacheName: 'portfolio-images', expiration: { maxEntries: 40, maxAgeSeconds: 2592000 } },
    }] },
  })],
  server: {
    proxy: { '/api': 'http://localhost:3001' },
  },
})
