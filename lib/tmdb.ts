const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

export interface TMDBMovie {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  popularity: number;
  imdb_id?: string;
  media_type?: 'movie' | 'tv';
}

export interface TMDBTVShow {
  id: number;
  name: string;
  first_air_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  popularity: number;
  media_type?: 'tv';
}

export interface TMDBTrailer {
  key: string;
  site: string;
  type: string;
}

// Fetch popular movies from TMDB
export async function getPopularMovies(count: number = 100): Promise<TMDBMovie[]> {
  const apiKey = process.env.TMDB_API_KEY;
  const movies: TMDBMovie[] = [];
  const pages = Math.ceil(count / 20);

  for (let page = 1; page <= pages; page++) {
    const response = await fetch(
      `${TMDB_BASE_URL}/movie/popular?api_key=${apiKey}&page=${page}`
    );
    const data = await response.json();
    movies.push(...data.results);
  }

  return movies.slice(0, count);
}

// Get movie details including IMDB ID
export async function getMovieDetails(tmdbId: number): Promise<TMDBMovie> {
  const apiKey = process.env.TMDB_API_KEY;
  // Include external_ids to get imdb_id
  const response = await fetch(
    `${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${apiKey}&append_to_response=external_ids`
  );
  const data = await response.json();
  // Ensure imdb_id is at top level
  if (data.external_ids?.imdb_id) {
    data.imdb_id = data.external_ids.imdb_id;
  }
  return data;
}

// Get movie trailer
export async function getMovieTrailer(tmdbId: number): Promise<TMDBTrailer | null> {
  const apiKey = process.env.TMDB_API_KEY;
  const response = await fetch(
    `${TMDB_BASE_URL}/movie/${tmdbId}/videos?api_key=${apiKey}`
  );
  const data = await response.json();

  const trailer = data.results.find(
    (video: TMDBTrailer) =>
      video.site === 'YouTube' &&
      (video.type === 'Trailer' || video.type === 'Teaser')
  );

  return trailer || null;
}

// Get movie credits (cast)
export async function getMovieCast(tmdbId: number): Promise<any[]> {
  const apiKey = process.env.TMDB_API_KEY;
  const response = await fetch(
    `${TMDB_BASE_URL}/movie/${tmdbId}/credits?api_key=${apiKey}`
  );
  const data = await response.json();

  return data.cast.slice(0, 10); // Top 10 cast members
}

// Get TV show credits (cast)
export async function getTVShowCast(tmdbId: number): Promise<any[]> {
  const apiKey = process.env.TMDB_API_KEY;
  const response = await fetch(
    `${TMDB_BASE_URL}/tv/${tmdbId}/credits?api_key=${apiKey}`
  );
  const data = await response.json();

  return data.cast?.slice(0, 15) || []; // Top 15 cast members for TV
}

// Watch provider types
export interface WatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
  display_priority: number;
}

export interface WatchProviders {
  flatrate?: WatchProvider[];  // Subscription services (Netflix, Disney+, etc.)
  rent?: WatchProvider[];       // Rental options
  buy?: WatchProvider[];        // Purchase options
  free?: WatchProvider[];       // Free with ads
  ads?: WatchProvider[];        // Free with ads (alternate key)
  link?: string;                // JustWatch attribution link
}

/**
 * Get watch providers for a movie or TV show from TMDB
 * This returns REAL streaming data, not AI-generated
 */
export async function getWatchProviders(
  tmdbId: number,
  mediaType: 'movie' | 'tv' = 'movie',
  country: string = 'US'
): Promise<WatchProviders | null> {
  const apiKey = process.env.TMDB_API_KEY;
  
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/${mediaType}/${tmdbId}/watch/providers?api_key=${apiKey}`
    );
    
    if (!response.ok) {
      console.error(`TMDB watch providers error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    // Get providers for specified country (default: US)
    const countryData = data.results?.[country];
    
    if (!countryData) {
      console.log(`No watch providers found for ${mediaType} ${tmdbId} in ${country}`);
      return null;
    }
    
    return {
      flatrate: countryData.flatrate || [],
      rent: countryData.rent || [],
      buy: countryData.buy || [],
      free: countryData.free || countryData.ads || [],
      link: countryData.link || null,
    };
  } catch (error) {
    console.error('Failed to fetch watch providers:', error);
    return null;
  }
}

