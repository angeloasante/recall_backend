-- Create artists table for storing actor/cast information
CREATE TABLE IF NOT EXISTS artists (
    id SERIAL PRIMARY KEY,
    tmdb_id INTEGER UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    profile_url TEXT,
    biography TEXT,
    birthday DATE,
    birthplace VARCHAR(255),
    known_for_department VARCHAR(100) DEFAULT 'Acting',
    popularity DECIMAL(10, 4) DEFAULT 0,
    imdb_id VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create movie_cast junction table for movie-artist relationships
CREATE TABLE IF NOT EXISTS movie_cast (
    id SERIAL PRIMARY KEY,
    movie_id INTEGER REFERENCES movies(id) ON DELETE CASCADE,
    artist_id INTEGER REFERENCES artists(id) ON DELETE CASCADE,
    character_name VARCHAR(255),
    cast_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(movie_id, artist_id, character_name)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_artists_tmdb_id ON artists(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
CREATE INDEX IF NOT EXISTS idx_movie_cast_movie_id ON movie_cast(movie_id);
CREATE INDEX IF NOT EXISTS idx_movie_cast_artist_id ON movie_cast(artist_id);

-- Enable Row Level Security (optional, for Supabase)
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE movie_cast ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access
CREATE POLICY "Artists are viewable by everyone" ON artists FOR SELECT USING (true);
CREATE POLICY "Movie cast is viewable by everyone" ON movie_cast FOR SELECT USING (true);

-- Allow insert/update for service role
CREATE POLICY "Service role can insert artists" ON artists FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can update artists" ON artists FOR UPDATE USING (true);
CREATE POLICY "Service role can insert movie_cast" ON movie_cast FOR INSERT WITH CHECK (true);
CREATE POLICY "Service role can update movie_cast" ON movie_cast FOR UPDATE USING (true);
