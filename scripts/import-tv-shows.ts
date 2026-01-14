/**
 * Import TV Shows to reach 20k+ titles
 * Run with: npx ts-node scripts/import-tv-shows.ts
 */

import 'dotenv/config';

const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TARGET_COUNT = 3000; // Add 3000 TV shows to reach 20k+

let existingTmdbIds: Set<number> = new Set();

async function loadExistingIds() {
  console.log('📊 Loading existing TMDB IDs...');
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
  console.log(`  Found ${existingTmdbIds.size} existing entries\n`);
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

async function insertTVShows(shows: any[]): Promise<number> {
  // Filter to only new shows (use negative tmdb_id to differentiate from movies)
  const newShows = shows.filter(s => s.id && !existingTmdbIds.has(s.id) && !existingTmdbIds.has(-s.id));
  if (newShows.length === 0) return 0;
  
  // Match actual table schema: id, tmdb_id, title, overview, poster_url, backdrop_url, year, popularity, imdb_id
  const records = newShows.map(s => {
    const firstAirDate = s.first_air_date || '';
    const year = firstAirDate ? parseInt(firstAirDate.split('-')[0]) : null;
    
    return {
      tmdb_id: s.id, // Use positive ID, we'll track separately
      title: s.name || s.original_name || 'Unknown',
      overview: s.overview || '',
      poster_url: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
      backdrop_url: s.backdrop_path ? `https://image.tmdb.org/t/p/w1280${s.backdrop_path}` : null,
      year: year,
      popularity: s.popularity || 0,
      imdb_id: null,
    };
  });
  
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
      newShows.forEach(s => existingTmdbIds.add(s.id));
      return newShows.length;
    } else {
      const err = await response.text();
      console.log(`    ❌ Insert error: ${err.slice(0, 100)}`);
    }
    return 0;
  } catch (e) {
    console.log(`    ❌ Network error: ${e}`);
    return 0;
  }
}

async function fetchTVEndpoint(name: string, endpoint: string, maxPages: number): Promise<number> {
  console.log(`\n📺 Fetching: ${name}`);
  let added = 0;
  
  for (let page = 1; page <= maxPages; page++) {
    const shows = await fetchPage(endpoint, page);
    
    if (shows.length === 0) {
      console.log(`  📄 Page ${page}: No more results`);
      break;
    }
    
    const count = await insertTVShows(shows);
    added += count;
    
    if (page % 20 === 0 || shows.length < 20) {
      console.log(`  📄 Page ${page}: +${count} (total: ${added})`);
    }
    
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`  ✅ ${name}: Added ${added} shows`);
  return added;
}

async function main() {
  console.log('📺 TV Shows Import Script');
  console.log('='.repeat(50));
  console.log(`Target: ${TARGET_COUNT} TV shows\n`);
  
  await loadExistingIds();
  
  let totalAdded = 0;
  
  // 1. Popular TV Shows
  totalAdded += await fetchTVEndpoint(
    'Popular TV Shows',
    '/tv/popular?language=en-US',
    200
  );
  console.log(`📊 Running total: ${totalAdded}`);
  
  if (totalAdded >= TARGET_COUNT) {
    console.log('🎯 Target reached!');
  } else {
    // 2. Top Rated TV Shows
    totalAdded += await fetchTVEndpoint(
      'Top Rated TV Shows',
      '/tv/top_rated?language=en-US',
      200
    );
    console.log(`📊 Running total: ${totalAdded}`);
  }
  
  if (totalAdded < TARGET_COUNT) {
    // 3. Discover TV by year (recent years)
    for (const year of [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]) {
      totalAdded += await fetchTVEndpoint(
        `TV Shows from ${year}`,
        `/discover/tv?language=en-US&sort_by=popularity.desc&first_air_date_year=${year}&vote_count.gte=5`,
        50
      );
      console.log(`📊 Running total: ${totalAdded}`);
      
      if (totalAdded >= TARGET_COUNT) {
        console.log('🎯 Target reached!');
        break;
      }
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
  console.log(`✅ Done! Added ${totalAdded} TV shows`);
  console.log(`📊 Total titles in database: ${total}`);
}

main().catch(console.error);
