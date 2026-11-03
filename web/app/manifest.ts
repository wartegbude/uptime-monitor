import type { MetadataRoute } from 'next'

/** Lets the dashboard be added to the phone home screen (PRD P2: PWA). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Uptime Monitor',
    short_name: 'Uptime',
    start_url: '/',
    display: 'standalone',
    background_color: '#0D1117',
    theme_color: '#0D1117',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
