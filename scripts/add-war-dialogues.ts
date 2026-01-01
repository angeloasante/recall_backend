import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function addDialogues() {
  // Get the movie ID
  const { data: movie } = await supabase
    .from('movies')
    .select('id, title')
    .ilike('title', '%War Between the Land%')
    .single();

  if (!movie) {
    console.log('Movie not found in database!');
    return;
  }

  console.log('Found:', movie.title, '(ID:', movie.id + ')');

  // Key dialogues from the show (multiple clips)
  const dialogues = [
    // Clip 1: Dogs and fish scene
    { text: 'You ate our dogs! You eat our fish. But you cant eat our dogs!', character: 'Human Representative' },
    { text: 'You cant eat our fish! Our dogs are domesticated! Our fish are family!', character: 'Human Representative' },
    // Clip 2: First contact
    { text: 'This is the first contact between humans and ocean species', character: 'Narrator' },
    { text: 'She makes a request directly to the envoy', character: 'Narrator' },
    { text: 'When a fearsome and ancient species emerges from the ocean', character: 'Narrator' },
    { text: 'UNIT steps into action as the land and sea wage war', character: 'Narrator' },
    { text: 'The sea devils have returned', character: 'UNIT Officer' },
    // Clip 3: War is over
    { text: 'I have come to inform mankind. The war is over. You have won', character: 'Sea Devil' },
    { text: 'We are defeated. We grant you victory', character: 'Sea Devil' },
    { text: 'A large number of aquatic beings bodies suddenly washed up', character: 'Narrator' },
    { text: 'The war between the land and the sea', character: 'Narrator' },
    { text: 'An ancient species emerges from the ocean', character: 'Narrator' },
    { text: 'UNIT must stand against an impossible enemy', character: 'Narrator' },
  ];

  for (const d of dialogues) {
    // Check if already exists
    const { data: existing } = await supabase
      .from('movie_dialogues')
      .select('id')
      .eq('movie_id', movie.id)
      .eq('text', d.text)
      .single();

    if (existing) {
      console.log('Already exists:', d.text.substring(0, 40) + '...');
      continue;
    }

    // Insert dialogue (no embedding column - search uses text matching)
    const { error } = await supabase.from('movie_dialogues').insert({
      movie_id: movie.id,
      text: d.text,
      character_name: d.character,
      source: 'manual_entry',
    });

    if (error) {
      console.log('Error:', error.message);
    } else {
      console.log('✓ Added:', d.text.substring(0, 50) + '...');
    }
  }

  console.log('\n✅ Done! Dialogue search should now find this show.');
}

addDialogues();
