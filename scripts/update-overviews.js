const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TMDB_API_KEY = process.env.TMDB_API_KEY;

async function updateShortOverviews() {
  // Find movies with short overviews (less than 250 chars) that have tmdb_id
  const { data: movies, error } = await supabase
    .from('movies')
    .select('id, title, tmdb_id, overview')
    .not('tmdb_id', 'is', null)
    .order('id', { ascending: false })
    .limit(100);
  
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  const shortMovies = movies.filter(m => !m.overview || m.overview.length < 250);
  console.log(`Found ${shortMovies.length} movies with short overviews\n`);
  
  let updated = 0;
  
  for (const movie of shortMovies) {
    try {
      // Try movie endpoint first
      let url = `https://api.themoviedb.org/3/movie/${movie.tmdb_id}?api_key=${TMDB_API_KEY}`;
      let response = await fetch(url);
      let data = await response.json();
      
      // If not found as movie, try TV
      if (data.success === false) {
        url = `https://api.themoviedb.org/3/tv/${movie.tmdb_id}?api_key=${TMDB_API_KEY}`;
        response = await fetch(url);
        data = await response.json();
      }
      
      const currentLen = movie.overview ? movie.overview.length : 0;
      const newLen = data.overview ? data.overview.length : 0;
      
      if (data.overview && newLen > currentLen) {
        console.log(`[${movie.id}] ${movie.title}: ${currentLen} -> ${newLen} chars`);
        
        // Update in database
        const { error: updateError } = await supabase
          .from('movies')
          .update({ overview: data.overview })
          .eq('id', movie.id);
        
        if (updateError) {
          console.log(`   Error updating: ${updateError.message}`);
        } else {
          console.log(`   ✓ Updated!`);
          updated++;
        }
      } else {
        console.log(`[${movie.id}] ${movie.title}: No better overview (current: ${currentLen}, TMDB: ${newLen})`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.log(`[${movie.id}] ${movie.title}: Error - ${e.message}`);
    }
  }
  
  console.log(`\nDone! Updated ${updated} movies.`);
}

updateShortOverviews();
