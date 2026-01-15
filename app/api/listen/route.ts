import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { recognizeFromDialogue, transcribeAudioGemini, isGeminiAvailable } from '@/lib/gemini';

// Route segment config
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // Audio-only is faster, 30s timeout

/**
 * LISTEN API - Shazam-like Audio Recognition
 * 
 * Optimized for quick background listening:
 * 1. Accept raw audio (PCM, WAV, or compressed)
 * 2. Transcribe with Gemini (fast)
 * 3. One-shot movie recognition based on dialogue
 * 4. Return result for live notification/dynamic island
 * 
 * Use cases:
 * - Control Center widget tap
 * - Dynamic Island activation
 * - Background listening shortcut
 */

// Helper: Check if movie exists in DB
async function findMovieInDatabase(title: string, year?: number | null): Promise<any | null> {
  // Try exact title match first
  const { data: exactMatches } = await supabaseAdmin
    .from('movies')
    .select('*')
    .ilike('title', title)
    .limit(5);
  
  if (exactMatches && exactMatches.length > 0) {
    if (year) {
      const yearMatch = exactMatches.find(m => m.year === year);
      if (yearMatch) return yearMatch;
    }
    return exactMatches[0];
  }
  
  // Try partial match
  const { data: partialMatches } = await supabaseAdmin
    .from('movies')
    .select('*')
    .ilike('title', `%${title}%`)
    .limit(5);
  
  if (partialMatches && partialMatches.length > 0) {
    if (year) {
      const yearMatch = partialMatches.find(m => m.year === year);
      if (yearMatch) return yearMatch;
    }
    return partialMatches[0];
  }
  
  return null;
}

