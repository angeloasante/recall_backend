import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const TMDB_API_KEY = process.env.TMDB_API_KEY!;

// Movies that actually go viral on TikTok/social media
const VIRAL_MOVIE_TITLES = [
  // Recent blockbusters
  'Avatar: The Way of Water', 'Avengers: Endgame', 'Spider-Man: No Way Home',
  'Top Gun: Maverick', 'Black Panther', 'Dune', 'Inception', 'Interstellar',
  'Avatar', 'The Batman', 'Oppenheimer', 'Barbie',
  
  // Animated (huge on TikTok)
  'Zootopia', 'Inside Out', 'Inside Out 2', 'Coco', 'Moana', 'Frozen', 'Frozen II',
  'Encanto', 'Spider-Man: Into the Spider-Verse', 'Spider-Man: Across the Spider-Verse',
  'The Lion King', 'Finding Nemo', 'Toy Story', 'Shrek', 'How to Train Your Dragon',
  'Despicable Me', 'Minions', 'Kung Fu Panda', 'Ratatouille', 'WALL·E', 'Up',
  
  // Action/Sci-fi
  'The Matrix', 'John Wick', 'John Wick: Chapter 4', 'Mad Max: Fury Road',
  'Blade Runner 2049', 'The Dark Knight', 'Fight Club', 'Pulp Fiction',
  'Kill Bill: Volume 1', 'Gladiator', 'The Lord of the Rings: The Fellowship of the Ring',
  'The Lord of the Rings: The Return of the King', 'Star Wars: Episode IV',
  'Jurassic Park', 'Terminator 2: Judgment Day', 'Aliens', 'Predator',
  
  // Horror (viral scenes)
  'Get Out', 'A Quiet Place', 'A Quiet Place Part II', 'Hereditary', 'Midsommar',
  'The Conjuring', 'It', 'The Shining', 'Scream', 'Halloween', 'The Exorcist',
  'Us', 'Nope', 'M3GAN', 'Five Nights at Freddys',
  
  // Drama (quotable)
  'The Shawshank Redemption', 'Forrest Gump', 'The Godfather', 'The Godfather Part II',
  'Parasite', 'Everything Everywhere All at Once', 'Whiplash', 'La La Land',
  'Titanic', 'The Notebook', 'A Star Is Born', 'The Greatest Showman',
  
  // Comedy
  'Superbad', 'The Hangover', 'Step Brothers', 'Mean Girls', 'Bridesmaids',
  'Pitch Perfect', '21 Jump Street', 'Tropic Thunder', 'Anchorman',
  
  // Recent hits
  'Guardians of the Galaxy Vol. 3', 'The Super Mario Bros. Movie', 'Wonka',
  'Ant-Man and the Wasp: Quantumania', 'The Little Mermaid', 'Elemental',
  'Teenage Mutant Ninja Turtles: Mutant Mayhem', 'Mission: Impossible - Dead Reckoning',
  'Fast X', 'Transformers: Rise of the Beasts', 'The Hunger Games', 'Divergent',
  'Twilight', 'Harry Potter and the Sorcerers Stone', 'Harry Potter and the Deathly Hallows: Part 2',
];

async function searchTMDB(title: string) {
  const response = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
  );
  const data = await response.json();
  return data.results?.[0]; // First result
}

async function addViralMovies() {
  console.log(`🔥 Adding ${VIRAL_MOVIE_TITLES.length} viral movies...\n`);
  
  let added = 0;
  let failed = 0;
  
  for (const title of VIRAL_MOVIE_TITLES) {
    try {
      const movie = await searchTMDB(title);
      
      if (!movie) {
        console.log(`  ⚠️  Not found: ${title}`);
        failed++;
        continue;
      }
      
      const { error } = await supabase
        .from('movies')
        .upsert({
          tmdb_id: movie.id,
          title: movie.title,
          year: movie.release_date ? new Date(movie.release_date).getFullYear() : null,
          poster_url: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
          backdrop_url: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : null,
          overview: movie.overview,
          popularity: (movie.popularity || 100) * 2, // Boost viral movies
        }, { onConflict: 'tmdb_id' });
      
      if (error) {
        console.error(`  ❌ ${title}:`, error.message);
        failed++;
      } else {
        console.log(`  ✅ ${movie.title} (${movie.release_date?.slice(0, 4) || 'N/A'})`);
        added++;
      }
      
      await new Promise(r => setTimeout(r, 250)); // Rate limit
      
    } catch (error: any) {
      console.error(`  ❌ ${title}:`, error.message);
      failed++;
    }
  }
  
  console.log(`\n🎉 Viral movies added! (${added} added, ${failed} failed)`);
}

addViralMovies().catch(console.error);
