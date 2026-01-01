import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function addMeTime() {
  // Check if exists by title or tmdb_id
  let { data: existing } = await supabase
    .from('movies')
    .select('*')
    .eq('tmdb_id', 718930)
    .single();
    
  if (!existing) {
    // Try by title
    const { data: byTitle } = await supabase
      .from('movies')
      .select('*')
      .ilike('title', '%me time%')
      .single();
    existing = byTitle;
  }
    
  let movieId: number;
  
  if (existing) {
    console.log('Me Time already exists with ID:', existing.id);
    movieId = existing.id;
    
    // Update with correct data if needed
    if (!existing.imdb_id || !existing.poster_url) {
      const { error: updateError } = await supabase
        .from('movies')
        .update({
          imdb_id: 'tt14309446',
          poster_url: 'https://image.tmdb.org/t/p/w500/av5QRkT8dKP08e3SYZFqJHyNHQO.jpg',
          backdrop_url: 'https://image.tmdb.org/t/p/w1280/wBT5AhpNgZ0NdLfANzBV3oBm6MP.jpg',
          overview: 'A stay-at-home dad finds himself with some "me time" for the first time in years while his wife and kids are away. He reconnects with his former best friend for a wild weekend that nearly upends his life.',
        })
        .eq('id', existing.id);
      if (!updateError) {
        console.log('Updated movie with missing data');
      }
    }
  } else {
    // Add the movie
    const { data: movie, error } = await supabase
      .from('movies')
      .insert({
        title: 'Me Time',
        year: 2022,
        overview: 'A stay-at-home dad finds himself with some "me time" for the first time in years while his wife and kids are away. He reconnects with his former best friend for a wild weekend that nearly upends his life.',
        imdb_id: 'tt14309446',
        tmdb_id: 718930,
        poster_url: 'https://image.tmdb.org/t/p/w500/av5QRkT8dKP08e3SYZFqJHyNHQO.jpg',
        backdrop_url: 'https://image.tmdb.org/t/p/w1280/wBT5AhpNgZ0NdLfANzBV3oBm6MP.jpg',
      })
      .select()
      .single();
      
    if (error) {
      console.error('Error adding movie:', error.message);
      return;
    }
    
    console.log('Added Me Time with ID:', movie.id);
    movieId = movie.id;
  }
  
  // Check existing dialogue count
  const { count } = await supabase
    .from('movie_dialogues')
    .select('*', { count: 'exact', head: true })
    .eq('movie_id', movieId);
    
  console.log('Existing dialogues:', count);
  
  if (count && count > 5) {
    console.log('Already has enough dialogues, skipping');
    return;
  }
  
  // Add key dialogues from the movie (including the lion cub scene)
  const dialogues = [
    // Lion cub scene (from the clip)
    "What the? Hold on now. What is this?",
    "Oh, stop. No, stop. That tickles.",
    "You got some claws on you, huh?",
    "You're still cute, though. Cute little...",
    "Whoa! Easy, easy!",
    // Other memorable dialogues
    "I haven't had me time in years.",
    "When's the last time you did something for yourself?",
    "This is gonna be the best weekend ever!",
    "I'm a stay-at-home dad, that's my job.",
    "We used to be best friends, man.",
    "Remember when we were young and wild?",
    "My wife is gonna kill me.",
    "What happens in the wild stays in the wild.",
    "I need to get back to my family.",
    "You've changed, man. You used to be fun.",
    "Being a dad doesn't mean you stop living.",
    "I'm Sonny Fisher. Nice to meet you.",
    "Huck Dembo. Party animal extraordinaire.",
    "You used to be the man!",
    "I'm still the man, just a different kind of man.",
  ];
  
  for (const text of dialogues) {
    const { error: dialogueError } = await supabase.from('movie_dialogues').insert({
      movie_id: movieId,
      text: text,
      source: 'manual',
    });
    if (dialogueError) {
      console.error('Error adding dialogue:', dialogueError.message);
    }
  }
  
  console.log('Added', dialogues.length, 'dialogues for Me Time');
}

addMeTime().catch(console.error);