// Helper: Get cached similar movies
async function getCachedSimilarMovies(movieId: number): Promise<any[]> {
  const { data } = await supabaseAdmin
    .from('movies')
    .select('similar_movies')
    .eq('id', movieId)
    .single();
  
  if (data?.similar_movies && Array.isArray(data.similar_movies)) {
    return data.similar_movies.slice(0, 6);
  }
  return [];
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  console.log('\n🎧 ========== LISTEN MODE START ==========');

  try {
    // Check Gemini availability
    if (!isGeminiAvailable()) {
      return NextResponse.json({ 
        success: false,
        error: 'Service unavailable',
        message: 'Recognition service not configured' 
      }, { status: 503 });
    }

    // Parse request
    const contentType = req.headers.get('content-type') || '';
    let audioBuffer: Buffer;
    let userId: string | null = null;
    let duration: number | null = null;

    if (contentType.includes('multipart/form-data')) {
      // FormData upload (audio file)
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File;
      userId = formData.get('user_id') as string | null;
      duration = formData.get('duration') ? parseFloat(formData.get('duration') as string) : null;

      if (!audioFile) {
        return NextResponse.json({ 
          success: false,
          error: 'No audio provided' 
        }, { status: 400 });
      }

      audioBuffer = Buffer.from(await audioFile.arrayBuffer());
      console.log(`🎤 Audio file: ${audioFile.name} (${(audioBuffer.length / 1024).toFixed(1)}KB)`);
    } else if (contentType.includes('audio/')) {
      // Raw audio stream
      const arrayBuffer = await req.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
      userId = req.headers.get('x-user-id');
      duration = req.headers.get('x-duration') ? parseFloat(req.headers.get('x-duration')!) : null;
      console.log(`🎤 Raw audio stream: ${(audioBuffer.length / 1024).toFixed(1)}KB`);
    } else {
      // Try JSON with base64 audio
      const body = await req.json();
      if (!body.audio) {
        return NextResponse.json({ 
          success: false,
          error: 'No audio provided' 
        }, { status: 400 });
      }
      audioBuffer = Buffer.from(body.audio, 'base64');
      userId = body.user_id || null;
      duration = body.duration || null;
      console.log(`🎤 Base64 audio: ${(audioBuffer.length / 1024).toFixed(1)}KB`);
    }

    if (audioBuffer.length < 1000) {
      return NextResponse.json({
        success: false,
        error: 'Audio too short',
        message: 'Please record at least 5 seconds of audio'
      }, { status: 400 });
    }

    // ========== STEP 1: Transcribe Audio ==========
    console.log('📝 Step 1: Transcribing audio...');
    const transcribeStart = Date.now();
    
    let transcript = '';
    try {
      transcript = await transcribeAudioGemini(audioBuffer);
      console.log(`  ✓ Transcribed in ${Date.now() - transcribeStart}ms: ${transcript.length} chars`);
      
      if (transcript.length > 0) {
        console.log(`  "${transcript.substring(0, 100)}..."`);
      }
    } catch (err: any) {
      console.log(`  ⚠️ Transcription failed: ${err.message}`);
      return NextResponse.json({
        success: false,
        error: 'Could not transcribe audio',
        message: 'Try recording clearer dialogue'
      }, { status: 422 });
    }

    if (!transcript || transcript.length < 10) {
      return NextResponse.json({
        success: false,
        error: 'No dialogue detected',
        message: 'Record a scene with clear dialogue'
      }, { status: 422 });
    }

    // ========== STEP 2: Recognize Movie from Dialogue ==========
    console.log('🎬 Step 2: Recognizing movie from dialogue...');
    const recognizeStart = Date.now();

    // Use dedicated audio-only recognition (optimized for dialogue)
    const recognition = await recognizeFromDialogue(transcript);
    console.log(`  ✓ Recognition in ${Date.now() - recognizeStart}ms`);
    console.log(`  🎯 Result: "${recognition.title}" (${recognition.year}) - ${recognition.confidence}%`);
    console.log(`  📝 Reasoning: ${recognition.reasoning}`);

    if (!recognition.title || recognition.title.toLowerCase() === 'unknown' || recognition.confidence < 50) {
      console.log(`  ❌ Low confidence recognition`);
      return NextResponse.json({
        success: false,
        error: 'Could not identify movie',
        message: 'Try a scene with more distinctive dialogue',
        transcript: transcript.substring(0, 200),
        processingTime: Date.now() - startTime
      }, { status: 200 }); // Return 200 but success: false
    }

    // ========== STEP 3: Find in Database ==========
    console.log('🔍 Step 3: Finding movie in database...');
    const dbMovie = await findMovieInDatabase(recognition.title, recognition.year);

    let movie: any;
    let similarMovies: any[] = [];

    if (dbMovie) {
      console.log(`  ✓ Found in DB: "${dbMovie.title}" (ID: ${dbMovie.id})`);
      movie = dbMovie;
      
      // Get cached similar movies
      similarMovies = await getCachedSimilarMovies(dbMovie.id);
      if (similarMovies.length > 0) {
        console.log(`  ✓ Loaded ${similarMovies.length} cached similar movies`);
      }
    } else {
      // Return basic info if not in DB
      console.log(`  ⚠️ Not in DB, returning basic info`);
      movie = {
        title: recognition.title,
        year: recognition.year,
        overview: recognition.reasoning || '',
        is_tv: false,
      };
    }

    // ========== STEP 4: Save Recognition Record ==========
    if (userId && dbMovie) {
      console.log('💾 Saving recognition record...');
      try {
        const { data: upload, error } = await supabaseAdmin
          .from('user_uploads')
          .insert({
            user_id: userId,
            result_movie_id: dbMovie.id,
            confidence_score: recognition.confidence / 100, // Store as decimal 0-1
          })
          .select()
          .single();
        
        if (error) {
          console.log(`  ⚠️ Failed to save: ${error.message}`);
        } else {
          console.log(`  ✓ Saved upload record: ID ${upload?.id}`);
        }
      } catch (err) {
        console.log(`  ⚠️ Error saving record`);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`\n⏱️ Total listen time: ${totalTime}ms`);
    console.log('🎧 ========== LISTEN MODE END ==========\n');

    // ========== Return Result for Live Notification ==========
    return NextResponse.json({
      success: true,
      movie: {
        id: movie.id || null,
        title: movie.title,
        year: movie.year,
        overview: movie.overview,
        poster_url: movie.poster_url || null,
        backdrop_url: movie.backdrop_url || null,
        vote_average: movie.vote_average || null,
        is_tv: movie.is_tv || false,
        genres: movie.genres || [],
      },
      recognition: {
        confidence: recognition.confidence, // Already a percentage (0-100)
        reasoning: recognition.reasoning,
        transcript: transcript.substring(0, 300),
        alternatives: recognition.alternativeTitles || [],
      },
      similar_movies: similarMovies,
      processing_time_ms: totalTime,
    });

  } catch (error: any) {
    console.error('❌ Listen error:', error);
    return NextResponse.json({
      success: false,
      error: 'Recognition failed',
      message: error.message || 'Unknown error',
      processing_time_ms: Date.now() - startTime,
    }, { status: 500 });
  }
}

// GET endpoint for health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'listen',
    description: 'Shazam-like audio recognition for movies',
    usage: {
      method: 'POST',
      content_types: [
        'multipart/form-data (audio file)',
        'audio/* (raw audio stream)',
        'application/json (base64 audio)',
      ],
      parameters: {
        audio: 'Audio data (required)',
        user_id: 'User ID for history (optional)',
        duration: 'Audio duration in seconds (optional)',
      },
      recommended_duration: '10-30 seconds',
      response: {
        success: 'boolean',
        movie: 'Recognized movie details',
        recognition: 'Confidence, reasoning, transcript',
        similar_movies: 'Related titles',
        processing_time_ms: 'Total processing time',
      }
    }
  });
}
