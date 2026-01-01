# Use Node.js 20 with Debian (has apt for installing FFmpeg)
FROM node:20-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Set placeholder env vars for build time (real values injected at runtime)
ENV SUPABASE_URL=https://placeholder.supabase.co
ENV SUPABASE_ANON_KEY=placeholder
ENV SUPABASE_SERVICE_KEY=placeholder
ENV OPENAI_API_KEY=sk-placeholder
ENV TMDB_API_KEY=placeholder
ENV GEMINI_API_KEY=placeholder

# Build Next.js
RUN npm run build

# Remove dev dependencies after build to reduce image size
RUN npm prune --production

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Start the server
CMD ["npm", "start"]
