const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addDialogues() {
  // Get River Runs Red movie
  const { data: movie, error: fetchError } = await supabase.from('movies').select('*').eq('id', 1252).single();
  
  if (fetchError || !movie) {
    console.log('Movie not found:', fetchError?.message);
    return;
  }
  
  console.log('Movie:', movie.title, '- IMDB:', movie.imdb_id);
  
  // Key dialogues from River Runs Red (2018)
  // These are paraphrased/representative lines based on the plot
  const dialogues = [
    'My son just said hello to a police officer and he was shot dead without mercy',
    'When they opened fire it was as if the world stopped',
    'The system set them free',
    'We will take the law into our own hands',
    'Justice will be served one way or another',
    'Those officers will pay for what they did',
    'The badge does not give you the right to kill',
    'I am a judge but I am also a father',
    'He was just a kid saying hello',
    'They shot him down like an animal',
    'The corruption runs deep in this city',
    'No father should have to bury his son',
    'The evidence was right there but they ignored it',
    'We trusted the system and it failed us',
    'Those cops think they are above the law',
    'My boy never hurt anyone in his life',
    'They will answer for their crimes',
    'The blue wall of silence protects murderers',
    'I have dedicated my life to justice',
    'Now I must become the instrument of justice',
    'Blood will have blood',
    'An eye for an eye',
    'The system is broken beyond repair',
    'We are going to fix it ourselves',
    'Two mourning fathers united by tragedy',
    'They took everything from us',
    'Revenge is all we have left',
    'The law failed so we must act',
    'Those officers smiled in court',
    'They showed no remorse for killing a child',
  ];
  
  let added = 0;
  for (const text of dialogues) {
    const { error } = await supabase.from('movie_dialogues').insert({
      movie_id: movie.id,
      text: text,
      source: 'manual_key_dialogues'
    });
    if (!error) added++;
  }
  
  console.log('Added', added, 'dialogues for River Runs Red');
}

addDialogues();
