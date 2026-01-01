import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import OpenAI from 'openai';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Generate a biography using OpenAI when TMDB doesn't have one
async function generateBiography(
  name: string,
  birthday: string | null,
  birthplace: string | null,
  knownFor: string[],
  department: string
): Promise<string | null> {
  try {
    const knownForText = knownFor.length > 0 
      ? `They are known for: ${knownFor.slice(0, 5).join(', ')}.`
      : '';
    
    const birthdayText = birthday 
      ? `Born on ${new Date(birthday).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : '';
    
    const birthplaceText = birthplace 
      ? `From ${birthplace}.`
      : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that writes brief, factual biographies for actors and entertainers. 
Write in third person, keep it to 2-3 sentences, and only include verifiable facts.
Do not make up awards, relationships, or career details that aren't provided.
If you don't have enough information, write a simple factual statement based on what is known.`
        },
        {
          role: 'user',
          content: `Write a brief biography for ${name}, who works in ${department}. ${birthdayText} ${birthplaceText} ${knownForText}

Keep it factual and concise. Only mention what is definitely known.`
        }
      ],
      max_tokens: 200,
      temperature: 0.3, // Lower temperature for more factual output
    });

    const bio = response.choices[0]?.message?.content?.trim();
    console.log(`✨ Generated biography for ${name}: ${bio?.substring(0, 50)}...`);
    return bio || null;
  } catch (error) {
    console.error('Failed to generate biography:', error);
    return null;
  }
}

// GET /api/artists/[id] - Get artist details and filmography
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
    // Get artist from our database
    const { data: artist, error: artistError } = await supabaseAdmin
      .from('artists')
      .select('*')
      .eq('id', id)
      .single();

    if (artistError || !artist) {
      return NextResponse.json(
        { error: 'Artist not found' },
        { status: 404 }
      );
    }

    // Fetch full details from TMDB if biography is missing
    let fullArtist = artist;
    let knownForTitles: string[] = [];
    
    if (!artist.biography && artist.tmdb_id) {
      const personRes = await fetch(
        `https://api.themoviedb.org/3/person/${artist.tmdb_id}?api_key=${TMDB_API_KEY}`
      );

      if (personRes.ok) {
        const personData = await personRes.json();
        
        // Get known_for titles from TMDB
        const searchRes = await fetch(
          `https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(artist.name)}`
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const match = searchData.results?.find((r: any) => r.id === artist.tmdb_id);
          if (match?.known_for) {
            knownForTitles = match.known_for.map((kf: any) => kf.title || kf.name).filter(Boolean);
          }
        }

        let biography = personData.biography || null;
        
        // If TMDB has no biography, generate one with OpenAI
        if (!biography && process.env.OPENAI_API_KEY) {
          biography = await generateBiography(
            artist.name,
            personData.birthday,
            personData.place_of_birth,
            knownForTitles,
            personData.known_for_department || 'Acting'
          );
        }
        
        // Update artist with full details
        const updateData = {
          biography: biography,
          birthday: personData.birthday || null,
          birthplace: personData.place_of_birth || null,
          imdb_id: personData.imdb_id || null,
          updated_at: new Date().toISOString(),
        };

        const { data: updated } = await supabaseAdmin
          .from('artists')
          .update(updateData)
          .eq('id', id)
          .select()
          .single();

        if (updated) {
          fullArtist = updated;
        }
      }
    }

    // Get artist's filmography from our database (movies they're in)
    const { data: movieCast } = await supabaseAdmin
      .from('movie_cast')
      .select(`
        character_name,
        movie:movies(*)
      `)
      .eq('artist_id', id)
      .order('cast_order', { ascending: true });

    const knownFor = (movieCast || []).map((mc: any) => ({
      ...mc.movie,
      character: mc.character_name,
    }));

    // If we don't have many movies, fetch from TMDB
    if (knownFor.length < 5 && artist.tmdb_id) {
      const creditsRes = await fetch(
        `https://api.themoviedb.org/3/person/${artist.tmdb_id}/combined_credits?api_key=${TMDB_API_KEY}`
      );

      if (creditsRes.ok) {
        const creditsData = await creditsRes.json();
        
        // Get recent, popular MOVIES only (not TV shows) they were in
        const recentCredits = (creditsData.cast || [])
          .filter((c: any) => {
            // Only include movies, not TV shows
            if (c.media_type === 'tv') return false;
            
            const releaseDate = c.release_date || c.first_air_date;
            if (!releaseDate || !c.poster_path) return false;
            const year = parseInt(releaseDate.split('-')[0]);
            return year >= 2010; // Movies from 2010+
          })
          .sort((a: any, b: any) => (b.popularity || 0) - (a.popularity || 0))
          .slice(0, 12);

        // Add these to our database and return them
        for (const credit of recentCredits) {
          // Check if movie exists
          let { data: existingMovie } = await supabaseAdmin
            .from('movies')
            .select('*')
            .eq('tmdb_id', credit.id)
            .single();

          if (!existingMovie) {
            // Fetch full details to get IMDB ID
            let imdbId = null;
            
            try {
              // Fetch movie details to get IMDB ID
              const detailsRes = await fetch(
                `https://api.themoviedb.org/3/movie/${credit.id}?api_key=${TMDB_API_KEY}`
              );
              const detailsData = await detailsRes.json();
              imdbId = detailsData.imdb_id || null;
            } catch (e) {
              console.log('Failed to get IMDB ID');
            }

            const newMovie = {
              title: credit.title || credit.name,
              year: (credit.release_date || credit.first_air_date)
                ? parseInt((credit.release_date || credit.first_air_date).split('-')[0])
                : null,
              overview: credit.overview,
              poster_url: credit.poster_path
                ? `https://image.tmdb.org/t/p/w500${credit.poster_path}`
                : null,
              backdrop_url: credit.backdrop_path
                ? `https://image.tmdb.org/t/p/w1280${credit.backdrop_path}`
                : null,
              tmdb_id: credit.id,
              imdb_id: imdbId,
              popularity: credit.popularity || 0,
            };

            const { data: inserted } = await supabaseAdmin
              .from('movies')
              .insert(newMovie)
              .select()
              .single();

            if (inserted) {
              existingMovie = inserted;
              console.log(`✅ Added movie from artist credits: ${newMovie.title}`);
            }
          }

          // Add movie_cast relationship if movie exists
          if (existingMovie) {
            await supabaseAdmin
              .from('movie_cast')
              .upsert({
                movie_id: existingMovie.id,
                artist_id: parseInt(id),
                character_name: credit.character || '',
                cast_order: recentCredits.indexOf(credit),
              }, {
                onConflict: 'movie_id,artist_id,character_name'
              });

            // Add to knownFor if not already there
            if (!knownFor.find((m: any) => m.id === existingMovie.id)) {
              knownFor.push({
                ...existingMovie,
                character: credit.character || '',
              });
            }
          }
        }
      }
    }

    // Sort by year (newest first) and limit
    const sortedFilmography = knownFor
      .sort((a: any, b: any) => (b.year || 0) - (a.year || 0))
      .slice(0, 12);

    return NextResponse.json({
      artist: fullArtist,
      filmography: sortedFilmography,
    });

  } catch (error: any) {
    console.error('Error fetching artist:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch artist' },
      { status: 500 }
    );
  }
}
