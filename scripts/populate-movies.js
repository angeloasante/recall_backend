/**
 * Populate database with popular recent movies and their subtitles
 * Run with: node scripts/populate-movies.js
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;

// Popular movies to add (mix of genres, recent years)
const MOVIES_TO_ADD = [
  // 2024 Movies
  { title: 'Deadpool & Wolverine', year: 2024 },
  { title: 'Inside Out 2', year: 2024 },
  { title: 'Dune: Part Two', year: 2024 },
  { title: 'Bad Boys: Ride or Die', year: 2024 },
  { title: 'The Fall Guy', year: 2024 },
  { title: 'Furiosa', year: 2024 },
  { title: 'Kingdom of the Planet of the Apes', year: 2024 },
  { title: 'Godzilla x Kong', year: 2024 },
  { title: 'Challengers', year: 2024 },
  { title: 'Civil War', year: 2024 },
  
  // 2023 Movies
  { title: 'Oppenheimer', year: 2023 },
  { title: 'Barbie', year: 2023 },
  { title: 'John Wick: Chapter 4', year: 2023 },
  { title: 'Guardians of the Galaxy Vol. 3', year: 2023 },
  { title: 'Spider-Man: Across the Spider-Verse', year: 2023 },
  { title: 'The Super Mario Bros. Movie', year: 2023 },
  { title: 'Mission: Impossible - Dead Reckoning', year: 2023 },
  { title: 'Fast X', year: 2023 },
  { title: 'Killers of the Flower Moon', year: 2023 },
  { title: 'Anyone But You', year: 2023 },
  
  // 2022 Movies
  { title: 'Top Gun: Maverick', year: 2022 },
  { title: 'Avatar: The Way of Water', year: 2022 },
  { title: 'Black Panther: Wakanda Forever', year: 2022 },
  { title: 'The Batman', year: 2022 },
  { title: 'Everything Everywhere All at Once', year: 2022 },
  { title: 'Nope', year: 2022 },
  { title: 'Glass Onion', year: 2022 },
  { title: 'Me Time', year: 2022 },
  
  // Kevin Hart movies
  { title: 'Lift', year: 2024 },
  { title: 'Die Hart', year: 2023 },
  { title: 'Jumanji: The Next Level', year: 2019 },
  { title: 'The Upside', year: 2019 },
  { title: 'Central Intelligence', year: 2016 },
  { title: 'Ride Along', year: 2014 },
  
  // Legal/Drama movies (like River Runs Red)
  { title: 'River Runs Red', year: 2018 },
  { title: 'Just Mercy', year: 2019 },
  { title: 'The Hate U Give', year: 2018 },
  { title: 'Marshall', year: 2017 },
  { title: '12 Years a Slave', year: 2013 },
  
  // Popular Netflix movies
  { title: 'Glass Onion', year: 2022 },
  { title: 'Don\'t Look Up', year: 2021 },
  { title: 'Red Notice', year: 2021 },
  { title: 'The Adam Project', year: 2022 },
  { title: 'Extraction 2', year: 2023 },
  { title: 'Murder Mystery 2', year: 2023 },
];

async function searchTMDB(title, year) {
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query: title,
    year: String(year),
  });
  
  const response = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
  const data = await response.json();
  
  if (!data.results || data.results.length === 0) return null;
  
  // Get full details including IMDB ID
  const movieId = data.results[0].id;
  const detailsResponse = await fetch(
    `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
  );
  const details = await detailsResponse.json();
  
  return {
    tmdb_id: details.id,
    imdb_id: details.imdb_id || details.external_ids?.imdb_id,
    title: details.title,
    year: parseInt(details.release_date?.substring(0, 4)),
    overview: details.overview,
    poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
    backdrop_url: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
    popularity: details.popularity,
  };
}

async function searchSubtitlesByImdbId(imdbId) {
  if (!OPENSUBTITLES_API_KEY || !imdbId) return null;
  
  const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
  url.searchParams.append('imdb_id', imdbId.replace('tt', ''));
  url.searchParams.append('languages', 'en');
  
  const response = await fetch(url.toString(), {
    headers: {
      'Api-Key': OPENSUBTITLES_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'MovieMVP/1.0',
    },
  });
  
  if (!response.ok) return null;
  const data = await response.json();
  return data.data || null;
}

async function downloadSubtitle(fileId) {
  if (!OPENSUBTITLES_API_KEY) return null;
  
  const response = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: {
      'Api-Key': OPENSUBTITLES_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'MovieMVP/1.0',
    },
    body: JSON.stringify({ file_id: fileId }),
  });
  
  if (!response.ok) return null;
  const data = await response.json();
  
  if (!data.link) return null;
  
  const subResponse = await fetch(data.link);
  if (!subResponse.ok) return null;
  
  return await subResponse.text();
}

function parseSubtitles(content) {
  const lines = [];
  const blocks = content.split(/\n\n+/);
  
  for (const block of blocks) {
    const blockLines = block.trim().split('\n');
    if (blockLines.length < 3) continue;
    
    const timestampLine = blockLines.find(l => l.includes('-->'));
    if (!timestampLine) continue;
    
    const [start, end] = timestampLine.split('-->').map(t => t.trim());
    const timestampIndex = blockLines.indexOf(timestampLine);
    const textLines = blockLines.slice(timestampIndex + 1);
    const text = textLines
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
    
    if (text && text.length > 10 && text.length < 300) {
      lines.push({ text, start, end });
    }
  }
  
  return lines;
}

async function addMovieWithSubtitles(movieInfo) {
  const { title, year } = movieInfo;
  console.log(`\n📽️ Processing: "${title}" (${year})`);
  
  // Check if already in DB
  const { data: existing } = await supabase
    .from('movies')
    .select('id, title')
    .ilike('title', title)
    .eq('year', year)
    .single();
  
  if (existing) {
    console.log(`  ⏭️ Already in database (ID: ${existing.id})`);
    
    // Check if it has dialogues
    const { data: dialogues } = await supabase
      .from('movie_dialogues')
      .select('id')
      .eq('movie_id', existing.id)
      .limit(1);
    
    if (dialogues && dialogues.length > 0) {
      console.log(`  ✓ Already has dialogues`);
      return { status: 'exists', movie: existing };
    }
    
    // Add dialogues to existing movie
    return await addDialoguesToMovie(existing);
  }
  
  // Search TMDB
  const tmdbData = await searchTMDB(title, year);
  if (!tmdbData) {
    console.log(`  ❌ Not found on TMDB`);
    return { status: 'not_found' };
  }
  
  console.log(`  ✓ Found on TMDB: ${tmdbData.title} (IMDB: ${tmdbData.imdb_id || 'none'})`);
  
  // Check if tmdb_id already exists
  const { data: existingByTmdb } = await supabase
    .from('movies')
    .select('id')
    .eq('tmdb_id', tmdbData.tmdb_id)
    .single();
  
  if (existingByTmdb) {
    console.log(`  ⏭️ Already in database by tmdb_id`);
    return { status: 'exists' };
  }
  
  // Insert movie
  const { data: movie, error } = await supabase
    .from('movies')
    .insert({
      title: tmdbData.title,
      year: tmdbData.year,
      tmdb_id: tmdbData.tmdb_id,
      imdb_id: tmdbData.imdb_id,
      overview: tmdbData.overview,
      poster_url: tmdbData.poster_url,
      backdrop_url: tmdbData.backdrop_url,
      popularity: tmdbData.popularity,
    })
    .select()
    .single();
  
  if (error) {
    console.log(`  ❌ Insert failed: ${error.message}`);
    return { status: 'error', error };
  }
  
  console.log(`  ✓ Added to database (ID: ${movie.id})`);
  
  // Add dialogues
  return await addDialoguesToMovie(movie);
}

async function addDialoguesToMovie(movie) {
  if (!movie.imdb_id) {
    console.log(`  ⚠️ No IMDB ID, skipping subtitles`);
    return { status: 'added', movie, dialogues: 0 };
  }
  
  // Search for subtitles
  const subtitles = await searchSubtitlesByImdbId(movie.imdb_id);
  if (!subtitles || subtitles.length === 0) {
    console.log(`  ⚠️ No subtitles found`);
    return { status: 'added', movie, dialogues: 0 };
  }
  
  // Get file ID from first subtitle
  const fileId = subtitles[0]?.attributes?.files?.[0]?.file_id;
  if (!fileId) {
    console.log(`  ⚠️ No subtitle file ID`);
    return { status: 'added', movie, dialogues: 0 };
  }
  
  // Download subtitle
  const content = await downloadSubtitle(fileId);
  if (!content) {
    console.log(`  ⚠️ Could not download subtitle`);
    return { status: 'added', movie, dialogues: 0 };
  }
  
  // Parse and store dialogues
  const lines = parseSubtitles(content);
  const keyLines = lines.slice(0, 100); // Store up to 100 dialogues
  
  let cached = 0;
  for (const line of keyLines) {
    const { error } = await supabase.from('movie_dialogues').insert({
      movie_id: movie.id,
      text: line.text,
      start_timestamp: line.start,
      end_timestamp: line.end,
      source: 'opensubtitles_bulk',
    });
    if (!error) cached++;
  }
  
  console.log(`  ✓ Cached ${cached} dialogues`);
  return { status: 'added', movie, dialogues: cached };
}

async function main() {
  console.log('🎬 Movie Database Population Script');
  console.log('====================================\n');
  
  const stats = { added: 0, exists: 0, failed: 0, dialogues: 0 };
  
  for (const movie of MOVIES_TO_ADD) {
    try {
      const result = await addMovieWithSubtitles(movie);
      
      if (result.status === 'added') {
        stats.added++;
        stats.dialogues += result.dialogues || 0;
      } else if (result.status === 'exists') {
        stats.exists++;
      } else {
        stats.failed++;
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
      stats.failed++;
    }
  }
  
  console.log('\n====================================');
  console.log('📊 Summary:');
  console.log(`  ✓ Added: ${stats.added} movies`);
  console.log(`  ⏭️ Already existed: ${stats.exists} movies`);
  console.log(`  ❌ Failed: ${stats.failed} movies`);
  console.log(`  💬 Total dialogues cached: ${stats.dialogues}`);
}

main().catch(console.error);
