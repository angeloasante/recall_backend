const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Use service role key to bypass RLS
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addMeTime() {
  // Add Me Time to movies table
  const { data: movie, error: movieError } = await supabase
    .from('movies')
    .insert({
      title: 'Me Time',
      year: 2022,
      tmdb_id: 718930,
      imdb_id: 'tt14309446',
      poster_url: 'https://image.tmdb.org/t/p/w500/a1F3d0k6nXyAKO14JY2zIjB2Ot6.jpg',
      overview: 'A stay-at-home dad finds himself with some me time for the first time in years while his wife and kids are away. He reconnects with his former best friend for a wild weekend.'
    })
    .select()
    .single();
    
  if (movieError) {
    console.log('Movie insert error:', movieError.message);
    return;
  }
  console.log('Added Me Time:', movie.id);
  
  // Add key dialogues from the movie (including the cat scene)
  const dialogues = [
    'What the? Hold on now. What is this? Oh, stop. No, stop. That tickles. You got some claws on you.',
    'You are my best friend, Huck. I love you, man.',
    'I have not had me time in years.',
    'This is gonna be the best weekend ever!',
    'I am a stay-at-home dad, and I love it.',
    'Sonny, you need to live a little!',
    'We used to be wild, man. What happened to us?',
    'My wife is gonna kill me.',
    'I cannot believe you have a mountain lion!',
    'This is Jefe. He is friendly... mostly.',
    'Huck, you are out of your mind!',
    'When was the last time you did something crazy?',
    'The kids are at camp, Maya is on a trip.',
    'You got a whole week of me time, what are you gonna do with it?'
  ];
  
  const { error: dialogueError } = await supabase
    .from('movie_dialogues')
    .insert(dialogues.map(text => ({
      movie_id: movie.id,
      text: text,
      source: 'manual'
    })));
    
  if (dialogueError) {
    console.log('Dialogue insert error:', dialogueError.message);
  } else {
    console.log('Added', dialogues.length, 'dialogues for Me Time');
  }
}

addMeTime();
