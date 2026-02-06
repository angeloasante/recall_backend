import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface StreamingProvider {
  name: string;
  type: 'subscription' | 'rent' | 'buy' | 'free';
  url: string;
  price?: string;
  logo?: string;
}

export interface StreamingData {
  providers: StreamingProvider[];
  updated_at: string;
  country: string;
}

// Streaming service logos and colors
const SERVICE_METADATA: Record<string, { logo: string; color: string }> = {
  'netflix': { logo: '🔴', color: '#E50914' },
  'amazon prime video': { logo: '🔵', color: '#00A8E1' },
  'prime video': { logo: '🔵', color: '#00A8E1' },
  'disney+': { logo: '🏰', color: '#113CCF' },
  'disney plus': { logo: '🏰', color: '#113CCF' },
  'hulu': { logo: '🟢', color: '#1CE783' },
  'max': { logo: '🟣', color: '#741DDA' },
  'hbo max': { logo: '🟣', color: '#741DDA' },
  'apple tv+': { logo: '🍎', color: '#000000' },
  'apple tv': { logo: '🍎', color: '#000000' },
  'peacock': { logo: '🦚', color: '#000000' },
  'paramount+': { logo: '⛰️', color: '#0064FF' },
  'paramount plus': { logo: '⛰️', color: '#0064FF' },
  'youtube': { logo: '▶️', color: '#FF0000' },
  'youtube premium': { logo: '▶️', color: '#FF0000' },
  'tubi': { logo: '📺', color: '#FA382F' },
  'pluto tv': { logo: '📡', color: '#2E236C' },
  'vudu': { logo: '💚', color: '#35BEE8' },
  'fandango at home': { logo: '💚', color: '#35BEE8' },
  'google play': { logo: '🎮', color: '#4285F4' },
  'itunes': { logo: '🎵', color: '#FB5BC5' },
  'crunchyroll': { logo: '🍊', color: '#F47521' },
  'shudder': { logo: '👻', color: '#C31432' },
  'mubi': { logo: '🎬', color: '#000000' },
  'criterion channel': { logo: '🎞️', color: '#000000' },
  'starz': { logo: '⭐', color: '#000000' },
  'showtime': { logo: '🎭', color: '#B71818' },
  'mgm+': { logo: '🦁', color: '#D4AF37' },
  'amc+': { logo: '📺', color: '#000000' },
  'bet+': { logo: '📺', color: '#000000' },
  'britbox': { logo: '🇬🇧', color: '#CF142B' },
};

/**
 * Use Gemini to find streaming availability for a movie
 */
async function findStreamingWithGemini(
  title: string,
  year: number | null,
  imdbId: string | null
): Promise<StreamingProvider[]> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const movieIdentifier = imdbId 
    ? `${title} (${year || 'unknown year'}) - IMDB: ${imdbId}`
    : `${title} (${year || 'unknown year'})`;

  const response = await fetch(
    `${GEMINI_BASE_URL}/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Find US streaming availability for: ${movieIdentifier}

Return ONLY a JSON array with available platforms. Example format:
[{"name":"Disney+","type":"subscription","url":"https://disneyplus.com/movies/..."}]

Types: subscription, rent, buy, free
For rent/buy add price field.
Only include platforms where this movie is ACTUALLY available.
If unsure, return empty array: []`
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  const data = await response.json();
  
  if (data.error) {
    console.error('Gemini API error:', data.error);
    throw new Error(data.error.message);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  console.log('Gemini streaming response:', text.substring(0, 500));
  
  // Extract JSON from response (handle potential markdown wrapping)
  let jsonStr = text.trim();
  
  // Remove markdown code blocks if present
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```$/g, '').trim();
  }
  
  // Try to find JSON array in response
  const jsonMatch = jsonStr.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  // Try to fix truncated JSON by closing brackets
  if (!jsonStr.endsWith(']')) {
    // Find last complete object
    const lastCompleteObj = jsonStr.lastIndexOf('}');
    if (lastCompleteObj > 0) {
      jsonStr = jsonStr.substring(0, lastCompleteObj + 1) + ']';
    }
  }

  try {
    const providers: StreamingProvider[] = JSON.parse(jsonStr);
    
    // Add logos and validate
    return providers
      .filter(p => p.name && p.type && p.url)
      .map(p => {
        const key = p.name.toLowerCase();
        const metadata = SERVICE_METADATA[key] || { logo: '📺', color: '#666666' };
        return {
          ...p,
          logo: metadata.logo,
        };
      });
  } catch (e) {
    console.error('Failed to parse streaming response:', text);
    return [];
  }
}

// GET /api/movies/[id]/streaming - Get streaming availability
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true';

  try {
    // Get movie from database
    const { data: movie, error: movieError } = await supabaseAdmin
      .from('movies')
      .select('id, title, year, imdb_id, streaming_providers')
      .eq('id', id)
      .single();

    if (movieError || !movie) {
      return NextResponse.json({ error: 'Movie not found' }, { status: 404 });
    }

    // Check if we have cached data that's less than 7 days old
    if (!forceRefresh && movie.streaming_providers) {
      const cached = movie.streaming_providers as StreamingData;
      const updatedAt = new Date(cached.updated_at);
      const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceUpdate < 7) {
        console.log(`📺 Using cached streaming data for "${movie.title}" (${daysSinceUpdate.toFixed(1)} days old)`);
        return NextResponse.json({
          ...cached,
          cached: true,
        });
      }
    }

    // Fetch fresh data from Gemini
    console.log(`🔍 Fetching streaming availability for "${movie.title}" (${movie.year})`);
    
    const providers = await findStreamingWithGemini(
      movie.title,
      movie.year,
      movie.imdb_id
    );

    const streamingData: StreamingData = {
      providers,
      updated_at: new Date().toISOString(),
      country: 'US',
    };

    // Cache in database
    const { error: updateError } = await supabaseAdmin
      .from('movies')
      .update({ streaming_providers: streamingData })
      .eq('id', id);

    if (updateError) {
      console.error('Failed to cache streaming data:', updateError);
    } else {
      console.log(`✅ Cached ${providers.length} streaming providers for "${movie.title}"`);
    }

    return NextResponse.json({
      ...streamingData,
      cached: false,
    });

  } catch (error: any) {
    console.error('Streaming API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch streaming data' },
      { status: 500 }
    );
  }
}

// POST /api/movies/[id]/streaming - Force refresh streaming data
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const url = new URL(req.url);
  url.searchParams.set('refresh', 'true');
  const newReq = new NextRequest(url, req);
  return GET(newReq, { params });
}
