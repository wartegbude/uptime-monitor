import { NextResponse, type NextRequest } from 'next/server'

/**
 * Optimistic redirect only: pages without a session cookie go to /login.
 * Real authorization happens in every route handler (requireUser) and in the app layout.
 */
export function proxy(req: NextRequest) {
  if (!req.cookies.has('um_session')) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|login|setup|install\\.sh|_next|favicon|icon|manifest).*)'],
}
