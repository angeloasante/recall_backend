import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getWatchProviders, buildProviderLogoUrl, WatchProvider } from '@/lib/tmdb';

export interface StreamingProvider {
  name: string;
  type: 'subscription' | 'rent' | 'buy' | 'free';
  logo_url: string | null;
  provider_id: number;
  url: string | null; // Direct deep link to streaming service
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

interface JustWatchOffer {
  monetizationType: 'FLATRATE' | 'RENT' | 'BUY' | 'FREE' | 'ADS';
  package: {
    clearName: string;
    technicalName: string;
  };
  standardWebURL: string;
}

interface JustWatchResult {
  id: string;
  content: {
    title: string;
    fullPath: string;
    externalIds: {
      imdbId?: string;
      tmdbId?: string;
    };
  };
  offers: JustWatchOffer[];
}

/**
 * Query JustWatch GraphQL API to get real streaming URLs
 */
async function getJustWatchOffers(
  movieTitle: string,
  tmdbId: number,
  country: string = 'US'
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>(); // Maps provider technicalName to URL
  
  try {
    const query = `
      query SearchTitle($searchQuery: String!, $country: Country!) {
        popularTitles(country: $country, first: 5, filter: { searchQuery: $searchQuery }) {
          edges {
            node {
              id
              content(country: $country, language: en) {
                title
                fullPath
                originalReleaseYear
                externalIds {
                  imdbId
                  tmdbId
                }
              }
              offers(country: $country, platform: WEB) {
                monetizationType
                package {
                  clearName
                  technicalName
                }
                standardWebURL
              }
            }
          }
        }
      }
    `;

    const response = await fetch('https://apis.justwatch.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          searchQuery: movieTitle,
          country: country.toUpperCase(),
        },
      }),
    });

    if (!response.ok) {
      console.log(`⚠️ JustWatch API returned ${response.status}`);
      return urlMap;
    }

    const data = await response.json();
    const edges = data?.data?.popularTitles?.edges || [];
    
    // Find the matching movie by TMDB ID
    let matchingResult: JustWatchResult | null = null;
    for (const edge of edges) {
      const node = edge.node as JustWatchResult;
      if (node.content?.externalIds?.tmdbId === String(tmdbId)) {
        matchingResult = node;
        break;
      }
    }

    // If no TMDB match, use the first result (best guess by title)
    if (!matchingResult && edges.length > 0) {
      matchingResult = edges[0].node as JustWatchResult;
      console.log(`⚠️ No TMDB match for ${tmdbId}, using first result: ${matchingResult.content?.title}`);
    }

    if (!matchingResult?.offers) {
      console.log(`⚠️ No offers found for "${movieTitle}"`);
      return urlMap;
    }

    // Build URL map from offers (deduplicate by technicalName + monetizationType)
    const seen = new Set<string>();
    for (const offer of matchingResult.offers) {
      const key = `${offer.package.technicalName}-${offer.monetizationType}`;
      if (!seen.has(key)) {
        seen.add(key);
        // Store the URL keyed by technicalName (we'll match by provider name later)
        urlMap.set(offer.package.technicalName, offer.standardWebURL);
        // Also store by clearName for matching
        urlMap.set(offer.package.clearName.toLowerCase(), offer.standardWebURL);
      }
    }

    console.log(`✅ Got ${urlMap.size} JustWatch URLs for "${movieTitle}"`);
    
  } catch (error) {
    console.error('Error querying JustWatch:', error);
  }
  
  return urlMap;
}

/**
 * Map TMDB provider names to JustWatch technical names
 */
const TMDB_TO_JUSTWATCH: Record<string, string> = {
  'netflix': 'netflix',
  'amazon prime video': 'amazon',
  'prime video': 'amazon',
  'amazon video': 'amazon',
  'disney plus': 'disneyplus',
  'disney+': 'disneyplus',
  'hulu': 'hulu',
  'max': 'max',
  'hbo max': 'hbomax',
  'apple tv plus': 'appletvplus',
  'apple tv+': 'appletvplus',
  'apple tv store': 'itunes',
  'apple itunes': 'itunes',
  'peacock': 'peacock',
  'peacock premium': 'peacockpremium',
  'paramount plus': 'paramountplus',
  'paramount+': 'paramountplus',
  'youtube': 'youtube',
  'google play movies': 'play',
  'vudu': 'vudu',
  'fandango at home': 'vudu',
  'tubi tv': 'tubitv',
  'tubi': 'tubitv',
  'pluto tv': 'plutotv',
  'crunchyroll': 'crunchyroll',
  'starz': 'starz',
  'showtime': 'showtime',
  'mgm plus': 'mgmplus',
  'mgm+': 'mgmplus',
  'amc plus': 'amcplus',
  'amc+': 'amcplus',
};

/**
 * Convert TMDB watch provider to our format with URL from JustWatch
 */
function convertProvider(
  provider: WatchProvider,
  type: 'subscription' | 'rent' | 'buy' | 'free',
  justWatchUrls: Map<string, string>
): StreamingProvider {
  const providerName = provider.provider_name.toLowerCase();
  
  // Try to find URL by matching provider name
  let url: string | null = null;
  
  // First try direct match by provider name
  if (justWatchUrls.has(providerName)) {
    url = justWatchUrls.get(providerName) || null;
  }
  
  // Try mapped technical name
  if (!url && TMDB_TO_JUSTWATCH[providerName]) {
    url = justWatchUrls.get(TMDB_TO_JUSTWATCH[providerName]) || null;
  }
  
  // Try partial match
  if (!url) {
    for (const [key, value] of justWatchUrls) {
      if (key.includes(providerName) || providerName.includes(key)) {
        url = value;
        break;
      }
    }
  }
  
  return {
    name: provider.provider_name,
    type,
    logo_url: buildProviderLogoUrl(provider.logo_path),
    provider_id: provider.provider_id,
    url,
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

    // Query JustWatch GraphQL API to get real streaming URLs
    console.log(`🔍 Fetching JustWatch URLs for "${movie.title}"`);
    const justWatchUrls = await getJustWatchOffers(movie.title, movie.tmdb_id, country);

    // Convert to our format with URLs from JustWatch
    const subscription = (watchProviders.flatrate || []).map(p => convertProvider(p, 'subscription', justWatchUrls));
    const rent = (watchProviders.rent || []).map(p => convertProvider(p, 'rent', justWatchUrls));
    const buy = (watchProviders.buy || []).map(p => convertProvider(p, 'buy', justWatchUrls));
    const free = (watchProviders.free || []).map(p => convertProvider(p, 'free', justWatchUrls));
    
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
