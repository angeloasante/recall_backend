/**
 * Add movies to database year by year from TMDB
 * Fetches popular movies released each year and adds them with AI-enhanced overviews
 * 
 * Run with: node scripts/add-movies-by-year.js [startYear] [endYear] [moviesPerYear]
 * Example: node scripts/add-movies-by-year.js 2020 2025 100
 */

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Build TMDB image URL
function buildImageUrl(path, size = 'w500') {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

// Generate enhanced overview using AI
async function generateEnhancedOverview(title, year, existingOverview) {
  if (existingOverview && existingOverview.length >= 400) {
    return existingOverview;
  }

  try {
    const prompt = existingOverview 
      ? `Expand this movie overview into a detailed, engaging description (500-700 characters):

Movie: "${title}" (${year})
Current overview: "${existingOverview}"

Write an expanded overview that is factually accurate, engaging, and without spoilers. Return ONLY the text.`
      : `Write a movie overview (400-500 characters) for "${title}" (${year}). Be factually accurate and engaging. Return ONLY the overview text.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a movie database curator. Write accurate, engaging descriptions.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const enhanced = response.choices[0]?.message?.content?.trim();
    return (enhanced && enhanced.length > 100) ? enhanced : (existingOverview || 'No description available.');
  } catch (error) {
    return existingOverview || 'No description available.';
  }
}

// Fetch movies from TMDB for a specific year
async function fetchMoviesForYear(year, page = 1) {
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&language=en-US&sort_by=popularity.desc&include_adult=false&include_video=false&page=${page}&primary_release_year=${year}&vote_count.gte=50`;
  
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// Get movie details including IMDB ID
async function getMovieDetails(tmdbId) {
  const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  const response = await fetch(url);
  return response.json();
}

// Add a single movie to database
async function addMovieToDatabase(movie, year) {
  // Check if already exists
  const { data: existing } = await supabase
    .from('movies')
    .select('id')
    .eq('tmdb_id', movie.id)
    .single();

  if (existing) {
    return { status: 'exists', title: movie.title };
  }

  // Get full details including IMDB ID
  const details = await getMovieDetails(movie.id);
  
  // Enhance overview if short
  let overview = movie.overview;
  if (!overview || overview.length < 300) {
    overview = await generateEnhancedOverview(movie.title, year, movie.overview);
  }

  // Insert movie
  const { data: newMovie, error } = await supabase
    .from('movies')
    .insert({
      title: movie.title,
      year: year,
      overview: overview,
      poster_url: buildImageUrl(movie.poster_path),
      backdrop_url: buildImageUrl(movie.backdrop_path, 'w1280'),
      tmdb_id: movie.id,
      imdb_id: details.imdb_id || null,
      popularity: movie.popularity || null,
    })
    .select()
    .single();

  if (error) {
    return { status: 'error', title: movie.title, error: error.message };
  }

  return { status: 'added', title: movie.title, id: newMovie.id };
}

// Main function to add movies by year
async function addMoviesByYear(startYear, endYear, moviesPerYear) {
  console.log(`\n🎬 Adding movies from ${startYear} to ${endYear} (${moviesPerYear} per year)\n`);
  
  const stats = {
    total: 0,
    added: 0,
    exists: 0,
    errors: 0,
  };

  for (let year = endYear; year >= startYear; year--) {
    console.log(`\n========== ${year} ==========`);
    
    let addedThisYear = 0;
    let page = 1;
    const maxPages = Math.ceil(moviesPerYear / 20); // TMDB returns 20 per page

    while (addedThisYear < moviesPerYear && page <= maxPages + 5) {
      const data = await fetchMoviesForYear(year, page);
      
      if (!data.results || data.results.length === 0) {
        console.log(`  No more results for ${year}`);
        break;
      }

      for (const movie of data.results) {
        if (addedThisYear >= moviesPerYear) break;
        
        stats.total++;
        const result = await addMovieToDatabase(movie, year);
        
        if (result.status === 'added') {
          console.log(`  ✓ Added: "${result.title}" (ID: ${result.id})`);
          stats.added++;
          addedThisYear++;
        } else if (result.status === 'exists') {
          console.log(`  · Exists: "${result.title}"`);
          stats.exists++;
        } else {
          console.log(`  ✗ Error: "${result.title}" - ${result.error}`);
          stats.errors++;
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 150));
      }

      page++;
      await new Promise(r => setTimeout(r, 300)); // Delay between pages
    }

    console.log(`  📊 ${year}: Added ${addedThisYear} movies`);
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`Total processed: ${stats.total}`);
  console.log(`Added: ${stats.added}`);
  console.log(`Already existed: ${stats.exists}`);
  console.log(`Errors: ${stats.errors}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const startYear = parseInt(args[0]) || 2020;
const endYear = parseInt(args[1]) || 2025;
const moviesPerYear = parseInt(args[2]) || 100;

// Run
addMoviesByYear(startYear, endYear, moviesPerYear);
