// Minimal page that won't trigger Server Actions issues
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function Home() {
  // Return a simple static page - no React server components
  return (
    <html>
      <body style={{ backgroundColor: '#111827', color: 'white', fontFamily: 'system-ui', padding: '40px' }}>
        <h1>🎬 Reckall API</h1>
        <p style={{ color: '#9ca3af' }}>Movie recognition backend service</p>
        <pre style={{ backgroundColor: '#1f2937', padding: '20px', borderRadius: '8px', marginTop: '20px' }}>
{`GET  /api/health     - Health check
POST /api/recognize-fast  - Video recognition
GET  /api/movies     - List movies
GET  /api/trending   - Trending movies`}
        </pre>
      </body>
    </html>
  );
}
