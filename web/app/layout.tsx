import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { Providers } from '@/components/providers'
import type { Lang } from '@/lib/i18n'
import './globals.css'

export const metadata: Metadata = {
  title: 'Uptime Monitor',
  description: 'Internet uptime for every location you watch',
  manifest: '/manifest.webmanifest',
}
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#F2F4F7' }, { media: '(prefers-color-scheme: dark)', color: '#0D1117' }],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const c = (await cookies()).get('um_lang')?.value
  const lang: Lang = c === 'id' ? 'id' : 'en'
  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" />
      </head>
      <body>
        <Providers lang={lang}>{children}</Providers>
      </body>
    </html>
  )
}
