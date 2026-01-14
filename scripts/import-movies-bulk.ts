/**
 * Bulk import movies and TV shows from TMDB
 * Target: 20,000+ titles from 2010 onwards
 * 
 * Run with: npx ts-node scripts/import-movies-bulk.ts
 */

import 'dotenv/config';

const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const MIN_YEAR = 2000; // Movies from 2000 onwards (more inclusive)
const TARGET_COUNT = 20000;

interface TMDBMovie {
  id: number;
  title?: string;
  name?: string;
  overview: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  popularity: number;
  vote_average: number;
  vote_count: number;
  genre_ids: number[];
}

interface DBMovie {
  tmdb_id: number;
  title: string;
  year: number | null;
  overview: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  popularity: number | null;
  imdb_id: string | null;
}

// Track existing TMDB IDs to avoid duplicates
let existingTmdbIds = new Set<number>();

async function getExistingTmdbIds(): Promise<Set<number>> {
  console.log('📊 Fetching existing movie IDs from database...');
  
  const ids = new Set<number>();
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
    
    const movies = await response.json();
    if (!movies || movies.length === 0) break;
    
    movies.forEach((m: { tmdb_id: number }) => {
      if (m.tmdb_id) ids.add(m.tmdb_id);
    });
    
    offset += limit;
    if (movies.length < limit) break;
  }
  
  console.log(`  Found ${ids.size} existing movies\n`);
  return ids;
}

async function fetchTMDBPage(endpoint: string, page: number): Promise<TMDBMovie[]> {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${endpoint}${separator}api_key=${TMDB_API_KEY}&page=${page}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    console.log(`  ⚠️ Failed to fetch ${endpoint} page ${page}: ${response.status}`);
    return [];
  }
  
  const data = await response.json();
  return data.results || [];
}

function convertToDBMovie(movie: TMDBMovie, isTV: boolean = false): DBMovie | null {
  const title = isTV ? movie.name : movie.title;
  const dateStr = isTV ? movie.first_air_date : movie.release_date;
  
  if (!title) return null;
  
  let year: number | null = null;
  if (dateStr) {
    year = parseInt(dateStr.substring(0, 4));
    if (isNaN(year)) year = null;
    // Skip if too old
    if (year && year < MIN_YEAR) return null;
  }
  
  // Skip if already exists
  if (existingTmdbIds.has(movie.id)) return null;
  
  return {
    tmdb_id: movie.id,
    title: title,
    year: year,
    overview: movie.overview || null,
    poster_url: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
    backdrop_url: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
    popularity: movie.popularity || null,
    imdb_id: null, // Can be fetched separately if needed
  };
}

async function insertMovies(movies: DBMovie[]): Promise<number> {
  if (movies.length === 0) return 0;
  
  const response = await fetch(`${SUPABASE_URL}/rest/v1/movies`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(movies),
  });
  
  if (!response.ok) {
    const error = await response.text();
    // Ignore duplicate key errors
    if (!error.includes('duplicate')) {
      console.log(`  ⚠️ Insert error: ${error.substring(0, 100)}`);
    }
    return 0;
  }
  
  // Mark as existing
  movies.forEach(m => existingTmdbIds.add(m.tmdb_id));
  
  return movies.length;
}

