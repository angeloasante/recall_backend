/**
 * Continue import from 2018 and earlier
 * Run with: npx ts-node scripts/continue-import.ts
 */

import 'dotenv/config';

const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TARGET_COUNT = 5000; // Just need ~1500 more to hit 20k

// Years to fetch (continuing from where we left off)
const YEARS = [2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010];

let existingTmdbIds: Set<number> = new Set();

async function loadExistingIds() {
  console.log('📊 Loading existing movie IDs...');
  let allIds: number[] = [];
  let offset = 0;
  const limit = 1000;
  
  while (true) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/movies?select=tmdb_id&offset=${offset}&limit=${limit}`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    
    const data = await response.json();
    if (!data || data.length === 0) break;
    
    allIds.push(...data.map((m: any) => m.tmdb_id));
    offset += limit;
    
    if (data.length < limit) break;
  }
  
  existingTmdbIds = new Set(allIds);
  console.log(`  Found ${existingTmdbIds.size} existing movies\n`);
}

async function fetchPage(endpoint: string, page: number): Promise<any[]> {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${TMDB_BASE}${endpoint}${sep}page=${page}&api_key=${TMDB_API_KEY}`;
  
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const data = await response.json();
    return data.results || [];
  } catch {
    return [];
  }
}

async function insertMovies(movies: any[]): Promise<number> {
  // Filter to only new movies
  const newMovies = movies.filter(m => m.id && !existingTmdbIds.has(m.id));
  if (newMovies.length === 0) return 0;
  
  const records = newMovies.map(m => ({
    tmdb_id: m.id,
    title: m.title || m.name || 'Unknown',
    overview: m.overview || '',
    poster_path: m.poster_path,
    backdrop_path: m.backdrop_path,
    release_date: m.release_date || m.first_air_date || null,
    vote_average: m.vote_average || 0,
    vote_count: m.vote_count || 0,
    popularity: m.popularity || 0,
    original_language: m.original_language || 'en',
    genre_ids: m.genre_ids || [],
  }));
  
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/movies`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(records),
      signal: AbortSignal.timeout(30000),
    });
    
    if (response.ok) {
      // Mark as existing
      newMovies.forEach(m => existingTmdbIds.add(m.id));
      return newMovies.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function fetchYear(year: number): Promise<number> {
  console.log(`\n🎬 Fetching movies from ${year}...`);
  let added = 0;
  const maxPages = 100;
  
  for (let page = 1; page <= maxPages; page++) {
    const movies = await fetchPage(
      `/discover/movie?language=en-US&sort_by=popularity.desc&primary_release_year=${year}&vote_count.gte=5`,
      page
    );
    
    if (movies.length === 0) {
      console.log(`  📄 Page ${page}: No more results`);
      break;
    }
    
    const count = await insertMovies(movies);
    added += count;
    
    if (page % 10 === 0 || movies.length < 20) {
      console.log(`  📄 Page ${page}: +${count} (total: ${added})`);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`  ✅ ${year}: Added ${added} movies`);
  return added;
}

async function main() {
  console.log('🚀 Continue Import Script');
  console.log('=' .repeat(50));
  
  await loadExistingIds();
  
  let totalAdded = 0;
  
  for (const year of YEARS) {
    const added = await fetchYear(year);
    totalAdded += added;
    
    console.log(`📊 Running total: ${totalAdded} new movies`);
    
    if (totalAdded >= TARGET_COUNT) {
      console.log(`\n🎯 Reached target of ${TARGET_COUNT}!`);
      break;
    }
  }
  
  // Final count
  const finalResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/movies?select=id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'count=exact',
        'Range': '0-0',
      },
    }
  );
  const range = finalResponse.headers.get('content-range');
  const total = range?.split('/')[1] || 'unknown';
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! Added ${totalAdded} new movies`);
  console.log(`📊 Total movies in database: ${total}`);
}

main().catch(console.error);