/**
 * Build full logo URL for a watch provider
 */
export function buildProviderLogoUrl(logoPath: string | null): string | null {
  if (!logoPath) return null;
  return `https://image.tmdb.org/t/p/w92${logoPath}`;
}

// Verify that ALL identified actors appear in a movie's cast
export async function verifyActorsInMovie(
  tmdbId: number, 
  identifiedActors: string[], 
  isTV: boolean = false
): Promise<{ verified: boolean; matchedActors: string[]; missingActors: string[] }> {
  if (identifiedActors.length === 0) {
    return { verified: true, matchedActors: [], missingActors: [] };
  }

  try {
    const cast = isTV ? await getTVShowCast(tmdbId) : await getMovieCast(tmdbId);
    const castNames = cast.map((c: any) => c.name?.toLowerCase() || '');
    
    const matchedActors: string[] = [];
    const missingActors: string[] = [];
    
    for (const actor of identifiedActors) {
      const actorLower = actor.toLowerCase();
      // Check if any cast member matches (partial matching for names like "Dwayne 'The Rock' Johnson")
      const found = castNames.some((name: string) => 
        name.includes(actorLower) || 
        actorLower.includes(name) ||
        // Handle first name + last name matching
        name.split(' ').some(part => actorLower.includes(part) && part.length > 3)
      );
      
      if (found) {
        matchedActors.push(actor);
      } else {
        missingActors.push(actor);
      }
    }
    
    // Verified only if ALL actors are found
    const verified = missingActors.length === 0;
    
    return { verified, matchedActors, missingActors };
  } catch (error) {
    console.error('  ⚠️ Cast verification failed:', error);
    // On error, don't block - assume verified
    return { verified: true, matchedActors: identifiedActors, missingActors: [] };
  }
}

// Build poster/backdrop URL
export function buildImageUrl(path: string | null, size: string = 'w500'): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

// Search TMDB for a movie by title and year
export async function searchMovie(title: string, year?: number | null): Promise<TMDBMovie | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️ TMDB API key not configured');
    return null;
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
  });
  
  if (year) {
    params.append('year', String(year));
  }

  try {
    const response = await fetch(`${TMDB_BASE_URL}/search/movie?${params}`);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return null;
    }

    // Get the first (best) match and fetch full details
    const bestMatch = data.results[0];
    const details = await getMovieDetails(bestMatch.id);
    
    return { ...details, media_type: 'movie' };
  } catch (error: any) {
    console.error('  ❌ TMDB search failed:', error.message);
    return null;
  }
}

// Search TMDB for a TV show by title and year
export async function searchTVShow(title: string, year?: number | null): Promise<TMDBTVShow | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️ TMDB API key not configured');
    return null;
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
  });
  
  if (year) {
    params.append('first_air_date_year', String(year));
  }

  try {
    const response = await fetch(`${TMDB_BASE_URL}/search/tv?${params}`);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return null;
    }

    // Get the first (best) match and fetch full details
    const bestMatch = data.results[0];
    const details = await getTVShowDetails(bestMatch.id);
    
    return { ...details, media_type: 'tv' };
  } catch (error: any) {
    console.error('  ❌ TMDB TV search failed:', error.message);
    return null;
  }
}

// Get TV show details
export async function getTVShowDetails(tmdbId: number): Promise<TMDBTVShow & { imdb_id?: string }> {
  const apiKey = process.env.TMDB_API_KEY;
  const response = await fetch(
    `${TMDB_BASE_URL}/tv/${tmdbId}?api_key=${apiKey}&append_to_response=external_ids`
  );
  const data = await response.json();
  return {
    id: data.id,
    name: data.name,
    first_air_date: data.first_air_date,
    poster_path: data.poster_path,
    backdrop_path: data.backdrop_path,
    overview: data.overview,
    popularity: data.popularity,
    media_type: 'tv',
    imdb_id: data.external_ids?.imdb_id || null, // Extract IMDB ID from external_ids
  };
}

