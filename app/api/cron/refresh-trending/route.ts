import { NextRequest, NextResponse } from 'next/server';

/**
 * Cron endpoint to refresh trending data
 * 
 * This endpoint should be called periodically (every 6 hours) to keep
 * the trending data fresh. On Railway, set up a cron job to hit this endpoint.
 * 
 * Railway Cron Setup:
 * 1. Go to your Railway project settings
 * 2. Add a cron job with schedule: "0 0,6,12,18 * * *" (every 6 hours)
 * 3. Set the endpoint to: https://your-app.railway.app/api/cron/refresh-trending
 * 
 * Or use an external cron service like:
 * - cron-job.org (free)
 * - easycron.com
 * - GitHub Actions scheduled workflow
 */

// Secret key to prevent unauthorized access (set in Railway env vars)
const CRON_SECRET = process.env.CRON_SECRET;

// In-memory cache for trending data (survives between requests on same instance)
let cachedTrendingData: any = null;
let lastRefreshTime: number = 0;
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function GET(request: NextRequest) {
  // Verify the request is authorized
  const authHeader = request.headers.get('authorization');
  const urlSecret = request.nextUrl.searchParams.get('secret');
  
  // Check auth (allow if CRON_SECRET not set for local dev)
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}` && urlSecret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('🕐 Cron job: Refreshing trending data...');
    
    // Call the trending endpoint to refresh data
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const response = await fetch(`${baseUrl}/api/trending?refresh=true`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh trending: ${response.status}`);
    }

    const data = await response.json();
    
    // Update in-memory cache
    cachedTrendingData = data;
    lastRefreshTime = Date.now();

    console.log(`✅ Cron job: Refreshed ${data.trending?.length || 0} trending items`);

    return NextResponse.json({
      success: true,
      message: 'Trending data refreshed',
      itemCount: data.trending?.length || 0,
      source: data.source,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Cron job error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

/**
 * Get cached trending data (for use by other endpoints)
 */
export function getCachedTrending() {
  const isValid = cachedTrendingData && (Date.now() - lastRefreshTime) < CACHE_DURATION_MS;
  return isValid ? cachedTrendingData : null;
}

/**
 * POST handler for cron services that use POST
 */
export async function POST(request: NextRequest) {
  return GET(request);
}
