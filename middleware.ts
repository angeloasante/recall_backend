import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Middleware to handle non-API requests
 * This prevents Server Actions errors from bots/crawlers hitting the root URL
 */
export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  
  // Allow all /api/* routes to pass through normally
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }
  
  // For non-API routes (root, random paths, etc.), return a simple JSON response
  // This avoids Server Actions/page rendering issues that cause SIGTERM
  return NextResponse.json({
    service: 'Reckall API',
    message: 'Movie recognition backend',
    endpoints: {
      health: 'GET /api/health',
      recognize: 'POST /api/recognize-fast',
      movies: 'GET /api/movies',
      trending: 'GET /api/trending',
    },
    docs: 'Use /api/* endpoints for functionality',
  }, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// Apply middleware to all routes except static files and api
export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
