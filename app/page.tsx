export default function Home() {
  return (
    <main className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">🎬 Movie MVP API</h1>
        <p className="text-gray-400 mb-8">Movie recognition backend service</p>
        <div className="space-y-2 text-left bg-gray-800 p-6 rounded-lg">
          <p className="text-sm"><span className="text-green-400">POST</span> /api/recognize - Upload video for recognition</p>
          <p className="text-sm"><span className="text-blue-400">GET</span> /api/movies - List all movies</p>
          <p className="text-sm"><span className="text-blue-400">GET</span> /api/movies/:id - Get movie details</p>
          <p className="text-sm"><span className="text-blue-400">GET</span> /api/health - Health check</p>
        </div>
      </div>
    </main>
  );
}
