import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const TMDB_API_KEY = process.env.TMDB_API_KEY;

// GET /api/movies/[id]/cast - Get cast for a movie
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = await params;

  if (!TMDB_API_KEY) {
    return NextResponse.json(
      { error: 'TMDB API key not configured' },
      { status: 500 }
    );
  }

  try {
    // Get the movie from our database
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
        cast: [],
        message: 'No TMDB ID for this movie'
      });
    }

    // Check if we already have cast cached in movie_cast table
    const { data: cachedCast } = await supabaseAdmin
      .from('movie_cast')
      .select(`
        *,
        artist:artists(*)
      `)
      .eq('movie_id', id)
      .order('cast_order', { ascending: true })
      .limit(10);

    if (cachedCast && cachedCast.length > 0) {
      // Return cached cast
      const cast = cachedCast.map((mc: any) => ({
        id: mc.artist.id,
        tmdb_id: mc.artist.tmdb_id,
        name: mc.artist.name,
        character: mc.character_name,
        profile_url: mc.artist.profile_url,
        known_for_department: mc.artist.known_for_department,
      }));
      
      return NextResponse.json({ cast, cached: true });
    }

    // Fetch from TMDB - first determine if this is TV or Movie using search
    let creditsData: any = { cast: [] };
    let isTV = false;

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

    // Try the determined type first, then fall back to the other
    if (isTV) {
      // Try TV first
      const tvCreditsRes = await fetch(
        `https://api.themoviedb.org/3/tv/${movie.tmdb_id}/aggregate_credits?api_key=${TMDB_API_KEY}`
      );

      if (tvCreditsRes.ok) {
        const tvData = await tvCreditsRes.json();
        if (tvData.cast && tvData.cast.length > 0) {
          // TV aggregate credits have roles array
          creditsData.cast = tvData.cast.map((c: any) => ({
            ...c,
            character: c.roles?.[0]?.character || c.character || '',
          }));
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
      // Try Movie first
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
            creditsData.cast = tvData.cast.map((c: any) => ({
              ...c,
              character: c.roles?.[0]?.character || c.character || '',
            }));
          }
        }
      }
    }

    console.log(`📺 ${movie.title} - isTV: ${isTV}, cast count: ${creditsData.cast?.length || 0}`);

    // Get top 10 cast members
    const topCast = (creditsData.cast || [])
      .filter((c: any) => c.known_for_department === 'Acting')
      .slice(0, 10);

    // Save artists and movie_cast to database
    const castResults = [];

    for (const castMember of topCast) {
      // Check if artist already exists
      let { data: existingArtist } = await supabaseAdmin
        .from('artists')
        .select('*')
        .eq('tmdb_id', castMember.id)
        .single();

      let artistId: number;

      if (existingArtist) {
        artistId = existingArtist.id;
      } else {
        // Create new artist
        const newArtist = {
          tmdb_id: castMember.id,
          name: castMember.name,
          profile_url: castMember.profile_path
            ? `https://image.tmdb.org/t/p/w185${castMember.profile_path}`
            : null,
          known_for_department: castMember.known_for_department || 'Acting',
          popularity: castMember.popularity || 0,
        };

        const { data: insertedArtist, error: insertError } = await supabaseAdmin
          .from('artists')
          .insert(newArtist)
          .select()
          .single();

        if (insertError) {
          console.error('Failed to insert artist:', insertError);
          continue;
        }

        artistId = insertedArtist.id;
        existingArtist = insertedArtist;
      }

      // Create movie_cast relationship
      const characterName = isTV 
        ? (castMember.character || castMember.roles?.[0]?.character || '')
        : (castMember.character || '');

      await supabaseAdmin
        .from('movie_cast')
        .upsert({
          movie_id: parseInt(id),
          artist_id: artistId,
          character_name: characterName,
          cast_order: topCast.indexOf(castMember),
        }, {
          onConflict: 'movie_id,artist_id,character_name'
        });

      castResults.push({
        id: artistId,
        tmdb_id: castMember.id,
        name: castMember.name,
        character: characterName,
        profile_url: existingArtist?.profile_url || (castMember.profile_path
          ? `https://image.tmdb.org/t/p/w185${castMember.profile_path}`
          : null),
        known_for_department: castMember.known_for_department || 'Acting',
      });
    }

    console.log(`✅ Fetched ${castResults.length} cast members for ${movie.title}`);

    return NextResponse.json({
      cast: castResults,
      cached: false,
      isTV,
    });

  } catch (error: any) {
    console.error('Error fetching cast:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch cast' },
      { status: 500 }
    );
  }
}
