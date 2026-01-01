import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

// GET /api/recent - Get recently recognized movies
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10');

    // Get recent uploads that have a recognized movie
    const { data: uploads, error: uploadsError } = await supabase
      .from('user_uploads')
      .select('id, result_movie_id, confidence_score, created_at')
      .not('result_movie_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (uploadsError) {
      console.error('Error fetching recent uploads:', uploadsError);
      return NextResponse.json({ error: 'Failed to fetch recent results' }, { status: 500 });
    }

    if (!uploads || uploads.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Get movie details for each upload
    const movieIds = uploads.map(u => u.result_movie_id).filter(Boolean);
    
    const { data: movies, error: moviesError } = await supabase
      .from('movies')
      .select('id, title, year, poster_url, tmdb_id')
      .in('id', movieIds);

    if (moviesError) {
      console.error('Error fetching movies:', moviesError);
      return NextResponse.json({ error: 'Failed to fetch movie details' }, { status: 500 });
    }

    // Map movies by id for quick lookup
    const moviesMap = new Map(movies?.map(m => [m.id, m]) || []);

    // Build results
    const results = uploads.map(upload => ({
      id: upload.id,
      movie: moviesMap.get(upload.result_movie_id) || null,
      confidence: upload.confidence_score || 0,
      createdAt: upload.created_at,
    })).filter(r => r.movie !== null);

    return NextResponse.json({ results });

  } catch (error) {
    console.error('Recent API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
