import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Helper function to get placeholder poster for unreleased movies
async function getMoviePosterFallback(title: string, year: number | null, actorName?: string): Promise<string | null> {
  // Try Google Custom Search API if configured
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    try {
      const searchQuery = `${title} ${year || ''} movie poster official`;
      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_CX}&searchType=image&q=${encodeURIComponent(searchQuery)}&num=1&imgType=photo`
      );
      const data = await response.json();
      
      if (data.items && data.items.length > 0) {
        console.log(`✓ Found poster via Google: ${data.items[0].link}`);
        return data.items[0].link;
      }
    } catch (e) {
      console.log('Google image search failed:', e);
    }
  }
  
  // Use a styled placeholder URL (uses DiceBear API for consistent placeholders)
  // This creates a nice gradient placeholder with the movie initials
  const initials = title.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(title)}&size=500&background=1a1a2e&color=e2e8f0&bold=true&format=png`;
}

// Helper function to save search result to user_uploads
async function saveSearchToHistory(movieId: number, source: string = 'voice_search'): Promise<void> {
  try {
    const { error } = await supabase
      .from('user_uploads')
      .insert({
        result_movie_id: movieId,
        confidence_score: 0.95,
        video_url: `${source}://${Date.now()}`, // Pseudo URL to track source
        matched_signals: { source, timestamp: new Date().toISOString() },
      });
    
    if (error) {
      console.log('⚠️ Could not save to history:', error.message);
    } else {
      console.log('✅ Saved to Recently Found history');
    }
  } catch (e) {
    console.log('⚠️ History save failed:', e);
  }
}

interface MovieResult {
  id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
}

