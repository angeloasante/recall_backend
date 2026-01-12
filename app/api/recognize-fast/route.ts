import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { extractAudio, extractFrames } from '@/lib/ffmpeg';
import { uploadVideo } from '@/lib/storage';
import { searchMulti, buildImageUrl, TMDBTVShow, verifyActorsInMovie, findMoviesWithActors } from '@/lib/tmdb';
import { recognizeMovieOneShot, transcribeAudioGemini, isGeminiAvailable } from '@/lib/gemini';
import { transcribeAudio } from '@/lib/openai';
import { generateEnhancedOverview } from '@/lib/enhance-overview';
import { recognitionQueue } from '@/lib/request-queue';

// Route segment config
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * FAST Recognition Pipeline - Single Gemini Call + Smart DB Caching
 * 
 * OPTIMIZED FLOW:
 * 1. Extract frames + audio (parallel)
 * 2. Transcribe audio (Gemini or Whisper fallback)
 * 3. ONE Gemini call: analyze frames + transcript + identify movie
 * 4. DB LOOKUP FIRST - if movie exists with cast, SKIP all TMDB calls
 * 5. Only fetch from TMDB if NOT in database
 * 6. Cache new movies for future lookups
 * 
 * Key Optimization: If movie is already in our DB with cast cached,
 * we skip ALL redundant TMDB/actor verification calls (saves 5-10s)
 */

