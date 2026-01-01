-- Step 1: Create artists table first
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
