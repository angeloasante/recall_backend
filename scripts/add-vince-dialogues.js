const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addDialogues() {
  const movieId = 1803; // The Vince Staples Show
  
  // Add some distinctive dialogues from the show
  const dialogues = [
    'Nigga with the flowers',
    'Hello can you hear me',
    'Are you deaf',
    'The only nigga in here',
    'Put your hands up',
    'Long Beach California',
    'This is Long Beach',
    'Vince what are you doing',
    'I am not going back to jail',
    'What the hell is going on',
    'Welcome to Long Beach',
    'You know how we do it out here',
  ];
  
  let added = 0;
  for (const text of dialogues) {
    const { error } = await supabase
      .from('movie_dialogues')
      .insert({
        movie_id: movieId,
        text: text,
        source: 'manual_entry'
      });
    if (error) {
      console.log('Error adding:', text, error.message);
    } else {
      added++;
    }
  }
  console.log('Added', added, 'dialogues for The Vince Staples Show');
}

addDialogues();