// Search TMDB for BOTH movies and TV shows (multi-search)
export async function searchMulti(title: string, year?: number | null): Promise<(TMDBMovie | TMDBTVShow) | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️ TMDB API key not configured');
    return null;
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
  });

  try {
    const response = await fetch(`${TMDB_BASE_URL}/search/multi?${params}`);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return null;
    }

    // Filter to only movies and TV shows
    const mediaResults = data.results.filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv');
    
    if (mediaResults.length === 0) return null;
    
    const normalizedSearchTitle = title.toLowerCase().trim();
    
    // Priority matching:
    // 1. Exact title + exact year match
    // 2. Exact title match (any year)
    // 3. Year match with similar title
    // 4. First result
    
    let bestMatch = null;
    
    // 1. Exact title + exact year match
    if (year) {
      bestMatch = mediaResults.find((r: any) => {
        const itemTitle = (r.media_type === 'movie' ? r.title : r.name)?.toLowerCase().trim();
        const itemYear = r.media_type === 'movie' 
          ? parseInt(r.release_date?.substring(0, 4))
          : parseInt(r.first_air_date?.substring(0, 4));
        return itemTitle === normalizedSearchTitle && itemYear === year;
      });
      if (bestMatch) {
        console.log(`  ✓ TMDB: Exact title + year match`);
      }
    }
    
    // 2. Exact title match (any year) - important for cases like "Upgrade" vs "Upgraded"
    if (!bestMatch) {
      bestMatch = mediaResults.find((r: any) => {
        const itemTitle = (r.media_type === 'movie' ? r.title : r.name)?.toLowerCase().trim();
        return itemTitle === normalizedSearchTitle;
      });
      if (bestMatch) {
        console.log(`  ✓ TMDB: Exact title match`);
      }
    }
    
    // 3. Year match with similar title
    if (!bestMatch && year) {
      bestMatch = mediaResults.find((r: any) => {
        const itemYear = r.media_type === 'movie' 
          ? parseInt(r.release_date?.substring(0, 4))
          : parseInt(r.first_air_date?.substring(0, 4));
        return itemYear === year;
      });
      if (bestMatch) {
        console.log(`  ✓ TMDB: Year match`);
      }
    }
    
    // 4. Fall back to first result
    if (!bestMatch) {
      bestMatch = mediaResults[0];
      console.log(`  ⚠️ TMDB: Using first result (no exact match)`);
    }

    if (!bestMatch) return null;

    // Fetch full details based on media type
    if (bestMatch.media_type === 'movie') {
      const details = await getMovieDetails(bestMatch.id);
      return { ...details, media_type: 'movie' };
    } else if (bestMatch.media_type === 'tv') {
      const details = await getTVShowDetails(bestMatch.id);
      return { ...details, media_type: 'tv' };
    }

    return null;
  } catch (error: any) {
    console.error('  ❌ TMDB multi-search failed:', error.message);
    return null;
  }
}

