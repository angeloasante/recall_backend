import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/movies/[id] - Get movie details
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  // Get movie
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

  // Get cast
  const { data: cast } = await supabaseAdmin
    .from('movie_cast')
    .select('*')
    .eq('movie_id', id)
    .order('id', { ascending: true });

  // Get search analytics
  const { data: analytics } = await supabaseAdmin
    .from('search_analytics')
    .select('*')
    .eq('movie_id', id)
    .single();

  return NextResponse.json({
    ...movie,
    cast: cast || [],
    search_count: analytics?.search_count || 0,
  });
}
