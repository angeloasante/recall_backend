const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addCast() {
  const movieId = 1803; // The Vince Staples Show
  
  const cast = [
    { actor_name: 'Vince Staples', character_name: 'Vince Staples' },
  ];
  
  for (const member of cast) {
    const { error } = await supabase
      .from('movie_cast')
      .insert({
        movie_id: movieId,
        ...member
      });
    console.log(error ? 'Error: ' + error.message : 'Added: ' + member.actor_name);
  }
}

addCast();