async function fetchAndInsertFromEndpoint(
  name: string,
  endpoint: string,
  maxPages: number,
  isTV: boolean = false
): Promise<number> {
  console.log(`\n🎬 Fetching: ${name}`);
  
  let totalInserted = 0;
  let batch: DBMovie[] = [];
  const BATCH_SIZE = 100;
  
  for (let page = 1; page <= maxPages; page++) {
    const movies = await fetchTMDBPage(endpoint, page);
    if (movies.length === 0) break;
    
    for (const movie of movies) {
      const dbMovie = convertToDBMovie(movie, isTV);
      if (dbMovie) {
        batch.push(dbMovie);
        
        if (batch.length >= BATCH_SIZE) {
          const inserted = await insertMovies(batch);
          totalInserted += inserted;
          batch = [];
        }
      }
    }
    
    // Progress every 10 pages
    if (page % 10 === 0) {
      process.stdout.write(`  Page ${page}/${maxPages} (${totalInserted} added)...\r`);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Insert remaining
  if (batch.length > 0) {
    totalInserted += await insertMovies(batch);
  }
  
  console.log(`  ✅ ${name}: Added ${totalInserted} titles`);
  return totalInserted;
}

async function main() {
  console.log('🚀 TMDB Bulk Import Script');
  console.log('='.repeat(50));
  console.log(`Target: ${TARGET_COUNT} new titles (${MIN_YEAR}+)\n`);
  
  if (!TMDB_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing environment variables!');
    process.exit(1);
  }
  
  // Get existing IDs first
  existingTmdbIds = await getExistingTmdbIds();
  
  let totalAdded = 0;
  
  // ========== MOVIES ==========
  
  // 1. Popular Movies (500 pages = ~10,000 movies)
  totalAdded += await fetchAndInsertFromEndpoint(
    'Popular Movies',
    '/movie/popular?language=en-US',
    500
  );
  
  // 2. Top Rated Movies (500 pages)
  totalAdded += await fetchAndInsertFromEndpoint(
    'Top Rated Movies',
    '/movie/top_rated?language=en-US',
    500
  );
  
  // 3. Now Playing / Recent (100 pages)
  totalAdded += await fetchAndInsertFromEndpoint(
    'Now Playing Movies',
    '/movie/now_playing?language=en-US',
    100
  );
  
  // 4. Upcoming Movies (50 pages)
  totalAdded += await fetchAndInsertFromEndpoint(
    'Upcoming Movies',
    '/movie/upcoming?language=en-US',
    50
  );
  
  // 5. Discover Movies by Year (2000-2026) - Main source!
  for (let year = 2026; year >= MIN_YEAR; year--) {
    totalAdded += await fetchAndInsertFromEndpoint(
      `Movies from ${year}`,
      `/discover/movie?language=en-US&sort_by=popularity.desc&primary_release_year=${year}&vote_count.gte=10`,
      100 // 100 pages per year = ~2000 per year
    );
    
    console.log(`   📊 Running total: ${totalAdded} new titles`);
    
    if (totalAdded >= TARGET_COUNT) {
      console.log(`\n🎯 Reached target of ${TARGET_COUNT}!`);
      break;
    }
  }
  
  // 6. Movies by Genre (if still under target)
  const genres = [
    { id: 28, name: 'Action' },
    { id: 12, name: 'Adventure' },
    { id: 16, name: 'Animation' },
    { id: 35, name: 'Comedy' },
    { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' },
    { id: 10751, name: 'Family' },
    { id: 14, name: 'Fantasy' },
    { id: 36, name: 'History' },
    { id: 27, name: 'Horror' },
    { id: 10402, name: 'Music' },
    { id: 9648, name: 'Mystery' },
    { id: 10749, name: 'Romance' },
    { id: 878, name: 'Sci-Fi' },
    { id: 53, name: 'Thriller' },
    { id: 10752, name: 'War' },
    { id: 37, name: 'Western' },
  ];
  
  if (totalAdded < TARGET_COUNT) {
    for (const genre of genres) {
      totalAdded += await fetchAndInsertFromEndpoint(
        `${genre.name} Movies`,
        `/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=${genre.id}&primary_release_date.gte=${MIN_YEAR}-01-01`,
        100
      );
      
      if (totalAdded >= TARGET_COUNT) break;
    }
  }
  
  // ========== TV SHOWS ==========
  
  console.log('\n' + '='.repeat(50));
  console.log('📺 Now fetching TV Shows...\n');
  
  // 7. Popular TV Shows
  totalAdded += await fetchAndInsertFromEndpoint(
    'Popular TV Shows',
    '/tv/popular?language=en-US',
    300,
    true
  );
  
  // 8. Top Rated TV Shows
  totalAdded += await fetchAndInsertFromEndpoint(
    'Top Rated TV Shows',
    '/tv/top_rated?language=en-US',
    200,
    true
  );
  
  // 9. TV Shows On Air
  totalAdded += await fetchAndInsertFromEndpoint(
    'TV Shows On Air',
    '/tv/on_the_air?language=en-US',
    50,
    true
  );
  
  // 10. Discover TV by Year
  for (let year = 2026; year >= 2015; year--) {
    totalAdded += await fetchAndInsertFromEndpoint(
      `TV Shows from ${year}`,
      `/discover/tv?language=en-US&sort_by=popularity.desc&first_air_date_year=${year}`,
      30,
      true
    );
  }
  
  // ========== SUMMARY ==========
  console.log('\n' + '='.repeat(50));
  console.log(`🎉 IMPORT COMPLETE!`);
  console.log(`📊 Total new titles added: ${totalAdded}`);
  console.log(`📊 Total in database: ${existingTmdbIds.size}`);
  console.log('='.repeat(50));
}

main().catch(console.error);
