import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Famous movie quotes - curated for recognition
// Using movie titles for matching since many don't have imdb_id
const FAMOUS_QUOTES = [
  // The Matrix (1999)
  { title: 'The Matrix', quote: "I know kung fu", speaker: "Neo" },
  { title: 'The Matrix', quote: "There is no spoon", speaker: "Spoon Boy" },
  { title: 'The Matrix', quote: "Welcome to the real world", speaker: "Morpheus" },
  { title: 'The Matrix', quote: "What is the Matrix?", speaker: "Neo" },
  { title: 'The Matrix', quote: "Free your mind", speaker: "Morpheus" },
  { title: 'The Matrix', quote: "Dodge this", speaker: "Trinity" },
  { title: 'The Matrix', quote: "You take the blue pill, the story ends", speaker: "Morpheus" },
  
  // The Dark Knight (2008)
  { title: 'The Dark Knight', quote: "Why so serious?", speaker: "Joker" },
  { title: 'The Dark Knight', quote: "You either die a hero or live long enough to see yourself become the villain", speaker: "Harvey Dent" },
  { title: 'The Dark Knight', quote: "Some men just want to watch the world burn", speaker: "Alfred" },
  { title: 'The Dark Knight', quote: "I believe whatever doesn't kill you simply makes you stranger", speaker: "Joker" },
  { title: 'The Dark Knight', quote: "Let's put a smile on that face", speaker: "Joker" },
  { title: 'The Dark Knight', quote: "This city deserves a better class of criminal", speaker: "Joker" },
  
  // Forrest Gump (1994)
  { title: 'Forrest Gump', quote: "Life is like a box of chocolates, you never know what you're gonna get", speaker: "Forrest" },
  { title: 'Forrest Gump', quote: "Run, Forrest, run!", speaker: "Jenny" },
  { title: 'Forrest Gump', quote: "Stupid is as stupid does", speaker: "Forrest" },
  { title: 'Forrest Gump', quote: "I'm not a smart man, but I know what love is", speaker: "Forrest" },
  
  // Star Wars
  { title: 'Star Wars', quote: "May the Force be with you", speaker: "Obi-Wan" },
  { title: 'Star Wars', quote: "I find your lack of faith disturbing", speaker: "Darth Vader" },
  { title: 'Star Wars', quote: "Help me, Obi-Wan Kenobi. You're my only hope", speaker: "Leia" },
  { title: 'Star Wars', quote: "Use the Force, Luke", speaker: "Obi-Wan" },
  { title: 'Star Wars', quote: "That's no moon. It's a space station", speaker: "Obi-Wan" },
  { title: 'Star Wars', quote: "No, I am your father", speaker: "Darth Vader" },
  { title: 'Star Wars', quote: "Do or do not. There is no try", speaker: "Yoda" },
  
  // The Godfather
  { title: 'The Godfather', quote: "I'm gonna make him an offer he can't refuse", speaker: "Don Corleone" },
  { title: 'The Godfather', quote: "Leave the gun. Take the cannoli", speaker: "Clemenza" },
  { title: 'The Godfather', quote: "It's not personal, Sonny. It's strictly business", speaker: "Michael" },
  
  // Titanic
  { title: 'Titanic', quote: "I'm the king of the world!", speaker: "Jack" },
  { title: 'Titanic', quote: "Draw me like one of your French girls", speaker: "Rose" },
  { title: 'Titanic', quote: "I'll never let go, Jack", speaker: "Rose" },
  
  // Pulp Fiction
  { title: 'Pulp Fiction', quote: "English, motherfucker, do you speak it?", speaker: "Jules" },
  { title: 'Pulp Fiction', quote: "Say what again. I dare you", speaker: "Jules" },
  { title: 'Pulp Fiction', quote: "Zed's dead, baby. Zed's dead", speaker: "Butch" },
  
  // Avengers
  { title: 'The Avengers', quote: "I have an army. We have a Hulk", speaker: "Tony Stark" },
  { title: 'The Avengers', quote: "Puny god", speaker: "Hulk" },
  { title: 'The Avengers', quote: "That's my secret, Captain. I'm always angry", speaker: "Bruce Banner" },
  
  // Avengers: Endgame
  { title: 'Avengers: Endgame', quote: "I am Iron Man", speaker: "Tony Stark" },
  { title: 'Avengers: Endgame', quote: "I love you 3000", speaker: "Morgan Stark" },
  { title: 'Avengers: Endgame', quote: "Whatever it takes", speaker: "Avengers" },
  
  // Avengers: Infinity War
  { title: 'Avengers: Infinity War', quote: "I don't feel so good", speaker: "Spider-Man" },
  { title: 'Avengers: Infinity War', quote: "Perfectly balanced, as all things should be", speaker: "Thanos" },
  
  // Spider-Man
  { title: 'Spider-Man', quote: "With great power comes great responsibility", speaker: "Uncle Ben" },
  
  // The Lion King
  { title: 'The Lion King', quote: "Hakuna Matata", speaker: "Timon & Pumbaa" },
  { title: 'The Lion King', quote: "Long live the king", speaker: "Scar" },
  { title: 'The Lion King', quote: "Remember who you are", speaker: "Mufasa" },
  
  // Frozen
  { title: 'Frozen', quote: "Let it go, let it go", speaker: "Elsa" },
  { title: 'Frozen', quote: "Do you want to build a snowman?", speaker: "Anna" },
  { title: 'Frozen', quote: "Some people are worth melting for", speaker: "Olaf" },
  
  // Toy Story
  { title: 'Toy Story', quote: "To infinity and beyond!", speaker: "Buzz Lightyear" },
  { title: 'Toy Story', quote: "There's a snake in my boot!", speaker: "Woody" },
  
  // Finding Nemo
  { title: 'Finding Nemo', quote: "Just keep swimming", speaker: "Dory" },
  { title: 'Finding Nemo', quote: "Fish are friends, not food", speaker: "Bruce" },
  
  // The Incredibles
  { title: 'The Incredibles', quote: "Where is my super suit?!", speaker: "Frozone" },
  { title: 'The Incredibles', quote: "No capes!", speaker: "Edna Mode" },
  
  // Shrek
  { title: 'Shrek', quote: "What are you doing in my swamp?!", speaker: "Shrek" },
  { title: 'Shrek', quote: "Ogres are like onions", speaker: "Shrek" },
  { title: 'Shrek', quote: "Donkey!", speaker: "Shrek" },
  
  // Interstellar
  { title: 'Interstellar', quote: "Murph! Don't let me leave, Murph!", speaker: "Cooper" },
  { title: 'Interstellar', quote: "Love is the one thing that transcends time and space", speaker: "Brand" },
  
  // Inception
  { title: 'Inception', quote: "You mustn't be afraid to dream a little bigger, darling", speaker: "Eames" },
  { title: 'Inception', quote: "We need to go deeper", speaker: "Cobb" },
  
  // Fight Club
  { title: 'Fight Club', quote: "The first rule of Fight Club is you do not talk about Fight Club", speaker: "Tyler Durden" },
  
  // The Shining
  { title: 'The Shining', quote: "Here's Johnny!", speaker: "Jack Torrance" },
  { title: 'The Shining', quote: "All work and no play makes Jack a dull boy", speaker: "Jack Torrance" },
  
  // Jaws
  { title: 'Jaws', quote: "You're gonna need a bigger boat", speaker: "Chief Brody" },
  
  // Back to the Future
  { title: 'Back to the Future', quote: "Great Scott!", speaker: "Doc Brown" },
  { title: 'Back to the Future', quote: "Roads? Where we're going, we don't need roads", speaker: "Doc Brown" },
  
  // Jurassic Park
  { title: 'Jurassic Park', quote: "Life finds a way", speaker: "Ian Malcolm" },
  { title: 'Jurassic Park', quote: "Clever girl", speaker: "Muldoon" },
  
  // The Lord of the Rings
  { title: 'The Lord of the Rings', quote: "You shall not pass!", speaker: "Gandalf" },
  { title: 'The Lord of the Rings', quote: "One does not simply walk into Mordor", speaker: "Boromir" },
  { title: 'The Lord of the Rings', quote: "My precious", speaker: "Gollum" },
  
  // Harry Potter
  { title: 'Harry Potter', quote: "You're a wizard, Harry", speaker: "Hagrid" },
  { title: 'Harry Potter', quote: "It's leviOsa, not levioSA", speaker: "Hermione" },
  { title: 'Harry Potter', quote: "Always", speaker: "Snape" },
  
  // Pirates of the Caribbean
  { title: 'Pirates of the Caribbean', quote: "Why is the rum gone?", speaker: "Jack Sparrow" },
  { title: 'Pirates of the Caribbean', quote: "But you have heard of me", speaker: "Jack Sparrow" },
  
  // Gladiator
  { title: 'Gladiator', quote: "Are you not entertained?!", speaker: "Maximus" },
  { title: 'Gladiator', quote: "My name is Maximus Decimus Meridius", speaker: "Maximus" },
  
  // 300
  { title: '300', quote: "This is Sparta!", speaker: "Leonidas" },
  { title: '300', quote: "Tonight we dine in hell!", speaker: "Leonidas" },
  
  // Mean Girls
  { title: 'Mean Girls', quote: "On Wednesdays we wear pink", speaker: "Karen" },
  { title: 'Mean Girls', quote: "That's so fetch", speaker: "Gretchen" },
  { title: 'Mean Girls', quote: "You can't sit with us!", speaker: "Gretchen" },
  
  // Joker
  { title: 'Joker', quote: "You wouldn't get it", speaker: "Joker" },
  { title: 'Joker', quote: "How about another joke, Murray?", speaker: "Joker" },
  
  // Black Panther
  { title: 'Black Panther', quote: "Wakanda forever!", speaker: "T'Challa" },
  
  // Avatar
  { title: 'Avatar', quote: "I see you", speaker: "Neytiri" },
  
  // John Wick
  { title: 'John Wick', quote: "Yeah, I'm thinking I'm back", speaker: "John Wick" },
  { title: 'John Wick', quote: "People keep asking if I'm back", speaker: "John Wick" },
  
  // The Wolf of Wall Street
  { title: 'The Wolf of Wall Street', quote: "I'm not leaving!", speaker: "Jordan Belfort" },
  
  // Django Unchained
  { title: 'Django Unchained', quote: "The D is silent", speaker: "Django" },
  
  // Taken
  { title: 'Taken', quote: "I will find you, and I will kill you", speaker: "Bryan Mills" },
  { title: 'Taken', quote: "I have a very particular set of skills", speaker: "Bryan Mills" },
  
  // Home Alone
  { title: 'Home Alone', quote: "Keep the change, ya filthy animal", speaker: "Kevin" },
  { title: 'Home Alone', quote: "Merry Christmas, ya filthy animal", speaker: "Gangster Johnny" },
  
  // Zootopia
  { title: 'Zootopia', quote: "Anyone can be anything", speaker: "Judy Hopps" },
  
  // Moana
  { title: 'Moana', quote: "You're welcome!", speaker: "Maui" },
  
  // Top Gun
  { title: 'Top Gun', quote: "I feel the need... the need for speed!", speaker: "Maverick" },
  { title: 'Top Gun', quote: "Talk to me, Goose", speaker: "Maverick" },
  
  // Oppenheimer
  { title: 'Oppenheimer', quote: "I am become death, the destroyer of worlds", speaker: "Oppenheimer" },
  
  // Barbie
  { title: 'Barbie', quote: "I'm just Ken", speaker: "Ken" },
  { title: 'Barbie', quote: "Hi Barbie!", speaker: "Everyone" },
  
  // Get Out
  { title: 'Get Out', quote: "Get out!", speaker: "Rod" },
  
  // The Hangover
  { title: 'The Hangover', quote: "What happens in Vegas, stays in Vegas", speaker: "Phil" },
  { title: 'The Hangover', quote: "But did you die?", speaker: "Mr. Chow" },
  
  // Anchorman
  { title: 'Anchorman', quote: "I'm kind of a big deal", speaker: "Ron Burgundy" },
  { title: 'Anchorman', quote: "Stay classy, San Diego", speaker: "Ron Burgundy" },
  
  // Napoleon Dynamite
  { title: 'Napoleon Dynamite', quote: "Vote for Pedro", speaker: "Napoleon" },
  
  // The Sixth Sense
  { title: 'The Sixth Sense', quote: "I see dead people", speaker: "Cole" },
  
  // Jerry Maguire
  { title: 'Jerry Maguire', quote: "Show me the money!", speaker: "Rod Tidwell" },
  { title: 'Jerry Maguire', quote: "You had me at hello", speaker: "Dorothy" },
  
  // A Few Good Men
  { title: 'A Few Good Men', quote: "You can't handle the truth!", speaker: "Col. Jessup" },
  
  // The Notebook
  { title: 'The Notebook', quote: "If you're a bird, I'm a bird", speaker: "Allie" },
  
  // The Hunger Games
  { title: 'The Hunger Games', quote: "May the odds be ever in your favor", speaker: "Effie" },
  { title: 'The Hunger Games', quote: "I volunteer as tribute!", speaker: "Katniss" },
  
  // Cars
  { title: 'Cars', quote: "Ka-chow!", speaker: "Lightning McQueen" },
  { title: 'Cars', quote: "I am speed", speaker: "Lightning McQueen" },
  
  // Up
  { title: 'Up', quote: "Adventure is out there!", speaker: "Charles Muntz" },
  { title: 'Up', quote: "Squirrel!", speaker: "Dug" },
  
  // Ratatouille
  { title: 'Ratatouille', quote: "Anyone can cook", speaker: "Gusteau" },
  
  // WALL-E
  { title: 'WALL-E', quote: "WALL-E", speaker: "WALL-E" },
  
  // Coco
  { title: 'Coco', quote: "Remember me", speaker: "Miguel" },
  
  // Inside Out
  { title: 'Inside Out', quote: "Take her to the moon for me", speaker: "Bing Bong" },
  
  // Guardians of the Galaxy
  { title: 'Guardians of the Galaxy', quote: "I am Groot", speaker: "Groot" },
  { title: 'Guardians of the Galaxy', quote: "We are Groot", speaker: "Groot" },
  
  // Iron Man
  { title: 'Iron Man', quote: "I am Iron Man", speaker: "Tony Stark" },
  
  // Thor
  { title: 'Thor', quote: "Another!", speaker: "Thor" },
  
  // Captain America
  { title: 'Captain America', quote: "I can do this all day", speaker: "Steve Rogers" },
  
  // Dune
  { title: 'Dune', quote: "Fear is the mind-killer", speaker: "Paul" },
  { title: 'Dune', quote: "The spice must flow", speaker: "Baron" },
  
  // Mad Max
  { title: 'Mad Max', quote: "What a lovely day!", speaker: "Nux" },
  { title: 'Mad Max', quote: "Witness me!", speaker: "Nux" },
  
  // Terminator 2
  { title: 'Terminator 2', quote: "Hasta la vista, baby", speaker: "Terminator" },
  { title: 'Terminator 2', quote: "I'll be back", speaker: "Terminator" },
  
  // The Princess Bride
  { title: 'The Princess Bride', quote: "Hello. My name is Inigo Montoya. You killed my father. Prepare to die", speaker: "Inigo Montoya" },
  { title: 'The Princess Bride', quote: "As you wish", speaker: "Westley" },
  { title: 'The Princess Bride', quote: "Inconceivable!", speaker: "Vizzini" },
  
  // Scarface
  { title: 'Scarface', quote: "Say hello to my little friend!", speaker: "Tony Montana" },
  
  // E.T.
  { title: 'E.T.', quote: "E.T. phone home", speaker: "E.T." },
  
  // Despicable Me
  { title: 'Despicable Me', quote: "It's so fluffy I'm gonna die!", speaker: "Agnes" },
  { title: 'Despicable Me', quote: "Banana!", speaker: "Minions" },
  
  // Madagascar
  { title: 'Madagascar', quote: "I like to move it, move it", speaker: "King Julien" },
  { title: 'Madagascar', quote: "Smile and wave, boys. Smile and wave", speaker: "Skipper" },
  
  // Bee Movie
  { title: 'Bee Movie', quote: "According to all known laws of aviation, there is no way a bee should be able to fly", speaker: "Barry" },
  { title: 'Bee Movie', quote: "Ya like jazz?", speaker: "Barry" },
];

