-- Add streaming_providers field to movies table
-- This caches AI-generated streaming availability data

ALTER TABLE movies ADD COLUMN IF NOT EXISTS streaming_providers JSONB DEFAULT NULL;

-- Example structure:
-- {
--   "providers": [
--     { "name": "Netflix", "type": "subscription", "url": "https://netflix.com/title/..." },
--     { "name": "Amazon Prime Video", "type": "subscription", "url": "https://amazon.com/..." },
--     { "name": "Apple TV", "type": "rent", "price": "$3.99", "url": "https://tv.apple.com/..." }
--   ],
--   "updated_at": "2026-02-06T00:00:00Z",
--   "country": "US"
-- }

-- Add index for faster queries on streaming availability
CREATE INDEX IF NOT EXISTS idx_movies_streaming_providers ON movies USING GIN (streaming_providers);

COMMENT ON COLUMN movies.streaming_providers IS 'Cached streaming availability from AI analysis. Structure: { providers: [{name, type, url, price?}], updated_at, country }';