export async function POST(request: NextRequest) {
  try {
    const { description } = await request.json();

    if (!description || typeof description !== 'string') {
      return NextResponse.json(
        { error: 'Description is required' },
        { status: 400 }
      );
    }

    console.log('🔍 Searching for movie by description:', description);

    // Step 1: Use GPT to interpret the description and identify the EXACT movie/show
    // First, check if user is asking for "latest" content by an actor - GPT won't know recent releases
    const isAskingForLatest = /latest|newest|recent|new|2024|2025/i.test(description);
    
    // Check if user specifically wants RELEASED movies only (not upcoming)
    const wantsReleasedOnly = /released|out now|already out|came out|in theaters|streaming/i.test(description);
    
    // Use GPT to extract the actor/celebrity name if asking for latest
    let actorName: string | null = null;
    
    if (isAskingForLatest) {
      try {
        const extractResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Extract the person's name from this movie/show request. The name might be misspelled by speech recognition.

IMPORTANT: 
- If you see a name that SOUNDS like a celebrity, correct the spelling and return the real name
- "Calvin Hart" → "Kevin Hart" (sounds like Kevin Hart)
- "Dwayne Johnson" or "The Rock" → "Dwayne Johnson"
- "Tom Cruise" → "Tom Cruise"
- "Leonardo DiCaprio" → "Leonardo DiCaprio"

Return ONLY the corrected full name, nothing else. If truly no person name found, return "NONE".`,
            },
            { role: 'user', content: description },
          ],
          temperature: 0,
          max_tokens: 50,
        });
        
        const extractedName = extractResponse.choices[0]?.message?.content?.trim();
        console.log(`🎭 GPT extracted name: "${extractedName}" from "${description}"`);
        if (extractedName && extractedName !== 'NONE') {
          actorName = extractedName;
        }
      } catch (e) {
        console.log('Actor extraction failed:', e);
      }
    }
    
    console.log(`🔍 Asking for latest: ${isAskingForLatest}, Released only: ${wantsReleasedOnly}, Actor detected: ${actorName}`);
    
    // If asking for latest by an actor, search TMDB directly first
    if (isAskingForLatest && actorName) {
      console.log(`🎬 User asking for LATEST${wantsReleasedOnly ? ' RELEASED' : ''} by actor: ${actorName}`);
      
      try {
        // Search for the person on TMDB
        const personResponse = await fetch(
          `https://api.themoviedb.org/3/search/person?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(actorName)}`
        );
        const personData = await personResponse.json();
        
        if (personData.results && personData.results.length > 0) {
          const person = personData.results[0];
          console.log(`✓ Found person: ${person.name} (ID: ${person.id})`);
          
          // Get their combined credits (movies + TV)
          const creditsResponse = await fetch(
            `https://api.themoviedb.org/3/person/${person.id}/combined_credits?api_key=${process.env.TMDB_API_KEY}`
          );
          const creditsData = await creditsResponse.json();
          
          // Check if user is asking specifically for movies (not TV shows)
          // Be careful: "Show me" should NOT match as "tv show" - use word boundaries
          const wantsMoviesOnly = /movie|film/i.test(description) && !/\b(tv show|tv series|series|television)\b/i.test(description);
          
          // Sort by release date (newest first) and filter valid entries
          // IMPORTANT: Prioritize CAST credits (acting) over CREW (producing/directing)
          const today = new Date();
          
          // Genres/keywords to exclude (talk shows, documentaries about themselves, interviews)
          const excludeTitles = /actors on actors|interview|behind the scenes|making of|talk show|late night|tonight show|jimmy|conan|ellen|graham norton|variety/i;
          
          // First, get acting credits only (cast)
          let actingCredits = (creditsData.cast || [])
            .filter((c: any) => c.release_date || c.first_air_date)
            // Filter out talk shows, interviews, etc.
            .filter((c: any) => {
              const title = c.title || c.name || '';
              return !excludeTitles.test(title);
            })
            .filter((c: any) => {
              // If user specifically wants movies, filter out TV (use media_type strictly)
              if (wantsMoviesOnly) {
                // ONLY allow media_type === 'movie', nothing else
                return c.media_type === 'movie';
              }
              return true;
            })
            .map((c: any) => ({
              ...c,
              date: c.release_date || c.first_air_date,
              title: c.title || c.name,
              isTV: c.media_type === 'tv',
              isActing: true,
            }))
            // If user wants released only, filter out future releases
            .filter((c: any) => {
              if (wantsReleasedOnly) {
                return new Date(c.date) <= today;
              }
              return true;
            })
            .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
          
          console.log(`📋 Found ${actingCredits.length} acting credits${wantsMoviesOnly ? ' (MOVIES only)' : ''}${wantsReleasedOnly ? ' (released only)' : ''}`);
          console.log(`   wantsMoviesOnly=${wantsMoviesOnly}, wantsReleasedOnly=${wantsReleasedOnly}`);
          if (actingCredits.length > 0) {
            console.log(`   Top 3: ${actingCredits.slice(0, 3).map((c: any) => `${c.title} (${c.date})`).join(', ')}`);
          }
          
          // Use acting credits 
          const allCredits = actingCredits;
          
          // Get the latest one
          let latest = allCredits[0];
          if (latest) {
            console.log(`✓ Latest ${latest.isTV ? 'TV show' : 'movie'} (acting): ${latest.title} (${latest.date})`);
            // If poster is missing, fetch full details from TMDB
            if (!latest.poster_path) {
              console.log(`⚠️ No poster in credits, fetching full details for ${latest.title}...`);
              const detailsEndpoint = latest.isTV ? 'tv' : 'movie';
              const detailsResponse = await fetch(
                `https://api.themoviedb.org/3/${detailsEndpoint}/${latest.id}?api_key=${process.env.TMDB_API_KEY}`
              );
              const details = await detailsResponse.json();
              if (details.poster_path) {
                latest.poster_path = details.poster_path;
                console.log(`✓ Found poster from details: ${details.poster_path}`);
              } else {
                // Still no poster - this is an unreleased movie, try fallback
                console.log(`⚠️ No poster even in full details - trying fallback...`);
                const fallbackUrl = await getMoviePosterFallback(latest.title, parseInt(latest.date?.split('-')[0]), actorName || undefined);
                if (fallbackUrl) {
                  latest.poster_path = fallbackUrl; // Use full URL directly
                  latest.poster_is_fallback = true;
                }
              }
              if (details.backdrop_path) {
                latest.backdrop_path = details.backdrop_path;
              }
              if (details.overview) {
                latest.overview = details.overview;
              }
            }
          }
          if (latest) {
            // Check if it's unreleased (release date is in the future)
            const releaseDate = latest.date;
            const isUnreleased = new Date(releaseDate) > new Date();
            
            // Check if in our database or add it
            const { data: existing } = await supabase
              .from('movies')
              .select('*')
              .eq('tmdb_id', latest.id)
              .single();
            
            if (existing) {
              // Save to history so it shows in Recently Found
              await saveSearchToHistory(existing.id, 'voice_search_actor');
              
              // Add release info to response
              return NextResponse.json({
                found: true,
                movies: [{
                  ...existing,
                  release_date: releaseDate,
                  is_unreleased: isUnreleased,
                }],
                suggestions: [{ title: latest.title, year: parseInt(latest.date.split('-')[0]), reason: `Latest ${latest.isTV ? 'TV show' : 'movie'} by ${person.name}` }],
              });
            } else {
              // Build poster URL - check if it's already a full URL (fallback) or TMDB path
              let posterUrl = null;
              if (latest.poster_path) {
                posterUrl = latest.poster_is_fallback 
                  ? latest.poster_path // Already a full URL from fallback
                  : `https://image.tmdb.org/t/p/w500${latest.poster_path}`; // TMDB path
              }
              
              // Fetch full details to get imdb_id
              let imdbId = null;
              try {
                const detailsType = latest.isTV ? 'tv' : 'movie';
                const detailsUrl = latest.isTV 
                  ? `https://api.themoviedb.org/3/tv/${latest.id}/external_ids?api_key=${process.env.TMDB_API_KEY}`
                  : `https://api.themoviedb.org/3/movie/${latest.id}?api_key=${process.env.TMDB_API_KEY}`;
                const detailsRes = await fetch(detailsUrl);
                const detailsJson = await detailsRes.json();
                imdbId = detailsJson.imdb_id || null;
                console.log(`✓ Fetched IMDB ID: ${imdbId}`);
              } catch (e) {
                console.log('Failed to fetch IMDB ID:', e);
              }
              
              // Add to database with release_date
              const newMovie = {
                title: latest.title,
                year: latest.date ? parseInt(latest.date.split('-')[0]) : null,
                overview: latest.overview,
                poster_url: posterUrl,
                backdrop_url: latest.backdrop_path ? `https://image.tmdb.org/t/p/w1280${latest.backdrop_path}` : null,
                tmdb_id: latest.id,
                imdb_id: imdbId,
                popularity: latest.popularity || 0,
                release_date: releaseDate, // Store full release date
              };
              
              const { data: inserted } = await supabase
                .from('movies')
                .insert(newMovie)
                .select()
                .single();
              
              if (inserted) {
                console.log(`✅ Added to database: ${latest.title} (${isUnreleased ? 'UNRELEASED - ' + releaseDate : 'Released'})`);
                
                // Save to history so it shows in Recently Found
                await saveSearchToHistory(inserted.id, 'voice_search_actor');
                
                return NextResponse.json({
                  found: true,
                  movies: [{
                    ...inserted,
                    release_date: releaseDate,
                    is_unreleased: isUnreleased,
                  }],
                  suggestions: [{ title: latest.title, year: parseInt(latest.date.split('-')[0]), reason: `${isUnreleased ? '🔜 Coming ' + releaseDate + ' - ' : ''}Latest ${latest.isTV ? 'TV show' : 'movie'} by ${person.name}` }],
                });
              }
            }
          }
        }
      } catch (tmdbError) {
        console.error('TMDB actor search error:', tmdbError);
        // Fall through to GPT if TMDB fails
      }
    }
    
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-4o',  // Use GPT-4o for better accuracy
      messages: [
        {
          role: 'system',
          content: `You are a movie and TV show identification expert. The user will describe something they saw - identify the EXACT real movie or TV show.

CRITICAL RULES:
1. NEVER make up or invent movie/show titles that don't exist
2. Only suggest REAL movies/shows that actually exist
3. When user mentions a celebrity name (actor, rapper, comedian), search your knowledge for shows/movies they've been in
4. Pay attention to platform mentions (Netflix, HBO, TikTok clips = could be any platform)

Examples of REAL shows/movies by celebrities:
- "Vince Staples" + "Netflix" + "show" = "The Vince Staples Show" (2024, Netflix comedy series)
- "Dave Chappelle" + "show" = "Chappelle's Show" or his Netflix specials
- "Kevin Hart" = various movies and "Real Husbands of Hollywood"
- "Raymond Reddington" = "The Blacklist" (NBC/Netflix)

When user mentions a celebrity/personality name:
- First identify WHO they are (actor, rapper, comedian, etc.)
- Then recall what REAL shows/movies they've appeared in
- Match with the platform/format they mentioned

Return ONLY a JSON array of REAL existing titles:
[
  {"title": "The Vince Staples Show", "year": 2024, "reason": "Netflix comedy series starring rapper Vince Staples", "isTV": true},
  ...
]

If you're not 100% sure a title exists, DO NOT include it. Better to return fewer results than fake ones.
Return valid JSON only, no markdown.`,
        },
        {
          role: 'user',
          content: description,
        },
      ],
      temperature: 0.2, // Very low temperature for factual accuracy
      max_tokens: 500,
    });

    const gptContent = gptResponse.choices[0]?.message?.content || '[]';
    console.log('GPT suggestions:', gptContent);

    let suggestions: Array<{ title: string; year: number; reason: string; isTV?: boolean }> = [];
    try {
      // Clean up potential markdown formatting
      const cleanedContent = gptContent.replace(/```json\n?|\n?```/g, '').trim();
      suggestions = JSON.parse(cleanedContent);
      console.log('Parsed suggestions:', suggestions);
    } catch (parseError) {
      console.error('Failed to parse GPT response:', parseError);
      suggestions = [];
    }

    if (suggestions.length === 0) {
      return NextResponse.json({
        found: false,
        message: 'Could not find movies matching your description. Try being more specific.',
        suggestions: [],
      });
    }

    // Step 2: Search our database for matching movies
    const results: MovieResult[] = [];

    for (const suggestion of suggestions) {
      // Try exact title match first
      let { data: movies, error } = await supabase
        .from('movies')
        .select('id, title, year, poster_url, backdrop_url, overview, imdb_id, tmdb_id')
        .ilike('title', suggestion.title)
        .limit(1);

      if (!movies || movies.length === 0) {
        // Try fuzzy match
        const { data: fuzzyMovies } = await supabase
          .from('movies')
          .select('id, title, year, poster_url, backdrop_url, overview, imdb_id, tmdb_id')
          .ilike('title', `%${suggestion.title}%`)
          .limit(3);

        movies = fuzzyMovies || [];
      }

      if (movies && movies.length > 0) {
        // Find best match by year if available
        const match = movies.find(m => m.year === suggestion.year) || movies[0];
        if (!results.find(r => r.id === match.id)) {
          results.push({
            ...match,
            reason: suggestion.reason,
          } as MovieResult & { reason: string });
        }
      }
    }

    // Step 3: If no database matches, try to fetch from TMDB and add to database
    if (results.length === 0 && suggestions.length > 0) {
      console.log('No database matches, searching TMDB...');
      
      for (const suggestion of suggestions.slice(0, 3)) {
        try {
          // Search both movies and TV shows
          const searchType = suggestion.isTV ? 'tv' : 'movie';
          const tmdbResponse = await fetch(
            `https://api.themoviedb.org/3/search/${searchType}?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(suggestion.title)}`
          );
          const tmdbData = await tmdbResponse.json();

          // If movie search fails, try TV search and vice versa
          let tmdbMovie = tmdbData.results?.[0];
          let actualSearchType = searchType;
          
          if (!tmdbMovie) {
            const altType = searchType === 'movie' ? 'tv' : 'movie';
            const altResponse = await fetch(
              `https://api.themoviedb.org/3/search/${altType}?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(suggestion.title)}`
            );
            const altData = await altResponse.json();
            tmdbMovie = altData.results?.[0];
            actualSearchType = altType;
          }

          if (tmdbMovie) {
            const isTV = actualSearchType === 'tv';
            const title = isTV ? tmdbMovie.name : tmdbMovie.title;
            const releaseDate = isTV ? tmdbMovie.first_air_date : tmdbMovie.release_date;
            
            // Check if already in our database by tmdb_id
            const { data: existing } = await supabase
              .from('movies')
              .select('*')
              .eq('tmdb_id', tmdbMovie.id)
              .single();

            if (existing) {
              results.push(existing);
            } else {
              // Fetch full details to get imdb_id
              let imdbId = null;
              try {
                const detailsUrl = isTV 
                  ? `https://api.themoviedb.org/3/tv/${tmdbMovie.id}/external_ids?api_key=${process.env.TMDB_API_KEY}`
                  : `https://api.themoviedb.org/3/movie/${tmdbMovie.id}?api_key=${process.env.TMDB_API_KEY}`;
                const detailsRes = await fetch(detailsUrl);
                const detailsJson = await detailsRes.json();
                imdbId = detailsJson.imdb_id || null;
                console.log(`✓ Fetched IMDB ID for ${title}: ${imdbId}`);
              } catch (e) {
                console.log('Failed to fetch IMDB ID:', e);
              }
              
              // Add to database (we store both movies and TV shows in movies table)
              const newMovie = {
                title: title,
                year: releaseDate ? parseInt(releaseDate.split('-')[0]) : null,
                overview: tmdbMovie.overview,
                poster_url: tmdbMovie.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}` : null,
                backdrop_url: tmdbMovie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbMovie.backdrop_path}` : null,
                tmdb_id: tmdbMovie.id,
                imdb_id: imdbId,
                popularity: tmdbMovie.popularity || 0,
              };

              const { data: inserted, error: insertError } = await supabase
                .from('movies')
                .insert(newMovie)
                .select()
                .single();

              if (inserted) {
                results.push({
                  ...inserted,
                  reason: suggestion.reason,
                } as MovieResult & { reason: string });
                console.log(`✅ Added ${isTV ? 'TV show' : 'movie'} to database: ${title}`);
              }
            }
          }
        } catch (tmdbError) {
          console.error('TMDB search error:', tmdbError);
        }
      }
    }

    console.log(`Found ${results.length} matching movies`);

    // Save the first result to history so it shows in Recently Found
    if (results.length > 0) {
      await saveSearchToHistory(results[0].id, 'voice_search');
    }

    return NextResponse.json({
      found: results.length > 0,
      movies: results,
      suggestions: suggestions.map(s => ({
        title: s.title,
        year: s.year,
        reason: s.reason,
        inDatabase: results.some(r => 
          r.title.toLowerCase() === s.title.toLowerCase() || 
          (r.title.toLowerCase().includes(s.title.toLowerCase()) && r.year === s.year)
        ),
      })),
    });

  } catch (error: any) {
    console.error('Search description error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to search' },
      { status: 500 }
    );
  }
}
