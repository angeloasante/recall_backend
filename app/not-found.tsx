export default function NotFound() {
  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui' }}>
      <h1>404 - Not Found</h1>
      <p>This is the Movie MVP API server.</p>
      <p>Available endpoints:</p>
      <ul>
        <li><code>POST /api/recognize</code> - Video recognition</li>
        <li><code>GET /api/health</code> - Health check</li>
      </ul>
    </div>
  );
}
