const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function testV1Search() {
  // Words that might appear in a River Runs Red clip
  const words = ['police', 'officer', 'hello', 'son', 'father'];
  
  console.log('Testing ilike-based V1 search with words:', words.join(', '));
  console.log('');
  
  const allMatches = [];
  
  for (const word of words) {
    const { data, error } = await supabase
      .from('movie_dialogues')
      .select('movie_id, text')
      .ilike('text', `%${word}%`)
      .limit(10);
    
    if (error) {
      console.log(`Word "${word}": ERROR - ${error.message}`);
    } else if (data) {
      console.log(`Word "${word}": ${data.length} matches`);
      allMatches.push(...data);
    }
  }
  
  console.log('\n--- Grouping by movie ---');
  
  // Group by movie and count unique word matches
  const movieScores = new Map();
  
  for (const match of allMatches) {
    const movieId = match.movie_id;
    if (!movieScores.has(movieId)) {
      movieScores.set(movieId, new Set());
    }
    for (const word of words) {
      if (match.text.toLowerCase().includes(word)) {
        movieScores.get(movieId).add(word);
      }
    }
  }
  
  console.log(`\nFound matches in ${movieScores.size} movies:\n`);
  
  // Sort by number of matched words
  const sorted = [...movieScores.entries()].sort((a, b) => b[1].size - a[1].size);
  
  for (const [movieId, matchedWords] of sorted.slice(0, 10)) {
    const score = Math.min(matchedWords.size * 0.15, 0.9);
    
    // Get movie title
    const { data: movie } = await supabase
      .from('movies')
      .select('title')
      .eq('id', movieId)
      .single();
    
    const title = movie?.title || 'Unknown';
    console.log(`  Movie ${movieId} (${title}):`);
    console.log(`    Words: ${[...matchedWords].join(', ')}`);
    console.log(`    Score: ${score.toFixed(2)} (${matchedWords.size} words × 0.15)`);
    console.log('');
  }
  
  // Check River Runs Red specifically
  if (movieScores.has(1252)) {
    console.log('✅ River Runs Red (ID 1252) would be matched!');
  } else {
    console.log('❌ River Runs Red not in matches');
    
    // Check if it has dialogues
    const { data: dialogues, count } = await supabase
      .from('movie_dialogues')
      .select('text', { count: 'exact' })
      .eq('movie_id', 1252)
      .limit(3);
    
    console.log(`   River Runs Red has ${count} dialogues`);
    if (dialogues) {
      console.log('   Sample:', dialogues[0]?.text?.substring(0, 50) + '...');
    }
  }
}

testV1Search().catch(console.error);