async function addFamousQuotes() {
  console.log('🎬 Adding famous movie quotes to movie_dialogues table...\n');
  
  let added = 0;
  let skipped = 0;
  let notFound = 0;
  
  for (const quote of FAMOUS_QUOTES) {
    process.stdout.write(`Processing: "${quote.quote.substring(0, 40)}..." `);
    
    // Find movie in DB by title (case-insensitive partial match)
    const { data: movies, error: movieError } = await supabase
      .from('movies')
      .select('id, title')
      .ilike('title', `%${quote.title}%`)
      .limit(1);
    
    const movie = movies?.[0];
    
    if (movieError || !movie) {
      console.log(`⚠️ Movie not found: "${quote.title}"`);
      notFound++;
      continue;
    }
    
    // Check if quote already exists
    const { data: existing } = await supabase
      .from('movie_dialogues')
      .select('id')
      .eq('movie_id', movie.id)
      .eq('text', quote.quote)
      .single();
    
    if (existing) {
      console.log(`⏭️ Already exists`);
      skipped++;
      continue;
    }
    
    // Insert into movie_dialogues table (no embedding needed - uses full-text search)
    const { error: insertError } = await supabase
      .from('movie_dialogues')
      .insert({
        movie_id: movie.id,
        text: quote.quote,
        character_name: quote.speaker || null,
        source: 'famous_quote'
      });
    
    if (insertError) {
      console.log(`❌ Insert error: ${insertError.message}`);
    } else {
      console.log(`✅ Added to ${movie.title}`);
      added++;
    }
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  console.log('\n========================================');
  console.log(`✅ Added: ${added} quotes`);
  console.log(`⏭️ Skipped (already exist): ${skipped}`);
  console.log(`⚠️ Movies not found: ${notFound}`);
  console.log('========================================');
}

addFamousQuotes().catch(console.error);
