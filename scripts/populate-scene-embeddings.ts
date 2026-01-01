import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function generateSceneEmbedding(movie: any): Promise<boolean> {
  try {
    // Create comprehensive scene description from TMDB data
    const sceneDescription = `
Movie: ${movie.title}
Year: ${movie.year || 'Unknown'}
Plot: ${movie.overview || 'No description available'}
Visual Style: ${movie.backdrop_url ? 'Cinematic widescreen' : 'Standard format'}
Key Scene Elements: ${movie.overview?.split('.')[0] || movie.title}
    `.trim();
    
    // Generate embedding for this description
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: sceneDescription,
    });
    
    const embedding = embeddingResponse.data[0].embedding;
    
    // Insert into movie_scenes
    const { error } = await supabase
      .from('movie_scenes')
      .insert({
        movie_id: movie.id,
        description: sceneDescription,
        embedding: JSON.stringify(embedding),
        source: 'tmdb_overview',
        timestamp: 0,
      });
    
    if (error) {
      console.log(`  ❌ ${movie.title}: ${error.message}`);
      return false;
    }
    
    console.log(`  ✅ ${movie.title}`);
    return true;
    
  } catch (error: any) {
    console.log(`  ❌ ${movie.title}: ${error.message}`);
    return false;
  }
}

async function populateSceneEmbeddings() {
  console.log('🎨 Generating scene embeddings...\n');
  
  // Get all movies
  const { data: movies, error } = await supabase
    .from('movies')
    .select('id, title, year, overview, backdrop_url')
    .not('overview', 'is', null)
    .order('popularity', { ascending: false });
  
  if (error || !movies) {
    console.error('❌ Failed to fetch movies:', error);
    return;
  }
  
  console.log(`Found ${movies.length} movies total`);
  
  // Check which already have embeddings
  const { data: existingScenes } = await supabase
    .from('movie_scenes')
    .select('movie_id');
  
  const processedMovieIds = new Set(existingScenes?.map(s => s.movie_id) || []);
  
  const moviesToProcess = movies.filter(m => !processedMovieIds.has(m.id));
  
  console.log(`${moviesToProcess.length} movies need embeddings\n`);
  
  if (moviesToProcess.length === 0) {
    console.log('✅ All movies already have embeddings!');
    return;
  }
  
  let processed = 0;
  let failed = 0;
  
  // Process in batches of 10 to avoid rate limits
  for (let i = 0; i < moviesToProcess.length; i += 10) {
    const batch = moviesToProcess.slice(i, i + 10);
    
    console.log(`Batch ${Math.floor(i / 10) + 1}/${Math.ceil(moviesToProcess.length / 10)}`);
    
    const results = await Promise.all(batch.map(generateSceneEmbedding));
    
    processed += results.filter(r => r).length;
    failed += results.filter(r => !r).length;
    
    // Rate limit: OpenAI allows 3000 RPM, but let's be conservative
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  console.log(`\n🎉 Scene embeddings complete!`);
  console.log(`📊 Processed: ${processed}, Failed: ${failed}`);
}

populateSceneEmbeddings().catch(console.error);
