const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  const searchQuery = 'police | officer | shot | mercy | judge';
  
  const { data, error } = await supabase
    .from('movie_dialogues')
    .select('movie_id, text, movies(id, title)')
    .textSearch('text', searchQuery, { type: 'websearch' })
    .limit(10);
  
  if (error) {
    console.log('Search error:', error.message);
  } else {
    console.log('Found', data?.length || 0, 'matches:');
    data?.forEach(d => console.log(' -', d.movies?.title, ':', d.text?.substring(0, 60)));
  }
}

test();
