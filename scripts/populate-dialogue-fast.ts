import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function populateDialogues() {
  console.log('💬 Populating dialogue data...\n');
  
  const { data: movies } = await supabase
    .from('movies')
    .select('id, title, overview')
    .not('overview', 'is', null);
  
  if (!movies) {
    console.error('No movies found');
    return;
  }
  
  console.log(`Processing ${movies.length} movies...`);
  
  // Check existing dialogues
  const { data: existingDialogues } = await supabase
    .from('movie_dialogues')
    .select('movie_id');
  
  const processedMovieIds = new Set(existingDialogues?.map(d => d.movie_id) || []);
  
  const moviesToProcess = movies.filter(m => !processedMovieIds.has(m.id));
  
  console.log(`${moviesToProcess.length} movies need dialogues\n`);
  
  if (moviesToProcess.length === 0) {
    console.log('✅ All movies already have dialogues!');
    return;
  }
  
  const dialogues: any[] = [];
  
  for (const movie of moviesToProcess) {
    // Split overview into sentences
    const sentences = movie.overview
      .split(/[.!?]+/)
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 20); // Only substantial sentences
    
    sentences.forEach((sentence: string, idx: number) => {
      dialogues.push({
        movie_id: movie.id,
        text: sentence,
        source: 'tmdb_overview',
      });
    });
    
    // Also add the full overview as one entry
    dialogues.push({
      movie_id: movie.id,
      text: movie.overview,
      source: 'tmdb_full_overview',
    });
    
    // Add title as searchable text
    dialogues.push({
      movie_id: movie.id,
      text: movie.title,
      source: 'title',
    });
  }
  
  console.log(`Inserting ${dialogues.length} dialogue entries...`);
  
  // Insert in batches
  let inserted = 0;
  for (let i = 0; i < dialogues.length; i += 500) {
    const batch = dialogues.slice(i, i + 500);
    
    const { error } = await supabase
      .from('movie_dialogues')
      .insert(batch);
    
    if (error) {
      console.error(`Error inserting batch ${i}:`, error.message);
    } else {
      inserted += batch.length;
      console.log(`✅ Inserted ${inserted}/${dialogues.length}`);
    }
  }
  
  console.log('\n🎉 Dialogues populated!');
}

populateDialogues().catch(console.error);
