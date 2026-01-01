/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output as standalone for Docker
  output: 'standalone',
  
  // Server Actions are enabled by default in Next.js 14+
  async headers() {
    return [
      {
        // Allow CORS from any origin (needed for mobile apps)
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
