-- Drop existing table if it exists (clean slate)
DROP TABLE IF EXISTS movie_cast;

-- Create movie_cast junction table
CREATE TABLE movie_cast (
    id SERIAL PRIMARY KEY,
    movie_id INTEGER NOT NULL,
    artist_id INTEGER NOT NULL,
    character_name VARCHAR(255),
    cast_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
