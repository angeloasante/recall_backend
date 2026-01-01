import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/movies - List all movies
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const search = searchParams.get('search');

  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('movies')
    .select('*', { count: 'exact' })
    .order('popularity', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.ilike('title', `%${search}%`);
  }

  const { data: movies, error, count } = await query;

  if (error) {
    return NextResponse.json(
      { error: 'Failed to fetch movies' },
      { status: 500 }
    );
  }

  return NextResponse.json({
    movies,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}
