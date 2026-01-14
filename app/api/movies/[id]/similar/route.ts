import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// Minimum year for "recent" movies
const MIN_YEAR = 2015;

// GET /api/movies/[id]/similar - Get similar movies/shows based on lead actors
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = await params;
  const TMDB_API_KEY = process.env.TMDB_API_KEY;

  if (!TMDB_API_KEY) {
    return NextResponse.json(
      { error: 'TMDB API key not configured' },
      { status: 500 }
    );
  }

  try {
    // First, get the movie from our database to get tmdb_id
    const { data: movie, error: movieError } = await supabaseAdmin
      .from('movies')
      .select('*')
      .eq('id', id)
      .single();

    if (movieError || !movie) {
      return NextResponse.json(
        { error: 'Movie not found' },
        { status: 404 }
      );
    }

    if (!movie.tmdb_id) {
      return NextResponse.json({
        similar: [],
        message: 'No TMDB ID for this movie'
      });
    }

    // ========== CHECK CACHE FIRST ==========
    // Check if we have cached similar movie IDs (stored as JSON array in movie record)
    if (movie.similar_ids && Array.isArray(movie.similar_ids) && movie.similar_ids.length > 0) {
      // Fetch the cached similar movies by their IDs
      const { data: cachedSimilar } = await supabaseAdmin
        .from('movies')
        .select('*')
        .in('id', movie.similar_ids)
        .limit(6);
      
      if (cachedSimilar && cachedSimilar.length > 0) {
        console.log(`⚡ [Similar] Returning ${cachedSimilar.length} cached similar for "${movie.title}"`);
        return NextResponse.json({
          similar: cachedSimilar,
          cached: true,
        });
      }
    }

    // ========== FETCH FROM TMDB (not cached) ==========
    console.log(`🔍 [Similar] Fetching from TMDB for "${movie.title}"...`);
    
    // Try to determine if this is a TV show or movie using multi-search first
    let isTV = false;
    let creditsData: any = { cast: [] };

    // Use multi-search to find the correct media type
    const searchQuery = encodeURIComponent(movie.title);
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${searchQuery}`
    );
    
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      // Find the result matching our tmdb_id
      const match = searchData.results?.find((r: any) => r.id === movie.tmdb_id);
      if (match) {
        isTV = match.media_type === 'tv';
        console.log(`🔍 Found ${movie.title} as ${match.media_type} via search`);
      }
    }

    // Fetch credits based on determined type
    if (isTV) {
      // Try TV first
      const tvCreditsRes = await fetch(
        `https://api.themoviedb.org/3/tv/${movie.tmdb_id}/aggregate_credits?api_key=${TMDB_API_KEY}`
      );
      
      if (tvCreditsRes.ok) {
        const tvData = await tvCreditsRes.json();
        if (tvData.cast && tvData.cast.length > 0) {
          creditsData = tvData;
        }
      }
      
      // Fallback to movie if TV had no cast
      if (!creditsData.cast || creditsData.cast.length === 0) {
        const movieCreditsRes = await fetch(
          `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/credits?api_key=${TMDB_API_KEY}`
        );
        if (movieCreditsRes.ok) {
          creditsData = await movieCreditsRes.json();
          if (creditsData.cast?.length > 0) isTV = false;
        }
      }
    } else {
      // Try movie first
      const movieCreditsRes = await fetch(
        `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/credits?api_key=${TMDB_API_KEY}`
      );
      
      if (movieCreditsRes.ok) {
        creditsData = await movieCreditsRes.json();
      }
      
      // Fallback to TV if movie had no cast
      if (!creditsData.cast || creditsData.cast.length === 0) {
        const tvCreditsRes = await fetch(
          `https://api.themoviedb.org/3/tv/${movie.tmdb_id}/aggregate_credits?api_key=${TMDB_API_KEY}`
        );
        
        if (tvCreditsRes.ok) {
          const tvData = await tvCreditsRes.json();
          if (tvData.cast && tvData.cast.length > 0) {
            isTV = true;
            creditsData = tvData;
          }
        }
      }
    }

    // Get top 3 lead actors (by billing order)
    const leadActors = (creditsData.cast || [])
      .filter((c: any) => c.known_for_department === 'Acting')
      .slice(0, 3);

    console.log(`📺 ${movie.title} - isTV: ${isTV}, found ${leadActors.length} lead actors`);

    // Titles to exclude (talk shows, interviews, etc.)
    const excludeTitles = /kelly clarkson|hot ones|interview|talk show|late night|tonight show|jimmy|conan|ellen|graham norton|drew barrymore|variety|actors on actors|behind the scenes|making of|saturday night live|snl|the view|good morning|today show|live with|watch what happens/i;

    let similarFromTMDB: any[] = [];

    if (leadActors.length > 0) {
      // Get movies/shows for each lead actor
      for (const actor of leadActors) {
        // Get combined credits (movies + TV)
        const personRes = await fetch(
          `https://api.themoviedb.org/3/person/${actor.id}/combined_credits?api_key=${TMDB_API_KEY}`
        );
        const personData = await personRes.json();

        // Get their acting credits, filter recent ones, sorted by popularity
        const actorCredits = (personData.cast || [])
          .filter((m: any) => {
            const releaseDate = m.release_date || m.first_air_date;
            if (!releaseDate) return false;
            
            const year = parseInt(releaseDate.split('-')[0]);
            const tmdbId = m.id;
            const title = m.title || m.name || '';
            
            // Exclude talk shows and interviews
            if (excludeTitles.test(title)) return false;
            
            // Exclude if genre_ids contains 10767 (Talk) or 10763 (News)
            const excludeGenres = [10767, 10763];
            if (m.genre_ids && m.genre_ids.some((g: number) => excludeGenres.includes(g))) return false;
            
            return (
              tmdbId !== movie.tmdb_id && // Exclude current movie/show
              m.poster_path && // Must have poster
              year >= MIN_YEAR // Only recent (2015+)
            );
          })
          .map((m: any) => ({
            ...m,
            title: m.title || m.name,
            release_date: m.release_date || m.first_air_date,
            isTV: m.media_type === 'tv',
          }))
          .sort((a: any, b: any) => (b.popularity || 0) - (a.popularity || 0))
          .slice(0, 4);

        similarFromTMDB.push(...actorCredits);
      }
    }

    // If still no results, try TMDB's similar endpoint
    if (similarFromTMDB.length === 0) {
      const endpoint = isTV ? 'tv' : 'movie';
      const similarRes = await fetch(
        `https://api.themoviedb.org/3/${endpoint}/${movie.tmdb_id}/similar?api_key=${TMDB_API_KEY}`
      );
      
      if (similarRes.ok) {
        const similarData = await similarRes.json();
        similarFromTMDB = (similarData.results || [])
          .filter((m: any) => {
            const releaseDate = m.release_date || m.first_air_date;
            if (!releaseDate || !m.poster_path) return false;
            const year = parseInt(releaseDate.split('-')[0]);
            return year >= MIN_YEAR;
          })
          .map((m: any) => ({
            ...m,
            title: m.title || m.name,
            release_date: m.release_date || m.first_air_date,
            isTV: endpoint === 'tv',
          }))
          .slice(0, 6);
      }
    }

    // Remove duplicates by TMDB ID and limit to 6
    const uniqueTMDBItems = similarFromTMDB.filter((m, index, self) =>
      index === self.findIndex((t) => t.id === m.id)
    ).slice(0, 6);

    console.log(`🎬 Found ${uniqueTMDBItems.length} similar items for ${movie.title}`);

    // Now, for each similar item, check if it exists in our database or add it
    const similarMovies = [];

    for (const tmdbItem of uniqueTMDBItems) {
      // Check if exists in our database
      const { data: existingMovie } = await supabaseAdmin
        .from('movies')
        .select('*')
        .eq('tmdb_id', tmdbItem.id)
        .single();

      if (existingMovie) {
        similarMovies.push(existingMovie);
      } else {
        // Fetch full details to get imdb_id
        let imdbId = null;
        const detailEndpoint = tmdbItem.isTV ? 'tv' : 'movie';
        
        try {
          if (tmdbItem.isTV) {
            // TV shows need external_ids endpoint
            const extRes = await fetch(
              `https://api.themoviedb.org/3/tv/${tmdbItem.id}/external_ids?api_key=${TMDB_API_KEY}`
            );
            const extData = await extRes.json();
            imdbId = extData.imdb_id || null;
          } else {
            const detailsRes = await fetch(
              `https://api.themoviedb.org/3/movie/${tmdbItem.id}?api_key=${TMDB_API_KEY}`
            );
            const detailsData = await detailsRes.json();
            imdbId = detailsData.imdb_id || null;
          }
        } catch (e) {
          console.log('Failed to fetch IMDB ID for:', tmdbItem.title);
        }

        // Add to our database
        const newMovie = {
          title: tmdbItem.title,
          year: tmdbItem.release_date ? parseInt(tmdbItem.release_date.split('-')[0]) : null,
          overview: tmdbItem.overview,
          poster_url: tmdbItem.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbItem.poster_path}` : null,
          backdrop_url: tmdbItem.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbItem.backdrop_path}` : null,
          tmdb_id: tmdbItem.id,
          imdb_id: imdbId,
          popularity: tmdbItem.popularity || 0,
        };

        const { data: insertedMovie, error: insertError } = await supabaseAdmin
          .from('movies')
          .insert(newMovie)
          .select()
          .single();

        if (insertedMovie) {
          console.log(`✅ Added similar to database: ${tmdbItem.title} (${newMovie.year})`);
          similarMovies.push(insertedMovie);
        } else if (insertError) {
          console.error('Failed to insert similar:', insertError);
        }
      }
    }

    // ========== CACHE THE RESULTS ==========
    // Store the similar movie IDs for future instant retrieval
    if (similarMovies.length > 0) {
      const similarIds = similarMovies.map((m: any) => m.id);
      await supabaseAdmin
        .from('movies')
        .update({ similar_ids: similarIds })
        .eq('id', id);
      console.log(`💾 [Similar] Cached ${similarIds.length} similar IDs for "${movie.title}"`);
    }

    return NextResponse.json({
      similar: similarMovies,
      leadActors: leadActors.map((a: any) => a.name),
      isTV,
    });

  } catch (error: any) {
    console.error('Error fetching similar movies:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch similar movies' },
      { status: 500 }
    );
  }
}
