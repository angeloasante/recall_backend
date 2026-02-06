import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getWatchProviders, buildProviderLogoUrl, WatchProvider } from '@/lib/tmdb';

export interface StreamingProvider {
  name: string;
  type: 'subscription' | 'rent' | 'buy' | 'free';
  logo_url: string | null;
  provider_id: number;
}

export interface StreamingData {
  providers: StreamingProvider[];
  subscription: StreamingProvider[];
  rent: StreamingProvider[];
  buy: StreamingProvider[];
  free: StreamingProvider[];
  justwatch_url: string | null;
  updated_at: string;
  country: string;
}

/**
 * Convert TMDB watch provider to our format
 */
function convertProvider(
  provider: WatchProvider,
  type: 'subscription' | 'rent' | 'buy' | 'free'
): StreamingProvider {
  return {
    name: provider.provider_name,
    type,
    logo_url: buildProviderLogoUrl(provider.logo_path),
    provider_id: provider.provider_id,
  };
}

// GET /api/movies/[id]/streaming - Get streaming availability from TMDB
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true';
  const country = req.nextUrl.searchParams.get('country') || 'US';

  try {
    // Get movie from database
    const { data: movie, error: movieError } = await supabaseAdmin
      .from('movies')
      .select('id, title, year, tmdb_id, streaming_providers')
      .eq('id', id)
      .single();

    if (movieError || !movie) {
      return NextResponse.json({ error: 'Movie not found' }, { status: 404 });
    }

    if (!movie.tmdb_id) {
      return NextResponse.json({ 
        error: 'No TMDB ID for this movie',
        providers: [],
        subscription: [],
        rent: [],
        buy: [],
        free: [],
        justwatch_url: null,
        updated_at: new Date().toISOString(),
        country,
      });
    }

    // Check if we have cached data that's less than 24 hours old
    if (!forceRefresh && movie.streaming_providers) {
      const cached = movie.streaming_providers as StreamingData;
      const updatedAt = new Date(cached.updated_at);
      const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceUpdate < 24 && cached.country === country) {
        console.log(`📺 Using cached streaming data for "${movie.title}" (${hoursSinceUpdate.toFixed(1)}h old)`);
        return NextResponse.json({
          ...cached,
          cached: true,
        });
      }
    }

    // Fetch fresh data from TMDB
    console.log(`🔍 Fetching TMDB watch providers for "${movie.title}" (TMDB: ${movie.tmdb_id})`);
    
    const watchProviders = await getWatchProviders(movie.tmdb_id, 'movie', country);
    
    if (!watchProviders) {
      const emptyData: StreamingData = {
        providers: [],
        subscription: [],
        rent: [],
        buy: [],
        free: [],
        justwatch_url: null,
        updated_at: new Date().toISOString(),
        country,
      };
      
      return NextResponse.json({
        ...emptyData,
        cached: false,
        message: 'No streaming data available for this title',
      });
    }

    // Convert to our format
    const subscription = (watchProviders.flatrate || []).map(p => convertProvider(p, 'subscription'));
    const rent = (watchProviders.rent || []).map(p => convertProvider(p, 'rent'));
    const buy = (watchProviders.buy || []).map(p => convertProvider(p, 'buy'));
    const free = (watchProviders.free || []).map(p => convertProvider(p, 'free'));
    
    // Combine all providers for backward compatibility
    const allProviders = [...subscription, ...rent, ...buy, ...free];

    const streamingData: StreamingData = {
      providers: allProviders,
      subscription,
      rent,
      buy,
      free,
      justwatch_url: watchProviders.link || null,
      updated_at: new Date().toISOString(),
      country,
    };

    // Cache in database
    const { error: updateError } = await supabaseAdmin
      .from('movies')
      .update({ streaming_providers: streamingData })
      .eq('id', id);

    if (updateError) {
      console.error('Failed to cache streaming data:', updateError);
    } else {
      console.log(`✅ Cached ${allProviders.length} streaming providers for "${movie.title}" (${subscription.length} sub, ${rent.length} rent, ${buy.length} buy, ${free.length} free)`);
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
