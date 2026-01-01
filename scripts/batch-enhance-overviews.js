/**
 * Batch enhance all movie overviews in the database that are too short
 * Run with: node scripts/batch-enhance-overviews.js
 */

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateEnhancedOverview(title, year, existingOverview) {
  try {
    const prompt = existingOverview 
      ? `Expand this movie overview into a detailed, engaging description (500-700 characters). Keep the facts accurate:

Movie: "${title}" (${year || 'Unknown year'})
Current overview: "${existingOverview}"

Write an expanded overview that maintains factual accuracy, adds context about themes and tone, and is engaging without spoilers. Return ONLY the expanded text.`
      : `Write a brief movie overview (400-500 characters) for "${title}" (${year || 'Unknown year'}). Be factually accurate and engaging without spoilers. Return ONLY the overview text.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional movie database curator. Write accurate, engaging movie descriptions without spoilers.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    return response.choices[0]?.message?.content?.trim() || existingOverview;
  } catch (error) {
    console.error(`Error for "${title}":`, error.message);
    return existingOverview;
  }
}

async function batchEnhance() {
  console.log('🔍 Finding movies with short overviews...\n');
  
  // Get all movies with short overviews (< 300 chars)
  const { data: movies, error } = await supabase
    .from('movies')
    .select('id, title, year, overview')
    .order('id', { ascending: false });
  
  if (error) {
    console.error('Error fetching movies:', error);
    return;
  }
  
  const shortMovies = movies.filter(m => !m.overview || m.overview.length < 300);
  console.log(`Found ${shortMovies.length} movies with short overviews (< 300 chars)\n`);
  
  let enhanced = 0;
  let failed = 0;
  
  for (const movie of shortMovies) {
    const originalLen = movie.overview ? movie.overview.length : 0;
    console.log(`[${movie.id}] ${movie.title} (${movie.year}) - ${originalLen} chars`);
    
    const newOverview = await generateEnhancedOverview(movie.title, movie.year, movie.overview);
    
    if (newOverview && newOverview.length > originalLen) {
      const { error: updateError } = await supabase
        .from('movies')
        .update({ overview: newOverview })
        .eq('id', movie.id);
      
      if (!updateError) {
        console.log(`  ✓ Enhanced: ${originalLen} -> ${newOverview.length} chars`);
        enhanced++;
      } else {
        console.log(`  ❌ Update failed: ${updateError.message}`);
        failed++;
      }
    } else {
      console.log(`  ⚠️ No improvement available`);
    }
    
    // Rate limit: wait 200ms between API calls
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`\n✅ Done! Enhanced: ${enhanced}, Failed: ${failed}, Total: ${shortMovies.length}`);
}

// Run if called directly
batchEnhance();
