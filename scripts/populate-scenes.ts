import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase';
import { describeScene, generateEmbedding } from '../lib/openai';
import { buildImageUrl } from '../lib/tmdb';

// Populate scene embeddings for movies that have poster/backdrop images
async function main() {
  console.log('🎬 Starting scene embedding population...\n');

  try {
    // Get all movies that don't have scene embeddings yet
    const { data: movies, error: fetchError } = await supabaseAdmin
      .from('movies')
      .select('id, title, poster_url, backdrop_url')
      .order('popularity', { ascending: false })
      .limit(100); // Process all 100 movies

    if (fetchError) {
      throw new Error(`Failed to fetch movies: ${fetchError.message}`);
    }

    console.log(`📥 Found ${movies?.length || 0} movies to process\n`);

    let processed = 0;
    let failed = 0;

    for (const movie of movies || []) {
      console.log(`[${processed + 1}/${movies?.length}] Processing: ${movie.title}`);

      // Check if this movie already has scene embeddings
      const { count } = await supabaseAdmin
        .from('movie_scenes')
        .select('*', { count: 'exact', head: true })
        .eq('movie_id', movie.id);

      if (count && count > 0) {
        console.log(`  ⏭️ Already has ${count} scenes, skipping`);
        processed++;
        continue;
      }

      try {
        // Use backdrop (preferred) or poster
        const imageUrl = movie.backdrop_url || movie.poster_url;
        
        if (!imageUrl || imageUrl === 'null') {
          console.log(`  ⚠️ No image available, skipping`);
          failed++;
          continue;
        }

        // 1. Generate scene description from movie poster/backdrop
        console.log(`  🖼️ Analyzing image...`);
        const description = await describeScene(imageUrl);
        console.log(`  ✓ Description: "${description.substring(0, 60)}..."`);

        // 2. Generate embedding
        console.log(`  🔢 Generating embedding...`);
        const embedding = await generateEmbedding(description);
        console.log(`  ✓ Embedding: ${embedding.length} dimensions`);

        // 3. Store in database
        const { error: insertError } = await supabaseAdmin
          .from('movie_scenes')
          .insert({
            movie_id: movie.id,
            description: description,
            embedding: JSON.stringify(embedding),
            frame_url: imageUrl,
            timestamp: 0, // Poster, not from actual video
            source: 'poster',
          });

        if (insertError) {
          console.log(`  ❌ Insert failed: ${insertError.message}`);
          failed++;
        } else {
          console.log(`  ✓ Scene saved to database`);
          processed++;
        }

        // Rate limiting - be nice to OpenAI
        await sleep(1000);

      } catch (error: any) {
        console.error(`  ❌ Error: ${error.message}`);
        failed++;
      }

      console.log('');
    }

    console.log('\n========================================');
    console.log('✅ Scene embedding population complete!');
    console.log(`📊 Processed: ${processed} movies`);
    console.log(`❌ Failed: ${failed} movies`);
    console.log('========================================\n');

  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run
main();
