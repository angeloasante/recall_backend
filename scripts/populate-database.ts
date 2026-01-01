import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase';
import { getPopularMovies, getMovieDetails, getMovieCast, buildImageUrl } from '../lib/tmdb';
import { generateEmbedding } from '../lib/openai';

const MOVIES_TO_POPULATE = 100; // Start with 100, increase as needed

async function main() {
  console.log('🎬 Starting database population...\n');

  try {
    // 1. Fetch popular movies from TMDB
    console.log(`📥 Fetching ${MOVIES_TO_POPULATE} popular movies from TMDB...`);
    const tmdbMovies = await getPopularMovies(MOVIES_TO_POPULATE);
    console.log(`✓ Fetched ${tmdbMovies.length} movies\n`);

    // 2. Process each movie
    for (let i = 0; i < tmdbMovies.length; i++) {
      const tmdbMovie = tmdbMovies[i];
      console.log(`[${i + 1}/${tmdbMovies.length}] Processing: ${tmdbMovie.title}`);

      try {
        // Get full movie details including IMDB ID
        const details = await getMovieDetails(tmdbMovie.id);

        // Insert movie into database
        const { data: movie, error: movieError } = await supabaseAdmin
          .from('movies')
          .upsert({
            tmdb_id: tmdbMovie.id,
            imdb_id: details.imdb_id || null,
            title: tmdbMovie.title,
            year: tmdbMovie.release_date ? new Date(tmdbMovie.release_date).getFullYear() : null,
            poster_url: buildImageUrl(tmdbMovie.poster_path),
            backdrop_url: buildImageUrl(tmdbMovie.backdrop_path, 'original'),
            overview: tmdbMovie.overview,
            popularity: tmdbMovie.popularity,
          }, {
            onConflict: 'tmdb_id',
          })
          .select()
          .single();

        if (movieError) {
          console.error(`  ✗ Failed to insert movie: ${movieError.message}`);
          continue;
        }

        // Insert cast members
        const cast = await getMovieCast(tmdbMovie.id);
        if (cast.length > 0) {
          const castData = cast.map((member: any) => ({
            movie_id: movie.id,
            actor_name: member.name,
            character_name: member.character,
            tmdb_person_id: member.id,
          }));

          const { error: castError } = await supabaseAdmin
            .from('movie_cast')
            .upsert(castData);
        
        if (castError) console.log('  Cast insert note:', castError.message);

          console.log(`  ✓ Added ${cast.length} cast members`);
        }

        // Add some sample dialogues (in production, scrape from IMDb or subtitles)
        await addSampleDialogues(movie.id, tmdbMovie.title, tmdbMovie.overview);

        console.log(`  ✓ Completed: ${tmdbMovie.title}\n`);

        // Rate limiting - wait between requests
        await sleep(500);

      } catch (error) {
        console.error(`  ✗ Error processing ${tmdbMovie.title}:`, error);
      }
    }

    console.log('\n✅ Database population complete!');
    console.log(`📊 Processed ${tmdbMovies.length} movies`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Add sample dialogues based on overview (placeholder - in production use real subtitles)
async function addSampleDialogues(movieId: number, title: string, overview: string) {
  if (!overview) return;

  // For MVP, we'll use the overview as a searchable dialogue
  // In production, you'd scrape IMDb quotes or parse subtitle files
  const dialogues = [
    {
      movie_id: movieId,
      text: overview,
      source: 'overview',
    },
    {
      movie_id: movieId,
      text: title,
      source: 'title',
    },
  ];

  const { error } = await supabaseAdmin
    .from('movie_dialogues')
    .upsert(dialogues);
  
  if (error) console.log('  Dialogue insert note:', error.message);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
main();