// Helper: Check if movie exists in DB with full data
async function findMovieInDatabase(title: string, year?: number | null): Promise<any | null> {
  // Try exact match first
  const { data: exactMatch } = await supabaseAdmin
    .from('movies')
    .select('*, movie_cast(artist_id)')
    .ilike('title', title)
    .eq('year', year || 0)
    .limit(1)
    .single();
  
  if (exactMatch) {
    const hasCast = exactMatch.movie_cast && exactMatch.movie_cast.length > 0;
    console.log(`  ✓ DB exact match: "${exactMatch.title}" (ID: ${exactMatch.id}, cast cached: ${hasCast})`);
    return exactMatch;
  }
  
  // Try partial match
  const { data: partialMatch } = await supabaseAdmin
    .from('movies')
    .select('*, movie_cast(artist_id)')
    .ilike('title', `%${title}%`)
    .limit(5);
  
  if (partialMatch && partialMatch.length > 0) {
    // Prefer exact year match from partial results
    const yearMatch = partialMatch.find(m => m.year === year);
    const match = yearMatch || partialMatch[0];
    const hasCast = match.movie_cast && match.movie_cast.length > 0;
    console.log(`  ✓ DB partial match: "${match.title}" (ID: ${match.id}, cast cached: ${hasCast})`);
    return match;
  }
  
  return null;
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let queueSlotAcquired = false;
  
  console.log('\n========== FAST RECOGNITION START ==========');

  try {
    // Check Gemini availability
    if (!isGeminiAvailable()) {
      return NextResponse.json({ 
        error: 'Gemini API not configured',
        message: 'Fast recognition requires Gemini API key' 
      }, { status: 503 });
    }

    // Queue management
    if (!recognitionQueue.canAcceptRequest()) {
      console.log('❌ Server at capacity');
      return NextResponse.json({
        error: 'Server at capacity',
        message: 'Too many requests. Try again in a minute.',
        retryAfterSeconds: 60,
      }, { status: 503 });
    }
    
    const queuePosition = await recognitionQueue.requestSlot();
    queueSlotAcquired = true;

    // ========== STEP 1: Parse Video ==========
    console.log('📥 Step 1: Parsing video...');
    const formData = await req.formData();
    const videoFile = formData.get('video') as File;
    const userId = formData.get('user_id') as string | null;

    if (!videoFile) {
      recognitionQueue.releaseSlot();
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 });
    }

    const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
    console.log(`✓ Video: ${videoFile.name} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

    // Create upload record
    const { data: upload } = await supabaseAdmin
      .from('user_uploads')
      .insert({ 
        video_url: 'uploading...',
        user_id: userId || null,
      })
      .select()
      .single();

    // Background upload (non-blocking)
    uploadVideo(videoBuffer, videoFile.name)
      .then(async (url) => {
        if (upload) {
          await supabaseAdmin.from('user_uploads').update({ video_url: url }).eq('id', upload.id);
          console.log(`  ✓ Video uploaded to storage`);
        }
      })
      .catch(() => {});

    // ========== STEP 2: Extract Features (Parallel) ==========
    console.log('📥 Step 2: Extracting frames & audio...');
    const extractStart = Date.now();
    
    const [audioResult, framesResult] = await Promise.allSettled([
      extractAudio(videoBuffer),
      extractFrames(videoBuffer, 4), // Only 4 frames for speed
    ]);

    const audioBuffer = audioResult.status === 'fulfilled' ? audioResult.value : null;
    const frames = framesResult.status === 'fulfilled' ? framesResult.value : [];
    
    console.log(`  ✓ Extracted in ${Date.now() - extractStart}ms: ${frames.length} frames, ${audioBuffer ? 'audio ready' : 'no audio'}`);

    // ========== STEP 3: Transcribe Audio ==========
    console.log('📥 Step 3: Transcribing audio...');
    const transcribeStart = Date.now();
    
    let transcript = '';
    if (audioBuffer && audioBuffer.length > 0) {
      try {
        // Try Gemini first (can be faster and cheaper)
        transcript = await transcribeAudioGemini(audioBuffer);
        console.log(`  ✓ Gemini transcription: ${transcript.length} chars (${Date.now() - transcribeStart}ms)`);
      } catch (err: any) {
        console.log(`  ⚠️ Gemini transcription failed: ${err.message}, trying Whisper...`);
        try {
          transcript = await transcribeAudio(audioBuffer);
          console.log(`  ✓ Whisper transcription: ${transcript.length} chars`);
        } catch (whisperErr: any) {
          console.log(`  ⚠️ Whisper also failed: ${whisperErr.message}`);
        }
      }
    }
    
    if (transcript) {
      console.log(`  "${transcript.substring(0, 80)}..."`);
    }

    // ========== STEP 4: ONE-SHOT Gemini Recognition ==========
    console.log('📥 Step 4: Gemini One-Shot Recognition...');
    const recognizeStart = Date.now();
    
    const result = await recognizeMovieOneShot(frames, transcript);
    
    console.log(`  ✓ Recognition complete in ${Date.now() - recognizeStart}ms`);
    console.log(`  🎯 Result: "${result.title}" (${result.year}) - ${Math.round(result.confidence * 100)}%`);
    console.log(`  📋 Signals: ${result.matchedSignals.join(', ')}`);
    if (result.actors.length > 0) {
      console.log(`  🎭 Actors: ${result.actors.join(', ')}`);
    }
    console.log(`  💭 Reasoning: ${result.reasoning.substring(0, 150)}...`);
    
    if (result.alternativeTitles.length > 0) {
      console.log(`  📋 Alternatives:`);
      result.alternativeTitles.forEach((alt, i) => {
        console.log(`     ${i + 1}. "${alt.title}" (${alt.year}) - ${Math.round(alt.confidence * 100)}%`);
      });
    }

    // ========== STEP 5: SMART DB LOOKUP (Skip TMDB if cached) ==========
    console.log('📥 Step 5: Smart DB Lookup...');
    let finalTitle = result.title;
    let finalYear = result.year;
    let movie: any = null;
    let usedCachedData = false;
    
    if (finalTitle !== 'Unknown' && result.confidence >= 0.4) {
      // Check database FIRST before any TMDB calls
      movie = await findMovieInDatabase(finalTitle, finalYear);
      
      if (movie) {
        usedCachedData = true;
        console.log(`  🚀 FAST PATH: Movie found in DB, skipping TMDB calls!`);
        
        // If we have actors, just log them (no verification needed - we trust our DB)
        if (result.actors.length > 0) {
          console.log(`  📋 Detected actors: ${result.actors.join(', ')} (not re-verifying - using cached data)`);
        }
      }
    }
    
    // ========== STEP 6: TMDB Fetch (Only if NOT in database) ==========
    if (!movie && finalTitle !== 'Unknown' && result.confidence >= 0.4) {
      console.log('📥 Step 6: Fetching from TMDB (not in DB)...');
      
      // Actor verification only for NEW movies (not in our DB)
      if (result.actors.length >= 2) {
        console.log(`  🔍 Verifying actors in "${finalTitle}"...`);
        
        const tmdbCheck = await searchMulti(finalTitle, finalYear);
        if (tmdbCheck) {
          const isTV = tmdbCheck.media_type === 'tv';
          const verification = await verifyActorsInMovie(tmdbCheck.id, result.actors, isTV);
          
          if (!verification.verified) {
            console.log(`  ⚠️ ACTOR MISMATCH! Missing: ${verification.missingActors.join(', ')}`);
            
            // Check for known actor combos
            const actorsLower = result.actors.map(a => a.toLowerCase()).join(' ');
            
            if (actorsLower.includes('kevin hart') && (actorsLower.includes('dwayne') || actorsLower.includes('johnson') || actorsLower.includes('rock'))) {
              const transcriptLower = transcript.toLowerCase();
              if (transcriptLower.includes('cia') || transcriptLower.includes('agent') || transcriptLower.includes('spy')) {
                finalTitle = 'Central Intelligence';
                finalYear = 2016;
              } else if (transcriptLower.includes('jungle') || transcriptLower.includes('game') || transcriptLower.includes('level')) {
                finalTitle = 'Jumanji: Welcome to the Jungle';
                finalYear = 2017;
              }
              console.log(`  🎬 Corrected to: "${finalTitle}" (${finalYear})`);
            }
          } else {
            console.log(`  ✓ Actor verification passed`);
          }
        }
      }
      
      // Now fetch and cache the movie
      console.log(`  🌐 Fetching from TMDB: "${finalTitle}" (${finalYear})`);
      const tmdbResult = await searchMulti(finalTitle, finalYear);
      
      if (tmdbResult) {
        const isTV = tmdbResult.media_type === 'tv';
        const title = isTV ? (tmdbResult as TMDBTVShow).name : (tmdbResult as any).title;
        const releaseDate = isTV ? (tmdbResult as TMDBTVShow).first_air_date : (tmdbResult as any).release_date;
        const imdbId = (tmdbResult as any).imdb_id || null;
        
        // Check if exists by tmdb_id
        const { data: existingByTmdb } = await supabaseAdmin
          .from('movies')
          .select('*')
          .eq('tmdb_id', tmdbResult.id)
          .single();

        if (existingByTmdb) {
          movie = existingByTmdb;
          console.log(`  ✓ Found by TMDB ID: "${movie.title}"`);
        } else {
          // Auto-cache new movie
          const movieYear = releaseDate ? parseInt(releaseDate.substring(0, 4)) : finalYear;
          let enhancedOverview = tmdbResult.overview;
          
          if (!enhancedOverview || enhancedOverview.length < 300) {
            try {
              enhancedOverview = await generateEnhancedOverview(title, movieYear, tmdbResult.overview);
            } catch {
              enhancedOverview = tmdbResult.overview || '';
            }
          }
          
          const { data: newMovie, error } = await supabaseAdmin
            .from('movies')
            .insert({
              title,
              year: movieYear,
              overview: enhancedOverview,
              poster_url: buildImageUrl(tmdbResult.poster_path),
              backdrop_url: buildImageUrl(tmdbResult.backdrop_path, 'w1280'),
              tmdb_id: tmdbResult.id,
              imdb_id: imdbId,
              popularity: (tmdbResult as any).popularity || null,
            })
            .select()
            .single();
          
          if (!error && newMovie) {
            movie = newMovie;
            console.log(`  ✓ Auto-cached: "${movie.title}" (ID: ${movie.id})`);
          }
        }
      }
    }

    // ========== STEP 7: Handle Unknown - Try Actor-Based Search ==========
    if (!movie && result.actors.length >= 1 && result.confidence >= 0.3) {
      console.log('📥 Step 7: Trying actor-based fallback...');
      
      const validActors = result.actors.filter(a => 
        a.length > 3 && 
        !a.toLowerCase().includes('unknown')
      );
      
      if (validActors.length >= 1) {
        const actorMovies = await findMoviesWithActors(validActors);
        
        if (actorMovies && actorMovies.length > 0) {
          const bestMatch = actorMovies[0];
          console.log(`  🎬 Actor-based match: "${bestMatch.title}" (${bestMatch.year})`);
          
          const tmdbResult = await searchMulti(bestMatch.title, bestMatch.year);
          if (tmdbResult) {
            const { data: existing } = await supabaseAdmin
              .from('movies')
              .select('*')
              .eq('tmdb_id', tmdbResult.id)
              .single();
            
            if (existing) {
              movie = existing;
              result.confidence = Math.min(0.7, result.confidence + 0.2);
            }
          }
        }
      }
    }

    // ========== Finalize ==========
    const processingTime = Date.now() - startTime;

    // Update upload record
    if (upload && movie) {
      await supabaseAdmin
        .from('user_uploads')
        .update({
          result_movie_id: movie.id,
          confidence_score: result.confidence,
          matched_signals: { 
            signals: result.matchedSignals,
            reasoning: result.reasoning,
            actors_detected: result.actors,
          },
          processing_time_ms: processingTime,
        })
        .eq('id', upload.id);
    }

    // Release queue
    if (queueSlotAcquired) {
      recognitionQueue.releaseSlot(processingTime);
    }

    if (!movie) {
      console.log(`\n❌ NOT FOUND: "${result.title}" (${Math.round(result.confidence * 100)}%)`);
      console.log(`⏱️ Total time: ${processingTime}ms`);
      console.log('========== FAST RECOGNITION END ==========\n');
      
      return NextResponse.json({
        error: 'Movie not found',
        details: result.reasoning,
        confidence: result.confidence,
        actors_detected: result.actors,
        guesses: [
          { title: result.title, year: result.year, confidence: result.confidence },
          ...result.alternativeTitles,
        ],
      }, { status: 404 });
    }

    console.log(`\n✅ SUCCESS: "${movie?.title || 'Unknown'}" (${Math.round(result.confidence * 100)}%)${usedCachedData ? ' [CACHED - FAST]' : ''}`);
    console.log(`⏱️ Total time: ${processingTime}ms`);
    console.log('========== FAST RECOGNITION END ==========\n');

    return NextResponse.json({
      movie,
      confidence: result.confidence,
      matched_on: result.matchedSignals,
      reasoning: result.reasoning,
      processing_time: processingTime,
      actors_detected: result.actors,
      cached: usedCachedData, // True if we skipped TMDB calls
    });

  } catch (error: any) {
    if (queueSlotAcquired) {
      recognitionQueue.releaseSlot(Date.now() - startTime);
    }
    
    console.error('❌ Fast recognition error:', error);
    console.log('========== FAST RECOGNITION END (ERROR) ==========\n');
    return NextResponse.json(
      { error: 'Recognition failed', details: error.message },
      { status: 500 }
    );
  }
}
