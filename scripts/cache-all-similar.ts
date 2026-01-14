/**
 * Script to pre-cache similar movies for all movies in the database
 * Run with: npx ts-node scripts/cache-all-similar.ts
 */

import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

async function getAllMovieIds(): Promise<number[]> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/movies?select=id&similar_ids=is.null&order=id`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch movies: ${response.statusText}`);
  }
  
  const movies = await response.json();
  return movies.map((m: { id: number }) => m.id);
}

async function cacheSimilarForMovie(movieId: number): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/movies/${movieId}/similar`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.log(`  ❌ Movie ${movieId}: ${response.status}`);
      return false;
    }
    
    const data = await response.json();
    if (data.cached) {
      console.log(`  ⚡ Movie ${movieId}: Already cached`);
    } else {
      console.log(`  ✅ Movie ${movieId}: Cached ${data.similar?.length || 0} similar`);
    }
    return true;
  } catch (error) {
    console.log(`  ❌ Movie ${movieId}: ${error}`);
    return false;
  }
}

async function main() {
  console.log('🎬 Caching similar movies for all movies...\n');
  console.log(`Backend URL: ${BACKEND_URL}`);
  
  // Get all movie IDs that don't have similar_ids cached
  const movieIds = await getAllMovieIds();
  console.log(`\n📊 Found ${movieIds.length} movies without cached similar_ids\n`);
  
  if (movieIds.length === 0) {
    console.log('✅ All movies already have similar_ids cached!');
    return;
  }
  
  let success = 0;
  let failed = 0;
  
  // Process in batches to avoid rate limiting
  const BATCH_SIZE = 5;
  const DELAY_BETWEEN_BATCHES = 1000; // 1 second
  
  for (let i = 0; i < movieIds.length; i += BATCH_SIZE) {
    const batch = movieIds.slice(i, i + BATCH_SIZE);
    console.log(`\n📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(movieIds.length / BATCH_SIZE)}`);
    
    // Process batch in parallel
    const results = await Promise.all(batch.map(id => cacheSimilarForMovie(id)));
    
    results.forEach(r => r ? success++ : failed++);
    
    // Progress
    const progress = ((i + batch.length) / movieIds.length * 100).toFixed(1);
    console.log(`📈 Progress: ${progress}% (${success} success, ${failed} failed)`);
    
    // Delay between batches
    if (i + BATCH_SIZE < movieIds.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! Cached: ${success}, Failed: ${failed}`);
}

main().catch(console.error);
