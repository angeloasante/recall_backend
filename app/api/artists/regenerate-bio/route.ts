import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// POST /api/artists/regenerate-bio - Clear an artist's bio so it regenerates
export async function POST(req: NextRequest) {
  try {
    const { artistId, artistName } = await req.json();

    if (!artistId && !artistName) {
      return NextResponse.json(
        { error: 'Must provide artistId or artistName' },
        { status: 400 }
      );
    }

    let query = supabaseAdmin
      .from('artists')
      .update({ biography: null, updated_at: new Date().toISOString() });

    if (artistId) {
      query = query.eq('id', artistId);
    } else if (artistName) {
      query = query.ilike('name', artistName);
    }

    const { data, error } = await query.select();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `Cleared biography for ${data?.length || 0} artist(s). Biography will regenerate on next view.`,
      artists: data?.map((a: any) => a.name),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to regenerate bio' },
      { status: 500 }
    );
  }
}
