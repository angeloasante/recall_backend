// Minimal 404 page - avoid Server Actions issues
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function NotFound() {
  return (
    <html>
      <body style={{ backgroundColor: '#111827', color: 'white', fontFamily: 'system-ui', padding: '40px' }}>
        <h1>404 - Not Found</h1>
        <p>Reckall API - use /api/* endpoints</p>
      </body>
    </html>
  );
}