// Search for a person (actor) by name
export async function searchPerson(name: string): Promise<{ id: number; name: string } | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      api_key: apiKey,
      query: name,
    });
    
    const response = await fetch(`${TMDB_BASE_URL}/search/person?${params}`);
    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      return { id: data.results[0].id, name: data.results[0].name };
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Get an actor's filmography (movies and TV shows)
export async function getActorFilmography(personId: number): Promise<Array<{
  id: number;
  title: string;
  year: number;
  media_type: 'movie' | 'tv';
  character?: string;
  popularity: number;
}>> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/person/${personId}/combined_credits?api_key=${apiKey}`
    );
    const data = await response.json();
    
    const results: Array<{
      id: number;
      title: string;
      year: number;
      media_type: 'movie' | 'tv';
      character?: string;
      popularity: number;
    }> = [];
    
    if (data.cast) {
      for (const item of data.cast) {
        const title = item.media_type === 'movie' ? item.title : item.name;
        const releaseDate = item.media_type === 'movie' ? item.release_date : item.first_air_date;
        const year = releaseDate ? parseInt(releaseDate.substring(0, 4)) : 0;
        
        if (title && year > 2010) { // Only recent works
          results.push({
            id: item.id,
            title,
            year,
            media_type: item.media_type,
            character: item.character,
            popularity: item.popularity || 0,
          });
        }
      }
    }
    
    // Sort by popularity (most popular first)
    return results.sort((a, b) => b.popularity - a.popularity);
  } catch (error) {
    return [];
  }
}

// Find movies/shows where multiple actors appear together
export async function findMoviesWithActors(actorNames: string[]): Promise<Array<{
  id: number;
  title: string;
  year: number;
  media_type: 'movie' | 'tv';
  matchedActors: string[];
  popularity: number;
}> | null> {
  if (actorNames.length === 0) return null;
  
  console.log(`  🔍 Searching TMDB for movies with actors: ${actorNames.join(', ')}`);
  
  // Talk shows, variety shows, news programs to exclude
  const excludedShowPatterns = [
    'tonight show', 'late show', 'late night', 'jimmy fallon', 'jimmy kimmel',
    'conan', 'ellen', 'graham norton', 'jonathan ross', 'james corden',
    'good morning', 'today show', 'entertainment tonight', 'access hollywood',
    'e! news', 'extra', 'inside edition', 'the view', 'live with',
    'saturday night live', 'snl', 'comic con', 'award', 'ceremony',
    'premiere', 'red carpet', 'interview', 'behind the scenes',
    'making of', 'documentary', 'themselves'
  ];
  
  // Get filmography for each actor
  const actorFilmographies = new Map<string, Array<{ id: number; title: string; year: number; media_type: 'movie' | 'tv'; popularity: number }>>();
  
  for (const actorName of actorNames.slice(0, 3)) { // Limit to top 3 actors
    const person = await searchPerson(actorName);
    if (person) {
      const filmography = await getActorFilmography(person.id);
      actorFilmographies.set(actorName, filmography);
      console.log(`    ✓ ${person.name}: ${filmography.length} credits`);
    }
  }
  
  if (actorFilmographies.size === 0) return null;
  
  // Find movies that appear in multiple filmographies
  const movieActorMap = new Map<number, { title: string; year: number; media_type: 'movie' | 'tv'; actors: string[]; popularity: number }>();
  
  for (const [actorName, filmography] of actorFilmographies) {
    for (const movie of filmography) {
      // Skip talk shows, variety shows, and other non-narrative content
      const titleLower = movie.title.toLowerCase();
      const isExcluded = excludedShowPatterns.some(pattern => titleLower.includes(pattern));
      if (isExcluded) continue;
      
      const existing = movieActorMap.get(movie.id);
      if (existing) {
        existing.actors.push(actorName);
      } else {
        movieActorMap.set(movie.id, {
          title: movie.title,
          year: movie.year,
          media_type: movie.media_type,
          actors: [actorName],
          popularity: movie.popularity,
        });
      }
    }
  }
  
  // Filter to movies with 2+ actors and sort by number of actors, then popularity
  const results = Array.from(movieActorMap.entries())
    .filter(([_, data]) => data.actors.length >= 2)
    .map(([id, data]) => ({
      id,
      title: data.title,
      year: data.year,
      media_type: data.media_type,
      matchedActors: data.actors,
      popularity: data.popularity,
    }))
    .sort((a, b) => {
      // First sort by number of matched actors
      if (b.matchedActors.length !== a.matchedActors.length) {
        return b.matchedActors.length - a.matchedActors.length;
      }
      // Prefer movies over TV shows (less likely to be talk shows)
      if (a.media_type !== b.media_type) {
        return a.media_type === 'movie' ? -1 : 1;
      }
      // Then by year (newer first)
      if (b.year !== a.year) {
        return b.year - a.year;
      }
      // Then by popularity
      return b.popularity - a.popularity;
    });
  
  if (results.length > 0) {
    console.log(`    ✓ Found ${results.length} movies with multiple identified actors`);
    results.slice(0, 3).forEach(r => {
      console.log(`      - "${r.title}" (${r.year}): ${r.matchedActors.join(', ')}`);
    });
  }
  
  return results.length > 0 ? results : null;
}