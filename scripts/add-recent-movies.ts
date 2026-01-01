import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

interface TMDBMovie {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  imdb_id?: string;
}

async function fetchTMDBMovies(endpoint: string, pages: number = 5): Promise<TMDBMovie[]> {
  const movies: TMDBMovie[] = [];
  
  for (let page = 1; page <= pages; page++) {
    try {
      const response = await fetch(
        `${TMDB_BASE}${endpoint}?api_key=${TMDB_API_KEY}&page=${page}&language=en-US`
      );
      const data = await response.json();
      
      if (data.results) {
        movies.push(...data.results);
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error);
    }
  }
  
  return movies;
}

async function getMovieDetails(tmdbId: number): Promise<TMDBMovie | null> {
  try {
    const response = await fetch(
      `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`
    );
    return response.json();
  } catch {
    return null;
  }
}

function buildImageUrl(path: string | null, size: string = 'w500'): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

async function addRecentMovies() {
  console.log('🎬 Adding recent popular movies from TMDB...\n');
  
  // Fetch movies from multiple sources
  console.log('📥 Fetching popular movies...');
  const popular = await fetchTMDBMovies('/movie/popular', 10);
  
  console.log('📥 Fetching top rated movies...');
  const topRated = await fetchTMDBMovies('/movie/top_rated', 5);
  
  console.log('📥 Fetching now playing...');
  const nowPlaying = await fetchTMDBMovies('/movie/now_playing', 3);
  
  console.log('📥 Fetching upcoming movies...');
  const upcoming = await fetchTMDBMovies('/movie/upcoming', 3);
  
  // Combine and dedupe
  const allMovies = [...popular, ...topRated, ...nowPlaying, ...upcoming];
  const uniqueMovies = Array.from(
    new Map(allMovies.map(m => [m.id, m])).values()
  );
  
  console.log(`\n📊 Total unique movies to process: ${uniqueMovies.length}\n`);
  
  let added = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const movie of uniqueMovies) {
    const year = movie.release_date ? parseInt(movie.release_date.substring(0, 4)) : null;
    
    // Skip if no year or very old
    if (!year || year < 2015) {
      skipped++;
      continue;
    }
    
    process.stdout.write(`Processing: "${movie.title}" (${year})... `);
    
    // Check if already exists
    const { data: existing } = await supabase
      .from('movies')
      .select('id')
      .eq('tmdb_id', movie.id)
      .single();
    
    if (existing) {
      console.log('⏭️ Already exists');
      skipped++;
      continue;
    }
    
    // Also check by title + year
    const { data: existingByTitle } = await supabase
      .from('movies')
      .select('id')
      .ilike('title', movie.title)
      .eq('year', year)
      .single();
    
    if (existingByTitle) {
      console.log('⏭️ Already exists (by title)');
      skipped++;
      continue;
    }
    
    // Get full details including IMDB ID
    const details = await getMovieDetails(movie.id);
    
    // Insert movie
    const { error: insertError } = await supabase
      .from('movies')
      .insert({
        title: movie.title,
        year: year,
        overview: movie.overview,
        poster_url: buildImageUrl(movie.poster_path),
        backdrop_url: buildImageUrl(movie.backdrop_path, 'w1280'),
        tmdb_id: movie.id,
        imdb_id: details?.imdb_id || null,
        vote_average: movie.vote_average,
      });
    
    if (insertError) {
      console.log(`❌ Error: ${insertError.message}`);
      errors++;
    } else {
      console.log('✅ Added');
      added++;
    }
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  console.log('\n========================================');
  console.log(`✅ Added: ${added} movies`);
  console.log(`⏭️ Skipped: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
  console.log('========================================');
}

addRecentMovies().catch(console.error);
