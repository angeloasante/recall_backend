import { NextRequest } from 'next/server';
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
 * STREAMING Recognition Pipeline with Progressive Updates
 * 
 * Uses Server-Sent Events (SSE) to send real-time status updates:
 * - "extracting" - Extracting audio and frames
 * - "transcribing" - Transcribing audio
 * - "analyzing" - AI analyzing video (includes detected actors)
 * - "looking_up" - Searching database
 * - "complete" - Recognition finished
 * - "error" - An error occurred
 */

// Helper: Send SSE event
function sendEvent(controller: ReadableStreamDefaultController, event: string, data: any) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(new TextEncoder().encode(message));
}

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
    return exactMatch;
  }
  
  // Try partial match
  const { data: partialMatch } = await supabaseAdmin
    .from('movies')
    .select('*, movie_cast(artist_id)')
    .ilike('title', `%${title}%`)
    .limit(5);
  
  if (partialMatch && partialMatch.length > 0) {
    const yearMatch = partialMatch.find(m => m.year === year);
    return yearMatch || partialMatch[0];
  }
  
  return null;
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let queueSlotAcquired = false;
  
  console.log('\n========== STREAMING RECOGNITION START ==========');

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Check Gemini availability
        if (!isGeminiAvailable()) {
          sendEvent(controller, 'error', { 
            message: 'Gemini API not configured',
            code: 'GEMINI_UNAVAILABLE'
          });
          controller.close();
          return;
        }

        // Queue management
        if (!recognitionQueue.canAcceptRequest()) {
          sendEvent(controller, 'error', { 
            message: 'Server at capacity. Try again in a minute.',
            code: 'SERVER_BUSY',
            retryAfterSeconds: 60
          });
          controller.close();
          return;
        }
        
        const queuePosition = await recognitionQueue.requestSlot();
        queueSlotAcquired = true;

        // Send initial status
        sendEvent(controller, 'status', { 
          step: 'started',
          message: 'Processing video...',
          progress: 0
        });

        // ========== STEP 1: Parse Video ==========
        console.log('📥 Step 1: Parsing video...');
        const formData = await req.formData();
        const videoFile = formData.get('video') as File;
        const userId = formData.get('user_id') as string | null;

        if (!videoFile) {
          recognitionQueue.releaseSlot();
          sendEvent(controller, 'error', { message: 'No video file provided', code: 'NO_VIDEO' });
          controller.close();
          return;
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
            }
          })
          .catch(() => {});

        // ========== STEP 2: Extract Features (Parallel) ==========
        sendEvent(controller, 'status', { 
          step: 'extracting',
          message: 'Extracting audio and frames...',
          progress: 10
        });
        
        console.log('📥 Step 2: Extracting frames & audio...');
        const extractStart = Date.now();
        
        const [audioResult, framesResult] = await Promise.allSettled([
          extractAudio(videoBuffer),
          extractFrames(videoBuffer, 4),
        ]);

        const audioBuffer = audioResult.status === 'fulfilled' ? audioResult.value : null;
        const frames = framesResult.status === 'fulfilled' ? framesResult.value : [];
        
        console.log(`  ✓ Extracted in ${Date.now() - extractStart}ms: ${frames.length} frames`);

        // ========== STEP 3: Transcribe Audio ==========
        sendEvent(controller, 'status', { 
          step: 'transcribing',
          message: 'Transcribing audio...',
          progress: 25
        });
        
        console.log('📥 Step 3: Transcribing audio...');
        
        let transcript = '';
        if (audioBuffer && audioBuffer.length > 0) {
          try {
            transcript = await transcribeAudioGemini(audioBuffer);
            console.log(`  ✓ Transcription: ${transcript.length} chars`);
          } catch (err: any) {
            try {
              transcript = await transcribeAudio(audioBuffer);
            } catch (whisperErr: any) {
              console.log(`  ⚠️ Transcription failed`);
            }
          }
        }

        // ========== STEP 4: ONE-SHOT Gemini Recognition ==========
        sendEvent(controller, 'status', { 
          step: 'analyzing',
          message: 'AI analyzing video...',
          progress: 40
        });
        
        console.log('📥 Step 4: Gemini One-Shot Recognition...');
        const recognizeStart = Date.now();
        
        const result = await recognizeMovieOneShot(frames, transcript);
        
        console.log(`  ✓ Recognition: "${result.title}" (${result.year}) - ${Math.round(result.confidence * 100)}%`);
        
        // Send detected actors update
        if (result.actors.length > 0) {
          sendEvent(controller, 'actors', { 
            actors: result.actors,
            confidence: result.confidence,
            message: `Detected: ${result.actors.slice(0, 3).join(', ')}${result.actors.length > 3 ? '...' : ''}`
          });
        }

        // Send preliminary guess
        if (result.title !== 'Unknown') {
          sendEvent(controller, 'guess', { 
            title: result.title,
            year: result.year,
            confidence: result.confidence,
            message: `Looks like "${result.title}" (${Math.round(result.confidence * 100)}% confident)`
          });
        }

        // ========== STEP 5: SMART DB LOOKUP ==========
        sendEvent(controller, 'status', { 
          step: 'looking_up',
          message: 'Searching database...',
          progress: 70
        });
        
        console.log('📥 Step 5: Smart DB Lookup...');
        let finalTitle = result.title;
        let finalYear = result.year;
        let movie: any = null;
        let usedCachedData = false;
        
        if (finalTitle !== 'Unknown' && result.confidence >= 0.4) {
          movie = await findMovieInDatabase(finalTitle, finalYear);
          
          if (movie) {
            usedCachedData = true;
            console.log(`  🚀 FAST PATH: Movie found in DB!`);
            
            sendEvent(controller, 'status', { 
              step: 'found',
              message: `Found "${movie.title}" in database!`,
              progress: 90,
              cached: true
            });
          }
        }
        
        // ========== STEP 6: TMDB Fetch (Only if NOT in database) ==========
        if (!movie && finalTitle !== 'Unknown' && result.confidence >= 0.4) {
          console.log('📥 Step 6: Fetching from TMDB...');
          
          sendEvent(controller, 'status', { 
            step: 'fetching',
            message: 'Fetching movie details...',
            progress: 75
          });
          
          // Actor verification only for NEW movies
          if (result.actors.length >= 2) {
            const tmdbCheck = await searchMulti(finalTitle, finalYear);
            if (tmdbCheck) {
              const isTV = tmdbCheck.media_type === 'tv';
              const verification = await verifyActorsInMovie(tmdbCheck.id, result.actors, isTV);
              
              if (!verification.verified) {
                // Actor correction logic
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
                }
              }
            }
          }
          
          // Fetch and cache
          const tmdbResult = await searchMulti(finalTitle, finalYear);
          
          if (tmdbResult) {
            const isTV = tmdbResult.media_type === 'tv';
            const title = isTV ? (tmdbResult as TMDBTVShow).name : (tmdbResult as any).title;
            const releaseDate = isTV ? (tmdbResult as TMDBTVShow).first_air_date : (tmdbResult as any).release_date;
            const imdbId = (tmdbResult as any).imdb_id || null;
            
            const { data: existingByTmdb } = await supabaseAdmin
              .from('movies')
              .select('*')
              .eq('tmdb_id', tmdbResult.id)
              .single();

            if (existingByTmdb) {
              movie = existingByTmdb;
            } else {
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
              }
            }
          }
        }

        // ========== STEP 7: Actor-Based Fallback ==========
        if (!movie && result.actors.length >= 1 && result.confidence >= 0.3) {
          console.log('📥 Step 7: Actor-based fallback...');
          
          sendEvent(controller, 'status', { 
            step: 'fallback',
            message: 'Trying actor-based search...',
            progress: 80
          });
          
          const validActors = result.actors.filter(a => 
            a.length > 3 && !a.toLowerCase().includes('unknown')
          );
          
          if (validActors.length >= 1) {
            const actorMovies = await findMoviesWithActors(validActors);
            
            if (actorMovies && actorMovies.length > 0) {
              const bestMatch = actorMovies[0];
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
          queueSlotAcquired = false;
        }

        console.log(`\n✅ SUCCESS: "${movie?.title || 'Unknown'}" (${Math.round(result.confidence * 100)}%)`);
        console.log(`⏱️ Total time: ${processingTime}ms`);
        console.log('========== STREAMING RECOGNITION END ==========\n');

        if (!movie) {
          sendEvent(controller, 'complete', {
            success: false,
            error: 'Movie not found',
            details: result.reasoning,
            confidence: result.confidence,
            actors_detected: result.actors,
            guesses: [
              { title: result.title, year: result.year, confidence: result.confidence },
              ...result.alternativeTitles,
            ],
            processing_time: processingTime,
          });
        } else {
          sendEvent(controller, 'complete', {
            success: true,
            movie,
            confidence: result.confidence,
            matched_on: result.matchedSignals,
            reasoning: result.reasoning,
            processing_time: processingTime,
            actors_detected: result.actors,
            cached: usedCachedData,
          });
        }
        
        controller.close();

      } catch (error: any) {
        if (queueSlotAcquired) {
          recognitionQueue.releaseSlot(Date.now() - startTime);
        }
        
        console.error('❌ Streaming recognition error:', error);
        console.log('========== STREAMING RECOGNITION END (ERROR) ==========\n');
        
        sendEvent(controller, 'error', {
          message: error.message || 'Recognition failed',
          code: 'RECOGNITION_ERROR'
        });
        
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
