/** @type {import('next').NextConfig} */
const nextConfig = {
  // Increase payload limits for video uploads
  serverRuntimeConfig: {
    bodySizeLimit: '50mb',
  },
  
  async headers() {
    return [
      {
        // Allow CORS from any origin (needed for mobile apps)
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Origin' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
