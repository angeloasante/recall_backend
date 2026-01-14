/**
 * Cache similar movies for ALL movies in database
 * Run with: npx ts-node scripts/cache-similar-bulk.ts
 */

import 'dotenv/config';

const BACKEND_URL = process.env.BACKEND_URL || 'https://reckallbackend-production.up.railway.app';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

async function getUncachedMovieIds(): Promise<number[]> {
  let allIds: number[] = [];
  let offset = 0;
  const limit = 1000;
  
  while (true) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/movies?select=id&similar_ids=is.null&order=id&offset=${offset}&limit=${limit}`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    
    const data = await response.json();
    if (!data || data.length === 0) break;
    
    allIds.push(...data.map((m: { id: number }) => m.id));
    offset += limit;
    
    if (data.length < limit) break;
  }
  
  return allIds;
}

async function cacheSimilarForMovie(movieId: number): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/movies/${movieId}/similar`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.similar?.length > 0 || data.cached;
  } catch {
    return false;
  }
}

async function main() {
  console.log('🎬 Bulk Similar Movies Caching');
  console.log('=' .repeat(50));
  console.log(`Backend: ${BACKEND_URL}\n`);
  
  const movieIds = await getUncachedMovieIds();
  console.log(`📊 Found ${movieIds.length} movies without cached similar_ids\n`);
  
  if (movieIds.length === 0) {
    console.log('✅ All movies already have similar_ids cached!');
    return;
  }
  
  let success = 0;
  let failed = 0;
  const BATCH_SIZE = 10;
  const DELAY_MS = 500;
  
  for (let i = 0; i < movieIds.length; i += BATCH_SIZE) {
    const batch = movieIds.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.all(batch.map(id => cacheSimilarForMovie(id)));
    results.forEach(r => r ? success++ : failed++);
    
    const progress = ((i + batch.length) / movieIds.length * 100).toFixed(1);
    console.log(`📈 ${progress}% | Cached: ${success} | Failed: ${failed}`);
    
    if (i + BATCH_SIZE < movieIds.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! Cached: ${success}, Failed: ${failed}`);
}

main().catch(console.error);
