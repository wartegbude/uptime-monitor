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
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  }
}
