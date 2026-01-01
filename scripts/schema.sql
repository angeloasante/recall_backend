-- =====================================================
-- Movie MVP Database Schema for Supabase
-- Run this in your Supabase SQL Editor
-- =====================================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- =====================================================
-- TABLES
-- =====================================================

-- Movies table (metadata from TMDB)
CREATE TABLE IF NOT EXISTS movies (
  id BIGSERIAL PRIMARY KEY,
  tmdb_id INTEGER UNIQUE NOT NULL,
  imdb_id VARCHAR(20),
  title TEXT NOT NULL,
  year INTEGER,
  poster_url TEXT,
  backdrop_url TEXT,
  overview TEXT,
  popularity DECIMAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_movies_popularity ON movies(popularity DESC);

-- Dialogue/quotes database
CREATE TABLE IF NOT EXISTS movie_dialogues (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  character_name TEXT,
  start_timestamp INTEGER, -- milliseconds
  end_timestamp INTEGER,
  source VARCHAR(50), -- 'imdb_quotes', 'subtitle', 'manual'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search index for dialogue
CREATE INDEX IF NOT EXISTS idx_dialogue_fts ON movie_dialogues USING gin(to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS idx_dialogue_movie ON movie_dialogues(movie_id);

-- Scene descriptions with embeddings
CREATE TABLE IF NOT EXISTS movie_scenes (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  embedding vector(1536), -- OpenAI ada-002 dimensions
  timestamp INTEGER, -- milliseconds from trailer/movie start
  frame_url TEXT, -- R2 URL of the actual frame
  source VARCHAR(50), -- 'trailer', 'clip', 'manual'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity index
CREATE INDEX IF NOT EXISTS idx_scenes_embedding ON movie_scenes 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_scenes_movie ON movie_scenes(movie_id);

-- Movie cast (for actor recognition)
CREATE TABLE IF NOT EXISTS movie_cast (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  actor_name TEXT NOT NULL,
  character_name TEXT,
  tmdb_person_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cast_movie ON movie_cast(movie_id);
CREATE INDEX IF NOT EXISTS idx_cast_actor ON movie_cast(actor_name);

-- User uploads (temporary storage tracking)
CREATE TABLE IF NOT EXISTS user_uploads (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID, -- optional, can be null for anonymous
  video_url TEXT NOT NULL, -- R2 URL
  result_movie_id BIGINT REFERENCES movies(id),
  confidence_score DECIMAL,
  matched_signals JSONB, -- {dialogue: true, visual: false, actor: false}
  processing_time_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON user_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON user_uploads(expires_at);

-- Analytics/popular searches
CREATE TABLE IF NOT EXISTS search_analytics (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) UNIQUE,
  search_count INTEGER DEFAULT 1,
  last_searched TIMESTAMPTZ DEFAULT NOW()
);

-- Failed matches (for manual review/improvement)
CREATE TABLE IF NOT EXISTS failed_matches (
  id BIGSERIAL PRIMARY KEY,
  upload_id BIGINT REFERENCES user_uploads(id),
  video_url TEXT,
  extracted_dialogue TEXT,
  scene_description TEXT,
  user_reported_title TEXT, -- if user manually tells us
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Full-text search for dialogues
CREATE OR REPLACE FUNCTION search_dialogues(
  search_query TEXT,
  match_threshold FLOAT DEFAULT 0.1,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  movie_id BIGINT,
  score FLOAT,
  matched_text TEXT
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    md.movie_id,
    ts_rank(to_tsvector('english', md.text), plainto_tsquery('english', search_query))::FLOAT as score,
    md.text as matched_text
  FROM movie_dialogues md
  WHERE to_tsvector('english', md.text) @@ plainto_tsquery('english', search_query)
    AND ts_rank(to_tsvector('english', md.text), plainto_tsquery('english', search_query)) > match_threshold
  ORDER BY score DESC
  LIMIT match_count;
END;
$$;

-- Vector similarity search for scenes
CREATE OR REPLACE FUNCTION match_scenes(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  movie_id BIGINT,
  score FLOAT,
  description TEXT,
  frame_url TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ms.movie_id,
    (1 - (ms.embedding <=> query_embedding))::FLOAT as score,
    ms.description,
    ms.frame_url
  FROM movie_scenes ms
  WHERE 1 - (ms.embedding <=> query_embedding) > match_threshold
  ORDER BY ms.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Increment search analytics
CREATE OR REPLACE FUNCTION increment_search_count(p_movie_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO search_analytics (movie_id, search_count, last_searched)
  VALUES (p_movie_id, 1, NOW())
  ON CONFLICT (movie_id) 
  DO UPDATE SET 
    search_count = search_analytics.search_count + 1,
    last_searched = NOW();
END;
$$;

-- Clean up expired uploads
CREATE OR REPLACE FUNCTION cleanup_expired_uploads()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM user_uploads
  WHERE expires_at < NOW()
  RETURNING COUNT(*) INTO deleted_count;
  
  RETURN deleted_count;
END;
$$;

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS on tables
ALTER TABLE movies ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_dialogues ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_cast ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE failed_matches ENABLE ROW LEVEL SECURITY;

-- Public read access for movies and related data
CREATE POLICY "Public read access for movies" ON movies FOR SELECT USING (true);
CREATE POLICY "Public read access for dialogues" ON movie_dialogues FOR SELECT USING (true);
CREATE POLICY "Public read access for scenes" ON movie_scenes FOR SELECT USING (true);
CREATE POLICY "Public read access for cast" ON movie_cast FOR SELECT USING (true);

-- Users can only see their own uploads
CREATE POLICY "Users can view own uploads" ON user_uploads FOR SELECT USING (
  user_id IS NULL OR auth.uid() = user_id
);

-- Service role has full access (for backend operations)
CREATE POLICY "Service role full access movies" ON movies FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access dialogues" ON movie_dialogues FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access scenes" ON movie_scenes FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access cast" ON movie_cast FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access uploads" ON user_uploads FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access analytics" ON search_analytics FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access failed" ON failed_matches FOR ALL USING (auth.role() = 'service_role');
