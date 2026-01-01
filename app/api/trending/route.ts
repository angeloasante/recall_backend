import { NextRequest, NextResponse } from 'next/server';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Server-side cache (persists between requests on same instance)
let cachedTrendingData: any[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

interface TrendingMovie {
  title: string;
  year?: number;
  platform?: string;
}

interface TMDBSearchResult {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genre_ids: number[];
  release_date?: string;
  first_air_date?: string;
  overview: string;
  media_type?: string;
}

// TMDB Genre IDs
const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

/**
 * Use Gemini to get currently trending movies/shows
 */
async function getTrendingFromGemini(): Promise<TrendingMovie[]> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const today = new Date().toISOString().split('T')[0];
  
  const prompt = `You are an expert on movies and TV shows with access to current streaming charts. List the top 15 movies and TV shows that are ACTUALLY trending right now (as of ${today}).

IMPORTANT SOURCES TO CONSIDER:
- Netflix Top 10 (both Movies and TV)
- Amazon Prime Video popular
- Disney+ trending
- Max (HBO) popular shows
- Apple TV+ new releases
- Hulu trending
- Movies currently in theaters
- Shows with new season releases this month

REQUIREMENTS:
1. Use EXACT official titles as they appear on TMDB/IMDb (e.g., "Stranger Things" not "Stranger things")
2. Include the release year
3. Mix of movies AND TV shows
4. Focus on content released or trending in 2024-2025
5. Include currently airing TV shows with new episodes

Return ONLY a valid JSON array, no markdown, no explanation:
[
  {"title": "Exact Title", "year": 2024, "platform": "Netflix"},
  {"title": "Another Title", "year": 2025, "platform": "Theaters"}
]

EXAMPLES of trending content format:
- {"title": "Squid Game", "year": 2024, "platform": "Netflix"}
- {"title": "The Grinch", "year": 2018, "platform": "Netflix"}
- {"title": "Wake Up Dead Man: A Knives Out Mystery", "year": 2025, "platform": "Netflix"}`;

  const response = await fetch(
    `${GEMINI_BASE_URL}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2, // Lower temperature for more factual responses
          maxOutputTokens: 2000,
        },
        // Enable Google Search grounding for real-time data
        tools: [{
          google_search: {}
        }],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // Extract JSON from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('No JSON found in Gemini response:', text);
    throw new Error('Invalid Gemini response format');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Failed to parse Gemini JSON:', jsonMatch[0]);
    throw new Error('Failed to parse trending list');
  }
}

/**
 * Look up a movie/show on TMDB by title
 */
async function lookupOnTMDB(title: string, year?: number): Promise<TMDBSearchResult | null> {
  if (!TMDB_API_KEY) return null;

  try {
    // First try with year if provided
    let searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
    if (year) {
      searchUrl += `&year=${year}`;
    }
    
    let response = await fetch(searchUrl);
    if (!response.ok) return null;

    let data = await response.json();
    let results = data.results || [];

    // If no results with year, try without year
    if (results.length === 0 && year) {
      const fallbackUrl = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
      response = await fetch(fallbackUrl);
      if (response.ok) {
        data = await response.json();
        results = data.results || [];
      }
    }

    // Filter to movies and TV shows only
    results = results.filter((r: TMDBSearchResult) => 
      r.media_type === 'movie' || r.media_type === 'tv'
    );

    if (results.length === 0) return null;

    // Score results to find best match
    const scored = results.map((r: TMDBSearchResult) => {
      const resultTitle = (r.title || r.name || '').toLowerCase();
      const searchTitle = title.toLowerCase();
      let score = 0;

      // Exact match is best
      if (resultTitle === searchTitle) score += 100;
      // Contains match
      else if (resultTitle.includes(searchTitle) || searchTitle.includes(resultTitle)) score += 50;
      // Starts with
      else if (resultTitle.startsWith(searchTitle.split(' ')[0])) score += 25;

      // Prefer items with posters
      if (r.poster_path) score += 10;
      // Prefer higher rated
      score += r.vote_average || 0;
      // Prefer more recent
      const releaseYear = parseInt((r.release_date || r.first_air_date || '').substring(0, 4));
      if (releaseYear && releaseYear >= 2020) score += 5;

      return { result: r, score };
    });

    // Sort by score and return best match
    scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
    return scored[0]?.result || null;
  } catch (error) {
    console.error(`TMDB lookup failed for "${title}":`, error);
    return null;
  }
}

/**
 * Transform TMDB result to our format
 */
function transformResult(result: TMDBSearchResult, platform?: string) {
  const isTV = result.media_type === 'tv' || !!result.first_air_date;
  
  return {
    id: result.id,
    title: result.title || result.name || 'Unknown',
    poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : '',
    backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/w500${result.backdrop_path}` : '',
    rating: Math.round(result.vote_average * 10) / 20, // Convert 0-10 to 0-5
    genres: (result.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
    releaseDate: result.release_date || result.first_air_date || '',
    overview: result.overview || '',
    isTV,
    platform,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';

    // Check server-side cache first (unless force refresh)
    const cacheAge = Date.now() - cacheTimestamp;
    if (!forceRefresh && cachedTrendingData && cacheAge < CACHE_DURATION_MS) {
      console.log(`📦 Returning cached trending data (age: ${Math.round(cacheAge / 60000)}min)`);
      return NextResponse.json({
        success: true,
        trending: cachedTrendingData,
        source: 'cache',
        cacheAge: Math.round(cacheAge / 60000),
        timestamp: new Date().toISOString(),
      });
    }

    console.log('🔥 Fetching fresh trending content from Gemini...');
    
    // Get trending list from Gemini
    const trendingList = await getTrendingFromGemini();
    console.log(`📋 Got ${trendingList.length} trending titles from Gemini`);

    // Look up each title on TMDB
    const results = await Promise.all(
      trendingList.map(async (item) => {
        const tmdbResult = await lookupOnTMDB(item.title, item.year);
        if (tmdbResult) {
          return transformResult(tmdbResult, item.platform);
        }
        return null;
      })
    );

    // Filter out nulls
    const trending = results.filter(Boolean);
    console.log(`✅ Found ${trending.length} matches on TMDB`);

    // Update server-side cache
    cachedTrendingData = trending;
    cacheTimestamp = Date.now();

    return NextResponse.json({
      success: true,
      trending,
      source: 'gemini+tmdb',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching trending:', error);
    
    // Return cached data if available (even if stale)
    if (cachedTrendingData) {
      console.log('⚠️ Error occurred, returning stale cache');
      return NextResponse.json({
        success: true,
        trending: cachedTrendingData,
        source: 'stale-cache',
        timestamp: new Date().toISOString(),
      });
    }
    
    // Fallback to TMDB trending if Gemini fails and no cache
    try {
      console.log('⚠️ Falling back to TMDB trending...');
      const response = await fetch(
        `https://api.themoviedb.org/3/trending/all/day?api_key=${TMDB_API_KEY}`
      );
      const data = await response.json();
      const trending = (data.results || []).slice(0, 15).map((r: TMDBSearchResult) => 
        transformResult(r)
      );

      // Cache the fallback data too
      cachedTrendingData = trending;
      cacheTimestamp = Date.now();

      return NextResponse.json({
        success: true,
        trending,
        source: 'tmdb-fallback',
        timestamp: new Date().toISOString(),
      });
    } catch (fallbackError) {
      return NextResponse.json(
        { success: false, error: 'Failed to fetch trending content' },
        { status: 500 }
      );
    }
  }
}
