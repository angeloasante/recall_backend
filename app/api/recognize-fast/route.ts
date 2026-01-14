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
  console.log(`  🔎 Searching DB for: "${title}" (${year || 'any year'})`);
  
  // Try exact title match first (case insensitive) - simple query without joins
  const { data: exactMatches, error: exactError } = await supabaseAdmin
    .from('movies')
    .select('*')
    .ilike('title', title)
    .limit(5);
  
  if (exactError) {
    console.log(`  ⚠️ DB query error: ${exactError.message}`);
  }
  
  if (exactMatches && exactMatches.length > 0) {
    console.log(`  📊 Found ${exactMatches.length} exact title matches: ${exactMatches.map(m => `"${m.title}" (${m.year})`).join(', ')}`);
    
    // If year provided, prefer year match
    if (year) {
      const yearMatch = exactMatches.find(m => m.year === year);
      if (yearMatch) {
        console.log(`  ✓ DB exact match with year: "${yearMatch.title}" (ID: ${yearMatch.id}, year: ${yearMatch.year})`);
        return yearMatch;
      }
    }
    
    // Return first match if no year match
    const match = exactMatches[0];
    console.log(`  ✓ DB exact title match: "${match.title}" (ID: ${match.id}, year: ${match.year})`);
    return match;
  }
  
  // Try partial match (contains title)
  const { data: partialMatches } = await supabaseAdmin
    .from('movies')
    .select('*')
    .ilike('title', `%${title}%`)
    .limit(5);
  
  if (partialMatches && partialMatches.length > 0) {
    console.log(`  📊 Found ${partialMatches.length} partial matches: ${partialMatches.map(m => `"${m.title}" (${m.year})`).join(', ')}`);
    
    // Prefer exact year match from partial results
    if (year) {
      const yearMatch = partialMatches.find(m => m.year === year);
      if (yearMatch) {
        console.log(`  ✓ DB partial match with year: "${yearMatch.title}" (ID: ${yearMatch.id})`);
        return yearMatch;
      }
    }
    
    const match = partialMatches[0];
    console.log(`  ✓ DB partial match: "${match.title}" (ID: ${match.id})`);
    return match;
  }
  
  console.log(`  ❌ No match found in DB for "${title}"`);
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
    const videoSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`✓ Video: ${videoFile.name} (${videoSizeMB}MB)`);

    // Create upload record
    const { data: upload } = await supabaseAdmin
      .from('user_uploads')
      .insert({ 
        video_url: null, // Not storing videos to save storage costs
        user_id: userId || null,
      })
      .select()
      .single();

    // Video upload disabled - not needed for display, saves storage
    // uploadVideo(videoBuffer, videoFile.name)
    //   .then(async (url) => {
    //     if (upload) {
    //       await supabaseAdmin.from('user_uploads').update({ video_url: url }).eq('id', upload.id);
    //     }
    //   })
    //   .catch(() => {});

    // ========== STEP 2: Extract Features (Parallel) ==========
    console.log('📥 Step 2: Extracting frames & audio...');
    const extractStart = Date.now();
    
    const [audioResult, framesResult] = await Promise.allSettled([
      extractAudio(videoBuffer),
      extractFrames(videoBuffer, 2), // Only 2 frames (start + middle) for speed
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

    // ========== INSTANT RETURN: High confidence DB match ==========
    // If confidence ≥ 92% and we find it in DB, return immediately (no more steps)
    if (result.title !== 'Unknown' && result.confidence >= 0.92) {
      const instantMovie = await findMovieInDatabase(result.title, result.year);
      
      if (instantMovie) {
        const processingTime = Date.now() - startTime;
        
        // Background: Update upload record (fire-and-forget)
        if (upload) {
          Promise.resolve(
            supabaseAdmin
              .from('user_uploads')
              .update({
                result_movie_id: instantMovie.id,
                confidence_score: result.confidence,
                matched_signals: { 
                  signals: result.matchedSignals,
                  reasoning: result.reasoning,
                  actors_detected: result.actors,
                },
                processing_time_ms: processingTime,
              })
              .eq('id', upload.id)
          ).catch(() => {});
        }

        if (queueSlotAcquired) {
          recognitionQueue.releaseSlot(processingTime);
        }

        console.log(`\n⚡ INSTANT: "${instantMovie.title}" (${Math.round(result.confidence * 100)}%) [HIGH CONFIDENCE + CACHED]`);
        console.log(`⏱️ Total time: ${processingTime}ms`);
        console.log('========== FAST RECOGNITION END ==========\n');

        return NextResponse.json({
          movie: instantMovie,
          confidence: result.confidence,
          matched_on: result.matchedSignals,
          reasoning: result.reasoning,
          processing_time: processingTime,
          actors_detected: result.actors,
          cached: true,
          instant: true,
        });
      }
    }

    // ========== STEP 5: SMART DB LOOKUP (Skip TMDB if cached) ==========
    console.log('📥 Step 5: Smart DB Lookup...');
    let finalTitle = result.title;
    let finalYear = result.year;
    let movie: any = null;
    let usedCachedData = false;
    
    // Transcript-based keyword override for commonly misidentified content
    const transcriptLower = transcript.toLowerCase();
    if (transcriptLower.includes('war') && (transcriptLower.includes('land') || transcriptLower.includes('sea')) && 
        (transcriptLower.includes('aquatic') || transcriptLower.includes('gills') || transcriptLower.includes('scales') || 
         transcriptLower.includes('ocean') || transcriptLower.includes('defeated'))) {
      console.log(`  🎯 Transcript keywords detected: war/land/sea/aquatic - checking for "The War Between the Land and the Sea"`);
      const seaWarMovie = await findMovieInDatabase('The War Between the Land and the Sea', 2025);
      if (seaWarMovie) {
        movie = seaWarMovie;
        finalTitle = seaWarMovie.title;
        finalYear = seaWarMovie.year;
        usedCachedData = true;
        console.log(`  ✓ Transcript-based match: "${movie.title}"`);
      }
    }
    
    if (!movie && finalTitle !== 'Unknown' && result.confidence >= 0.4) {
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
          // Auto-cache new movie (FAST - no AI enhancement, just TMDB data)
          const movieYear = releaseDate ? parseInt(releaseDate.substring(0, 4)) : finalYear;
          // Skip AI enhancement for speed - use TMDB overview directly
          const overview = tmdbResult.overview || '';
          
          const { data: newMovie, error } = await supabaseAdmin
            .from('movies')
            .insert({
              title,
              year: movieYear,
              overview: overview,
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
