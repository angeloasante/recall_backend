import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function check() {
  const tables = ["dialogues", "dialogue", "movie_dialogues", "quotes", "movie_quotes", "scene_embeddings"];
  
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select("*").limit(1);
    console.log(table + ":", error ? "NOT FOUND - " + error.hint : "EXISTS - " + JSON.stringify(data));
  }
  
  // Check movies with classic titles
  const classics = ['Matrix', 'Dark Knight', 'Forrest Gump', 'Star Wars', 'Godfather'];
  console.log('\nSearching for classic movies:');
  for (const title of classics) {
    const { data } = await supabase
      .from('movies')
      .select('id, title, imdb_id')
      .ilike('title', `%${title}%`)
      .limit(3);
    console.log(`  ${title}:`, data?.map(m => `${m.title} (${m.imdb_id})`).join(', ') || 'NOT FOUND');
  }
}

check();
