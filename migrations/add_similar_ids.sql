-- Add similar_ids column to cache similar movie IDs for instant retrieval
ALTER TABLE movies ADD COLUMN IF NOT EXISTS similar_ids INTEGER[];

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_movies_similar_ids ON movies USING GIN (similar_ids);
