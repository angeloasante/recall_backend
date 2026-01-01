import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const TMDB_BASE = 'https://api.themoviedb.org/3';

async function fetchTMDBMovies(page: number) {
  const response = await fetch(
    `${TMDB_BASE}/movie/popular?api_key=${TMDB_API_KEY}&page=${page}&language=en-US`
  );
  return response.json();
}

async function populateMovies() {
  console.log('🎬 Fetching 1000 popular movies from TMDB...');
  
  const movies: any[] = [];
  const totalPages = 50; // 20 movies per page = 1000 movies
  
  // Fetch in batches of 10 pages at a time
  for (let batch = 0; batch < 5; batch++) {
    const startPage = batch * 10 + 1;
    const endPage = startPage + 10;
    
    console.log(`Fetching pages ${startPage}-${endPage - 1}...`);
    
    const pagePromises = [];
    for (let page = startPage; page < endPage; page++) {
      pagePromises.push(fetchTMDBMovies(page));
    }
    
    const results = await Promise.all(pagePromises);
    
    for (const result of results) {
      if (result.results) {
        movies.push(...result.results);
      }
    }
    
    // Rate limit: TMDB allows 40 req/sec, so wait 1 sec between batches
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log(`✅ Fetched ${movies.length} movies`);
  
  // Transform and insert
  console.log('💾 Inserting into Supabase...');
  
  const moviesToInsert = movies.map(m => ({
    tmdb_id: m.id,
    title: m.title,
    year: m.release_date ? new Date(m.release_date).getFullYear() : null,
    poster_url: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdrop_url: m.backdrop_path ? `https://image.tmdb.org/t/p/original${m.backdrop_path}` : null,
    overview: m.overview,
    popularity: m.popularity,
  }));
  
  // Insert in batches of 100
  for (let i = 0; i < moviesToInsert.length; i += 100) {
    const batch = moviesToInsert.slice(i, i + 100);
    
    const { error } = await supabase
      .from('movies')
      .upsert(batch, { onConflict: 'tmdb_id' });
    
    if (error) {
      console.error(`❌ Error inserting batch ${i}-${i + 100}:`, error.message);
    } else {
      console.log(`✅ Inserted batch ${i}-${i + 100}`);
    }
  }
  
  console.log('🎉 Done! Movies populated.');
}

populateMovies().catch(console.error);
