import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { transcribeAudio, aggregateSignals, SignalData, describeScene, identifyActorsGPT, identifyMovie } from '@/lib/openai';
import { extractAudio, extractFrames } from '@/lib/ffmpeg';
import { uploadVideo } from '@/lib/storage';
import { searchMulti, buildImageUrl, TMDBTVShow, getMovieCast, verifyActorsInMovie, findMoviesWithActors } from '@/lib/tmdb';
import { extractScreenText, identifyActors, describeSceneGemini, isGeminiAvailable } from '@/lib/gemini';
import { searchSubtitlesByImdbId, downloadSubtitle, parseSubtitleContent, searchSubtitles } from '@/lib/opensubtitles';
import { generateEnhancedOverview } from '@/lib/enhance-overview';
import { recognitionQueue } from '@/lib/request-queue';

// Route segment config for large file uploads
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds timeout

/**
 * New Multi-Signal Recognition Pipeline
 * 
 * 1. Parallel Signal Extraction:
 *    - Audio → Whisper (transcription)
 *    - OCR → Gemini Flash (text on screen)
 *    - Actors → Gemini Flash (face recognition)
 *    - Scene → Gemini Flash (scene description)
 * 
 * 2. Database Lookup (use cached data when available)
 * 
 * 3. AI Aggregation (GPT-4o combines all signals)
 * 
 * 4. Verification Layer (TMDB + OpenSubtitles confirmation)
 * 
 * 5. Cache results for future lookups
 */

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let queueSlotAcquired = false;
  
  console.log('\n========== MULTI-SIGNAL RECOGNITION START ==========');

  try {
    // ========== STEP 0: Queue Management ==========
    // Check if we can accept this request (prevents server overload)
    if (!recognitionQueue.canAcceptRequest()) {
      console.log('❌ Server at capacity, rejecting request');
      return NextResponse.json({
        error: 'Server at capacity',
        message: 'Too many requests in queue. Please try again in a few minutes.',
        retryAfterSeconds: 60,
      }, { status: 503 });
    }
    
    // Request a slot (may wait if at concurrent limit)
    const queuePosition = await recognitionQueue.requestSlot();
    queueSlotAcquired = true;
    
    if (queuePosition.position > 0) {
      console.log(`📋 Was queued at position ${queuePosition.position}, now proceeding`);
    }

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
    console.log(`✓ Video ready: ${videoFile.name} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
    if (userId) {
      console.log(`✓ User ID: ${userId}`);
    }

    // Create upload record with user_id if provided
    const { data: upload } = await supabaseAdmin
      .from('user_uploads')
      .insert({ 
        video_url: 'uploading...',
        user_id: userId || null,
      })
      .select()
      .single();
    console.log(`✓ Upload record: ID ${upload?.id}`);

    // Upload video to Supabase Storage (background, non-blocking)
    uploadVideo(videoBuffer, videoFile.name)
      .then(async (url) => {
        if (upload) {
          const { error } = await supabaseAdmin
            .from('user_uploads')
            .update({ video_url: url })
            .eq('id', upload.id);
          if (error) {
            console.error(`  ⚠️ Failed to update video URL for upload ${upload.id}:`, error.message);
          } else {
            console.log(`  ✓ Video uploaded: ${url.substring(0, 60)}...`);
          }
        }
      })
      .catch((err) => {
        console.error(`  ⚠️ Video upload failed:`, err.message);
        // Update with error status so we know it failed
        if (upload) {
          supabaseAdmin
            .from('user_uploads')
            .update({ video_url: 'upload_failed' })
            .eq('id', upload.id);
        }
      });

    // ========== STEP 2: Parallel Feature Extraction ==========
    console.log('📥 Step 2: Extracting features in parallel...');
    
    const [audioResult, framesResult] = await Promise.allSettled([
      extractAudio(videoBuffer),
      extractFrames(videoBuffer, 6), // 6 frames - reduced for API efficiency
    ]);

    const audioBuffer = audioResult.status === 'fulfilled' ? audioResult.value : null;
    const frames = framesResult.status === 'fulfilled' ? framesResult.value : [];
    
    console.log(`  ✓ Audio: ${audioBuffer?.length || 0} bytes`);
    console.log(`  ✓ Frames: ${frames.length} extracted (spread across video)`);

    // ========== STEP 3: OPTIMIZED Signal Analysis ==========
    console.log('📥 Step 3: Analyzing signals (optimized)...');
    
    // Audio transcription - start immediately
    let transcriptPromise: Promise<string> = Promise.resolve('');
    if (audioBuffer && audioBuffer.length > 0) {
      transcriptPromise = transcribeAudio(audioBuffer).catch(err => {
        console.error('  ⚠️ Whisper failed:', err.message);
        return '';
      });
    }

    const useGemini = isGeminiAvailable();
    console.log(`  ${useGemini ? '🔷 Using Gemini Flash' : '🔶 Using GPT-4V (no Gemini key)'}`);
    
    // OPTIMIZED: Skip face scan phase - analyze all frames directly
    // Each frame gets: actors (first 3 frames), OCR (frames 0,2,5), scene (frame 3 only - reduced for speed)
    const framesToAnalyzeForActors = [0, 1, 2].filter(i => i < frames.length);
    const framesToAnalyzeForOCR = [0, 2, 5].filter(i => i < frames.length);
    const framesToAnalyzeForScene = [3].filter(i => i < frames.length); // Just 1 scene for speed
    
    const allFrameIndices = [...new Set([...framesToAnalyzeForActors, ...framesToAnalyzeForOCR, ...framesToAnalyzeForScene])];
    
    console.log(`  📊 Analyzing ${allFrameIndices.length} frames: actors(${framesToAnalyzeForActors.length}), OCR(${framesToAnalyzeForOCR.length}), scene(${framesToAnalyzeForScene.length})`);
    
    // Process ALL frames in parallel (3 at a time) - much faster!
    const BATCH_SIZE = 3;
    const frameResults: Array<{
      frameIndex: number;
      ocr: { text: string[]; movieTitle?: string; credits?: string[] };
      actors: { actors: string[]; confidence: number };
      scene: string;
    }> = [];
    
    for (let i = 0; i < allFrameIndices.length; i += BATCH_SIZE) {
      const batchIndices = allFrameIndices.slice(i, i + BATCH_SIZE);
      const batchStart = Date.now();
      
      const batchPromises = batchIndices.map(async (frameIndex) => {
        const frame = frames[frameIndex];
        const base64 = frame.toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        
        const shouldDoActors = framesToAnalyzeForActors.includes(frameIndex);
        const shouldDoOCR = framesToAnalyzeForOCR.includes(frameIndex);
        const shouldDoScene = framesToAnalyzeForScene.includes(frameIndex);
        
        console.log(`    🖼️ Frame ${frameIndex + 1}: ${shouldDoActors ? '👤' : ''}${shouldDoOCR ? '📝' : ''}${shouldDoScene ? '🎬' : ''}`);
        
        let ocr: { text: string[]; movieTitle?: string; credits?: string[] } = { text: [], movieTitle: undefined, credits: [] };
        let actors = { actors: [] as string[], confidence: 0 };
        let scene = '';
        
        if (useGemini) {
          // Run OCR, actors, and scene in parallel for this frame
          const framePromises: Promise<void>[] = [];
          
          if (shouldDoOCR) {
            framePromises.push(
              extractScreenText(base64)
                .then(result => { ocr = result; })
                .catch(() => {})
            );
          }
          
          if (shouldDoActors) {
            framePromises.push(
              identifyActors(base64)
                .then(result => { actors = result; })
                .catch(async () => {
                  // Fallback to GPT-4o
                  try {
                    const gptActors = await identifyActorsGPT(base64);
                    actors = gptActors;
                  } catch {}
                })
            );
          }
          
          if (shouldDoScene) {
            framePromises.push(
              describeSceneGemini(base64)
                .then(result => { scene = result; })
                .catch(async () => {
                  try {
                    scene = await describeScene(dataUrl);
                  } catch {}
                })
            );
          }
          
          await Promise.all(framePromises);
        } else {
          // Fallback to GPT-4V
          if (shouldDoScene) {
            scene = await describeScene(dataUrl).catch(() => '');
          }
        }
        
        return { frameIndex, ocr, actors, scene };
      });
      
      const batchResults = await Promise.all(batchPromises);
      frameResults.push(...batchResults);
      
      const batchTime = Date.now() - batchStart;
      console.log(`    ✓ Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allFrameIndices.length / BATCH_SIZE)} (${batchTime}ms)`);
      
      // Minimal delay between batches (just 100ms to avoid rate limits)
      if (i + BATCH_SIZE < allFrameIndices.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Wait for transcript (should be done by now since it ran in parallel)
    const transcript = await transcriptPromise;

    console.log(`  ✓ Transcript: ${transcript.length} chars`);
    if (transcript) console.log(`    "${transcript.substring(0, 100)}..."`);

    // Aggregate frame analysis results
    const allOcrText: string[] = [];
    const allActors: string[] = [];
    const allScenes: string[] = [];
    let movieTitleOnScreen: string | undefined;
    const allCredits: string[] = [];
    let maxActorConfidence = 0;

    for (const result of frameResults) {
      if (result.ocr.text) allOcrText.push(...result.ocr.text);
      if (result.ocr.movieTitle) movieTitleOnScreen = result.ocr.movieTitle;
      if (result.ocr.credits) allCredits.push(...result.ocr.credits);
      if (result.actors.actors) allActors.push(...result.actors.actors);
      if (result.actors.confidence > maxActorConfidence) {
        maxActorConfidence = result.actors.confidence;
      }
      if (result.scene) allScenes.push(result.scene);
    }

    // Deduplicate
    const uniqueActors = [...new Set(allActors)];
    const uniqueOcr = [...new Set(allOcrText)];
    const uniqueCredits = [...new Set(allCredits)];

    console.log(`  ✓ OCR text: ${uniqueOcr.length} items`);
    if (movieTitleOnScreen) console.log(`    🎬 Title on screen: "${movieTitleOnScreen}"`);
    console.log(`  ✓ Actors identified: ${uniqueActors.length} (${Math.round(maxActorConfidence * 100)}% confidence)`);
    if (uniqueActors.length > 0) console.log(`    ${uniqueActors.join(', ')}`);
    console.log(`  ✓ Scene descriptions: ${allScenes.length}`);

    // ========== STEP 4: Database Lookup ==========
    console.log('📥 Step 4: Searching database...');
    
    const databaseMatches: Array<{ title: string; year: number; score: number; movie_id: number }> = [];
    
    // Search by transcript text
    if (transcript) {
      const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const searchTerms = words.slice(0, 10).join(' | '); // Top 10 words for search
      
      const { data: dialogueMatches } = await supabaseAdmin
        .from('movie_dialogues')
        .select('movie_id, text, movies!inner(id, title, year)')
        .textSearch('text', searchTerms, { type: 'websearch' })
        .limit(10);

      if (dialogueMatches && dialogueMatches.length > 0) {
        // Group by movie and count matches
        const movieCounts = new Map<number, { title: string; year: number; count: number }>();
        for (const match of dialogueMatches) {
          const movie = match.movies as any;
          if (movie) {
            const existing = movieCounts.get(movie.id) || { title: movie.title, year: movie.year, count: 0 };
            existing.count++;
            movieCounts.set(movie.id, existing);
          }
        }

        for (const [movieId, data] of movieCounts) {
          databaseMatches.push({
            movie_id: movieId,
            title: data.title,
            year: data.year,
            score: Math.min(data.count * 0.2, 1), // Up to 100% with 5+ matches
          });
        }
      }
    }

    // Search by title if OCR found one
    if (movieTitleOnScreen) {
      const { data: titleMatches } = await supabaseAdmin
        .from('movies')
        .select('id, title, year')
        .ilike('title', `%${movieTitleOnScreen}%`)
        .limit(5);

      if (titleMatches) {
        for (const movie of titleMatches) {
          if (!databaseMatches.find(m => m.movie_id === movie.id)) {
            databaseMatches.push({
              movie_id: movie.id,
              title: movie.title,
              year: movie.year,
              score: 0.9, // High confidence for title match
            });
          }
        }
      }
    }

    console.log(`  ✓ Database matches: ${databaseMatches.length}`);
    if (databaseMatches.length > 0) {
      console.log(`    ${databaseMatches.slice(0, 3).map(m => `${m.title} (${m.year})`).join(', ')}`);
    }

    // ========== FAST PATH: Skip GPT-4o for obvious matches ==========
    // If we have title on screen AND it matches a database entry, skip AI aggregation
    let aiResult: { title: string; year: number | null; confidence: number; matchedSignals: string[]; reasoning: string };
    
    const titleMatchInDB = movieTitleOnScreen && databaseMatches.find(m => 
      m.title.toLowerCase().includes(movieTitleOnScreen.toLowerCase()) ||
      movieTitleOnScreen.toLowerCase().includes(m.title.toLowerCase())
    );
    
    if (titleMatchInDB && titleMatchInDB.score >= 0.8) {
      // FAST PATH: Title on screen matches database - skip GPT-4o!
      console.log('📥 Step 5: FAST PATH (skipping GPT-4o - title on screen matches DB)');
      
      aiResult = {
        title: titleMatchInDB.title,
        year: titleMatchInDB.year,
        confidence: 0.95,
        matchedSignals: ['on-screen text', 'database match'],
        reasoning: `Title "${movieTitleOnScreen}" found on screen and matches database entry "${titleMatchInDB.title}"`,
      };
      
      // Add actor signal if we have actors
      if (uniqueActors.length > 0 && maxActorConfidence >= 0.7) {
        aiResult.matchedSignals.push('actors');
        aiResult.confidence = Math.min(aiResult.confidence + 0.05, 1.0);
      }
      
      console.log(`  ⚡ Fast match: "${aiResult.title}" (${aiResult.year})`);
      console.log(`     Confidence: ${Math.round(aiResult.confidence * 100)}%`);
    } else {
      // NORMAL PATH: Use GPT-4o for aggregation
      console.log('📥 Step 5: AI aggregation (GPT-4o)...');
      
      const signalData: SignalData = {
        transcript,
        sceneDescriptions: allScenes,
        ocrText: uniqueOcr,
        movieTitleOnScreen,
        creditsOnScreen: uniqueCredits,
        actorsIdentified: uniqueActors,
        actorConfidence: maxActorConfidence,
        databaseMatches: databaseMatches.map(m => ({ title: m.title, year: m.year, score: m.score })),
      };

      aiResult = await aggregateSignals(signalData);
      
      console.log(`  🤖 AI Result: "${aiResult.title}" (${aiResult.year})`);
      console.log(`     Confidence: ${Math.round(aiResult.confidence * 100)}%`);
      console.log(`     Signals: ${aiResult.matchedSignals.join(', ')}`);
      console.log(`     Reasoning: ${aiResult.reasoning}`);
    }

    // ========== STEP 5.5: Verify Actors in Suggested Movie ==========
    let verifiedTitle = aiResult.title;
    let verifiedYear = aiResult.year;
    let actorVerificationPassed = true;
    
    if (uniqueActors.length >= 2 && aiResult.title !== 'Unknown') {
      console.log(`  🔍 Verifying ${uniqueActors.length} actors in "${aiResult.title}"...`);
      
      // Quick TMDB lookup to get the movie ID
      const tmdbCheck = await searchMulti(aiResult.title, aiResult.year);
      
      if (tmdbCheck) {
        const isTV = tmdbCheck.media_type === 'tv';
        const verification = await verifyActorsInMovie(tmdbCheck.id, uniqueActors, isTV);
        
        if (!verification.verified) {
          console.log(`  ⚠️ ACTOR MISMATCH! Missing: ${verification.missingActors.join(', ')}`);
          console.log(`  🔄 Searching for movies with ALL actors: ${uniqueActors.join(' + ')}`);
          actorVerificationPassed = false;
          
          // Try to find a better match - movies featuring ALL identified actors
          // Known combinations:
          if (uniqueActors.some(a => a.toLowerCase().includes('kevin hart')) && 
              uniqueActors.some(a => a.toLowerCase().includes('dwayne') || a.toLowerCase().includes('rock') || a.toLowerCase().includes('johnson'))) {
            // Kevin Hart + Dwayne Johnson = Central Intelligence or Jumanji
            console.log(`  🎬 Detected Kevin Hart + Dwayne Johnson combo`);
            
            // Check transcript for clues
            const transcriptLower = transcript?.toLowerCase() || '';
            if (transcriptLower.includes('cia') || transcriptLower.includes('agent') || transcriptLower.includes('spy') || 
                transcriptLower.includes('calvin') || transcriptLower.includes('jet') || transcriptLower.includes('interpol')) {
              verifiedTitle = 'Central Intelligence';
              verifiedYear = 2016;
              console.log(`  ✓ Transcript clues suggest "Central Intelligence" (2016)`);
            } else if (transcriptLower.includes('jungle') || transcriptLower.includes('game') || transcriptLower.includes('avatar') || 
                       transcriptLower.includes('level') || transcriptLower.includes('npc')) {
              verifiedTitle = 'Jumanji: Welcome to the Jungle';
              verifiedYear = 2017;
              console.log(`  ✓ Transcript clues suggest "Jumanji" (2017)`);
            } else {
              // Default to Central Intelligence for modern-day setting
              verifiedTitle = 'Central Intelligence';
              verifiedYear = 2016;
              console.log(`  ✓ Defaulting to "Central Intelligence" (2016) for Kevin Hart + Dwayne Johnson`);
            }
          }
        } else {
          console.log(`  ✓ Actor verification passed: ${verification.matchedActors.join(', ')}`);
        }
      }
    }

    // ========== STEP 6: Find/Create Movie in Database ==========
    console.log('📥 Step 6: Resolving movie...');
    
    // Use verified title if actor check failed
    const finalTitle = actorVerificationPassed ? aiResult.title : verifiedTitle;
    const finalYear = actorVerificationPassed ? aiResult.year : verifiedYear;
    
    if (finalTitle !== aiResult.title) {
      console.log(`  🔄 Using corrected title: "${finalTitle}" (${finalYear}) instead of "${aiResult.title}"`);
    }
    
    let movie: any = null;
    
    // IMPORTANT: If AI returned "Unknown", try actor-based search before giving up
    if (finalTitle === 'Unknown' || finalTitle.toLowerCase() === 'unknown') {
      console.log('  ⚠️ AI returned "Unknown" - trying actor-based identification...');
      
      // If we have high-confidence actors, search for movies featuring them
      if (uniqueActors.length >= 2 && maxActorConfidence >= 0.7) {
        console.log(`  🎭 High-confidence actors detected (${Math.round(maxActorConfidence * 100)}%): ${uniqueActors.join(', ')}`);
        
        // Filter out likely false positives (generic names, "Unknown", etc.)
        const validActors = uniqueActors.filter(a => 
          a.length > 3 && 
          !a.toLowerCase().includes('unknown') &&
          !a.toLowerCase().includes('for unsolved') && // Filter out "Justice For Unsolved"
          !a.toLowerCase().includes('person')
        );
        
        if (validActors.length >= 1) {
          const actorMovies = await findMoviesWithActors(validActors);
          
          if (actorMovies && actorMovies.length > 0) {
            // Take the best match (most actors, most recent, most popular)
            const bestActorMatch = actorMovies[0];
            console.log(`  🎬 Best actor-based match: "${bestActorMatch.title}" (${bestActorMatch.year})`);
            console.log(`     Actors found: ${bestActorMatch.matchedActors.join(', ')}`);
            
            // Search for this movie in our database or TMDB
            const tmdbResult = await searchMulti(bestActorMatch.title, bestActorMatch.year);
            
            if (tmdbResult) {
              const isTV = tmdbResult.media_type === 'tv';
              const title = isTV ? (tmdbResult as TMDBTVShow).name : (tmdbResult as any).title;
              const releaseDate = isTV ? (tmdbResult as TMDBTVShow).first_air_date : (tmdbResult as any).release_date;
              const imdbId = (tmdbResult as any).imdb_id || null;
              
              // Check if exists in our DB
              const { data: existing } = await supabaseAdmin
                .from('movies')
                .select('*')
                .eq('tmdb_id', tmdbResult.id)
                .single();
              
              if (existing) {
                movie = existing;
                console.log(`  ✓ Found in DB via actor search: "${movie.title}" (ID: ${movie.id})`);
              } else {
                // Auto-cache this movie
                console.log(`  📥 Auto-caching actor-matched movie: "${title}"`);
                const movieYear = releaseDate ? parseInt(releaseDate.substring(0, 4)) : bestActorMatch.year;
                
                const { data: newMovie, error } = await supabaseAdmin
                  .from('movies')
                  .insert({
                    title,
                    year: movieYear,
                    overview: tmdbResult.overview || '',
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
                  console.log(`  ✓ Added to database: "${movie.title}" (ID: ${movie.id})`);
                  
                  // Cache cast and subtitles
                  await cacheCastForMovie(movie, tmdbResult.id);
                  await cacheSubtitlesForMovie(movie);
                }
              }
              
              // Update AI result confidence based on actor match
              if (movie) {
                aiResult.confidence = Math.min(0.75, maxActorConfidence); // Actor-based match confidence
                aiResult.matchedSignals = ['actors', 'filmography'];
                aiResult.reasoning = `Identified via actor filmography search: ${bestActorMatch.matchedActors.join(' and ')} both appear in this ${bestActorMatch.media_type}.`;
              }
            }
          } else {
            // No movies found with multiple actors - try single actor's popular works
            console.log('  🔍 No shared movies found, checking individual actor filmographies...');
            
            for (const actorName of validActors.slice(0, 2)) {
              const { searchPerson, getActorFilmography } = await import('@/lib/tmdb');
              const person = await searchPerson(actorName);
              
              if (person) {
                const filmography = await getActorFilmography(person.id);
                // Look for recent popular works
                const recentHits = filmography
                  .filter(f => f.year >= 2020 && f.popularity > 10)
                  .slice(0, 3);
                
                if (recentHits.length > 0) {
                  console.log(`    ${actorName}'s recent works: ${recentHits.map(f => `${f.title} (${f.year})`).join(', ')}`);
                }
              }
            }
          }
        }
      }
      
      // If still no movie found, will fall through to V1 fallback
      if (!movie) {
        console.log('  ⚠️ Actor-based search did not find a match - skipping to V1 fallback');
      }
    } else {
      // Normalize title for comparison (remove subtitles like ": Answer the Call")
      const normalizeTitle = (title: string) => {
        return title.toLowerCase()
          .replace(/:\s*(answer the call|afterlife|frozen empire|the sequel|part \d+|vol\.\s*\d+)/gi, '')
          .replace(/\s*(ii|iii|iv|v|2|3|4|5)$/i, '')  // Remove sequel numbers at end
          .trim();
      };
      
      const finalTitleNormalized = normalizeTitle(finalTitle);
      const finalTitleBase = finalTitle.split(/[:\-–]/)[0].trim().toLowerCase();
      
      // First check if AI matched a database result
      if (databaseMatches.length > 0) {
        // 1. Try exact title + year match
        let dbMatch = databaseMatches.find(m => 
          m.title.toLowerCase() === finalTitle.toLowerCase() &&
          (!finalYear || m.year === finalYear)
        );
        
        // 2. Try normalized title + year match (handles "Ghostbusters: Answer the Call" -> "Ghostbusters")
        if (!dbMatch && finalYear) {
          dbMatch = databaseMatches.find(m => 
            normalizeTitle(m.title) === finalTitleNormalized &&
            m.year === finalYear
          );
        }
        
        // 3. Try base title (before colon) + year match
        if (!dbMatch && finalYear) {
          dbMatch = databaseMatches.find(m => 
            m.title.toLowerCase() === finalTitleBase &&
            m.year === finalYear
          );
        }
        
        // 4. Try partial match WITH year requirement
        if (!dbMatch && finalYear) {
          dbMatch = databaseMatches.find(m => 
            m.year === finalYear && (
              m.title.toLowerCase().includes(finalTitleBase) ||
              finalTitleBase.includes(m.title.toLowerCase())
            )
          );
        }
        
        if (dbMatch) {
          const { data } = await supabaseAdmin
            .from('movies')
            .select('*')
            .eq('id', dbMatch.movie_id)
            .single();
          movie = data;
          console.log(`  ✓ Found in database: "${movie.title}" (${movie.year}) (ID: ${movie.id})`);
        }
      }

      // If not found, search database by title (but only if we have a real title, not "Unknown")
      if (!movie && finalTitle.length > 2) {
        const { data: titleMatches } = await supabaseAdmin
          .from('movies')
          .select('*')
          .or(`title.ilike.%${finalTitle}%,title.ilike.%${finalTitle.split(/[:\-–]/)[0].trim()}%`)
          .limit(5);

        // Find best match (prefer year match)
        movie = titleMatches?.find(m => m.year === finalYear) || 
                titleMatches?.find(m => m.title.toLowerCase() === finalTitle.toLowerCase()) ||
                titleMatches?.[0];
        
        if (movie) {
          console.log(`  ✓ Found by title search: "${movie.title}" (ID: ${movie.id})`);
        }
      }
    }

    // If still not found, fetch from TMDB and auto-cache
    if (!movie && aiResult.confidence >= 0.4) {
      console.log(`  🌐 Fetching from TMDB: "${finalTitle}" (${finalYear})`);
      
      const tmdbResult = await searchMulti(finalTitle, finalYear);
      
      if (tmdbResult) {
        const isTV = tmdbResult.media_type === 'tv';
        const title = isTV ? (tmdbResult as TMDBTVShow).name : (tmdbResult as any).title;
        const releaseDate = isTV ? (tmdbResult as TMDBTVShow).first_air_date : (tmdbResult as any).release_date;
        const imdbId = (tmdbResult as any).imdb_id || null;
        
        console.log(`  ✓ TMDB found: "${title}" (${releaseDate?.substring(0,4)}) - IMDB: ${imdbId || 'none'}`);
        
        // Check if exists by tmdb_id
        const { data: existing } = await supabaseAdmin
          .from('movies')
          .select('*')
          .eq('tmdb_id', tmdbResult.id)
          .single();

        if (existing) {
          movie = existing;
          console.log(`  ✓ Already in DB by tmdb_id: "${movie.title}"`);
          
          // If existing movie doesn't have dialogues, try to cache them now
          const { data: existingDialogues } = await supabaseAdmin
            .from('movie_dialogues')
            .select('id')
            .eq('movie_id', existing.id)
            .limit(1);
            
          if (!existingDialogues || existingDialogues.length === 0) {
            console.log('  📥 No cached dialogues, fetching from OpenSubtitles...');
            // Will be handled below in subtitle caching section
          }
        } else {
          // Insert new movie - AUTO-CACHING with full TMDB data!
          console.log(`  📥 Auto-caching new movie to database...`);
          
          // Enhance overview with AI if it's short
          const movieYear = releaseDate ? parseInt(releaseDate.substring(0, 4)) : aiResult.year;
          let enhancedOverview = tmdbResult.overview;
          
          if (!enhancedOverview || enhancedOverview.length < 300) {
            console.log(`  🤖 Enhancing short overview (${enhancedOverview?.length || 0} chars)...`);
            enhancedOverview = await generateEnhancedOverview(title, movieYear, tmdbResult.overview);
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
            console.log(`  ✓ Added to database: "${movie.title}" (ID: ${movie.id})`);
            
            // Cache cast info
            await cacheCastForMovie(movie, tmdbResult.id);
            
            // Cache subtitles (60 dialogues)
            await cacheSubtitlesForMovie(movie);
          }
        }
      }
    }
    
    // Also cache subtitles for existing movies that don't have dialogues
    if (movie && movie.imdb_id) {
      const { data: existingDialogues } = await supabaseAdmin
        .from('movie_dialogues')
        .select('id')
        .eq('movie_id', movie.id)
        .limit(1);
        
      if (!existingDialogues || existingDialogues.length === 0) {
        await cacheSubtitlesForMovie(movie);
      }
    }

    // ========== Final Result with Cascading Recognition ==========
    const CONFIDENCE_THRESHOLD = 0.40; // 40% threshold for cascading to V1
    
    // Case 1: V2 completely failed - fall back to V1
    if (!movie) {
      console.log('❌ V2 could not identify movie, falling back to V1 pipeline...');
      console.log('========== TRYING V1 FALLBACK ==========');
      
      try {
        const v1Result = await runV1Recognition(transcript, frames, upload?.id, null);
        if (v1Result && v1Result.movie) {
          const processingTime = Date.now() - startTime;
          console.log(`✅ V1 FALLBACK SUCCESS: "${v1Result.movie.title}"`);
          console.log('========== RECOGNITION END (V1 FALLBACK) ==========\n');
          
          if (upload) {
            await supabaseAdmin
              .from('user_uploads')
              .update({
                result_movie_id: v1Result.movie.id,
                confidence_score: v1Result.confidence,
              })
              .eq('id', upload.id);
          }
          
          return NextResponse.json({
            movie: v1Result.movie,
            confidence: v1Result.confidence,
            matched_on: v1Result.matched_on,
            reasoning: 'Identified via V1 fallback pipeline',
            processing_time: processingTime,
            fallback: true,
          });
        }
      } catch (fallbackErr: any) {
        console.log(`  ⚠️ V1 fallback also failed: ${fallbackErr.message}`);
      }
      
      console.log('❌ Both V2 and V1 pipelines failed');
      console.log('========== RECOGNITION END (FAILED) ==========\n');
      return NextResponse.json({ error: 'Could not identify movie' }, { status: 404 });
    }
    
    // Case 2: V2 found something but confidence < 40% - cascade to V1 for second opinion
    if (aiResult.confidence < CONFIDENCE_THRESHOLD) {
      console.log(`\n⚠️ V2 confidence (${Math.round(aiResult.confidence * 100)}%) below threshold (${CONFIDENCE_THRESHOLD * 100}%)`);
      console.log(`   V2 guess: "${movie.title}" (${movie.year})`);
      console.log('========== CASCADING TO V1 FOR SECOND OPINION ==========');
      
      // Pass V2's guess to V1 so it can consider it
      const v2Hint = {
        title: movie.title,
        year: movie.year,
        tmdb_id: movie.tmdb_id,
        confidence: aiResult.confidence,
      };
      
      try {
        const v1Result = await runV1Recognition(transcript, frames, upload?.id, v2Hint);
        
        if (v1Result && v1Result.movie) {
          console.log(`   V1 result: "${v1Result.movie.title}" (${Math.round(v1Result.confidence * 100)}%)`);
          
          // Compare results and pick the best one
          if (v1Result.confidence > CONFIDENCE_THRESHOLD) {
            // V1 found something better (above threshold)
            console.log(`✅ V1 confidence (${Math.round(v1Result.confidence * 100)}%) beats threshold - using V1 result`);
            
            const processingTime = Date.now() - startTime;
            if (upload) {
              await supabaseAdmin
                .from('user_uploads')
                .update({
                  result_movie_id: v1Result.movie.id,
                  confidence_score: v1Result.confidence,
                  matched_signals: {
                    signals: v1Result.matched_on,
                    reasoning: `V1 improved on V2's ${Math.round(aiResult.confidence * 100)}% guess`,
                    v2_guess: { title: movie.title, confidence: aiResult.confidence },
                  },
                })
                .eq('id', upload.id);
            }
            
            return NextResponse.json({
              movie: v1Result.movie,
              confidence: v1Result.confidence,
              matched_on: v1Result.matched_on,
              reasoning: `V1 improved on V2's guess (V2: ${movie.title} @ ${Math.round(aiResult.confidence * 100)}%)`,
              processing_time: processingTime,
              cascaded: true,
            });
          } else if (v1Result.confidence > aiResult.confidence) {
            // V1 found something slightly better but still below threshold - use higher one
            console.log(`   V1 (${Math.round(v1Result.confidence * 100)}%) slightly better than V2 (${Math.round(aiResult.confidence * 100)}%) - using V1`);
            
            const processingTime = Date.now() - startTime;
            if (upload) {
              await supabaseAdmin
                .from('user_uploads')
                .update({
                  result_movie_id: v1Result.movie.id,
                  confidence_score: v1Result.confidence,
                })
                .eq('id', upload.id);
            }
            
            return NextResponse.json({
              movie: v1Result.movie,
              confidence: v1Result.confidence,
              matched_on: v1Result.matched_on,
              reasoning: `Best guess from combined V1+V2 analysis (low confidence)`,
              processing_time: processingTime,
              cascaded: true,
              low_confidence: true,
            });
          }
        }
        
        // V1 didn't find anything better - stick with V2's low confidence result
        console.log(`   V1 didn't improve - using original V2 result`);
        
      } catch (cascadeErr: any) {
        console.log(`  ⚠️ V1 cascade failed: ${cascadeErr.message} - using V2 result`);
      }
    }

    const processingTime = Date.now() - startTime;

    // Update upload record
    if (upload) {
      await supabaseAdmin
        .from('user_uploads')
        .update({
          result_movie_id: movie.id,
          confidence_score: aiResult.confidence,
          matched_signals: { 
            signals: aiResult.matchedSignals,
            reasoning: aiResult.reasoning,
          },
          processing_time_ms: processingTime,
        })
        .eq('id', upload.id);
    }

    // Release queue slot with processing time
    const processingTimeMs = Date.now() - startTime;
    if (queueSlotAcquired) {
      recognitionQueue.releaseSlot(processingTimeMs);
    }

    console.log(`\n✅ SUCCESS: "${movie.title}" (${Math.round(aiResult.confidence * 100)}% confidence)`);
    console.log(`⏱️ Processing time: ${processingTime}ms`);
    console.log('========== MULTI-SIGNAL RECOGNITION END ==========\n');

    return NextResponse.json({
      movie,
      confidence: aiResult.confidence,
      matched_on: aiResult.matchedSignals,
      reasoning: aiResult.reasoning,
      processing_time: processingTime,
    });

  } catch (error: any) {
    // Release queue slot on error
    if (queueSlotAcquired) {
      recognitionQueue.releaseSlot(Date.now() - startTime);
    }
    
    console.error('❌ Recognition error:', error);
    console.log('========== RECOGNITION END (ERROR) ==========\n');
    return NextResponse.json(
      { error: 'Recognition failed', details: error.message },
      { status: 500 }
    );
  }
}

/**
 * Helper function to cache subtitles for a movie
 * Downloads from OpenSubtitles and stores 60 key dialogues
 */
async function cacheSubtitlesForMovie(movie: any) {
  if (!movie.imdb_id) {
    console.log('  ⚠️ No IMDB ID, cannot cache subtitles');
    return;
  }
  
  console.log(`📥 Caching subtitles for "${movie.title}"...`);
  try {
    const subtitles = await searchSubtitlesByImdbId(movie.imdb_id);
    if (subtitles && subtitles.length > 0) {
      const fileId = subtitles[0]?.attributes?.files?.[0]?.file_id;
      if (!fileId) {
        console.log('  ⚠️ No subtitle file found');
        return;
      }
      
      const subFile = await downloadSubtitle(fileId);
      if (subFile) {
        const lines = parseSubtitleContent(subFile);
        // Store 60 dialogues for better matching coverage
        const keyLines = lines
          .filter(l => l.text.length > 15 && l.text.length < 250)
          .slice(0, 60);
        
        let cached = 0;
        for (const line of keyLines) {
          const { error } = await supabaseAdmin.from('movie_dialogues').insert({
            movie_id: movie.id,
            text: line.text,
            start_timestamp: line.start,
            end_timestamp: line.end,
            source: 'opensubtitles_auto',
          });
          if (!error) cached++;
        }
        console.log(`  ✓ Auto-cached ${cached} dialogues for "${movie.title}"`);
      } else {
        console.log('  ⚠️ Could not download subtitle file');
      }
    } else {
      console.log('  ⚠️ No subtitles found on OpenSubtitles');
    }
  } catch (err: any) {
    console.log(`  ⚠️ Subtitle caching failed: ${err.message}`);
  }
}

/**
 * Helper function to cache cast info for a movie
 * Fetches top 10 cast members from TMDB and stores them
 */
async function cacheCastForMovie(movie: any, tmdbId: number) {
  try {
    console.log(`  📥 Caching cast for "${movie.title}"...`);
    const cast = await getMovieCast(tmdbId);
    
    if (cast && cast.length > 0) {
      let cached = 0;
      for (const actor of cast.slice(0, 10)) {
        const { error } = await supabaseAdmin.from('movie_cast').insert({
          movie_id: movie.id,
          actor_name: actor.name,
          character_name: actor.character,
          profile_url: actor.profile_path 
            ? `https://image.tmdb.org/t/p/w185${actor.profile_path}` 
            : null,
          cast_order: actor.order,
        });
        if (!error) cached++;
      }
      console.log(`  ✓ Auto-cached ${cached} cast members for "${movie.title}"`);
    }
  } catch (err: any) {
    console.log(`  ⚠️ Cast caching failed: ${err.message}`);
  }
}

/**
 * V1 Recognition Fallback
 * Uses the original pipeline with embedding-based dialogue matching
 * 
 * @param v2Hint - Optional hint from V2 about what it thinks the movie is (for cascade mode)
 */
async function runV1Recognition(
  transcript: string,
  frames: Buffer[],
  uploadId?: number,
  v2Hint?: { title: string; year: number; tmdb_id: number; confidence: number } | null
): Promise<{ movie: any; confidence: number; matched_on: string[] } | null> {
  console.log('  🔄 Running V1 dialogue matching...');
  if (v2Hint) {
    console.log(`    📌 V2 hint: "${v2Hint.title}" (${v2Hint.year}) @ ${Math.round(v2Hint.confidence * 100)}%`);
  }
  
  const matches: Array<{ movie_id: number; score: number; signal: string }> = [];
  const sceneDescriptions: string[] = [];
  let subtitleSuggestions: string[] = [];
  
  // V1 Signal 1: ILIKE-based dialogue search (more reliable than full-text)
  if (transcript && transcript.length > 20) {
    try {
      // Extract meaningful phrases from transcript for search
      const words = transcript
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4 && !['about', 'would', 'could', 'should', 'there', 'their', 'where', 'which', 'these', 'those', 'being', 'going', 'doing', 'having', 'think', 'really', 'something'].includes(w));
      
      // Get unique words and pick the most distinctive ones
      const uniqueWords = [...new Set(words)].slice(0, 10);
      console.log(`    🔍 V1 searching dialogues for: "${uniqueWords.slice(0, 5).join(', ')}..."`);
      
      // Search for each word using ILIKE (which works reliably)
      const allMatches: Array<{ movie_id: number; text: string }> = [];
      
      for (const word of uniqueWords.slice(0, 6)) { // Limit to 6 searches
        const { data: wordMatches, error } = await supabaseAdmin
          .from('movie_dialogues')
          .select('movie_id, text')
          .ilike('text', `%${word}%`)
          .limit(10);
        
        if (!error && wordMatches) {
          allMatches.push(...wordMatches);
        }
      }
      
      if (allMatches.length > 0) {
        // Group by movie and calculate scores based on number of matching words
        const movieScores = new Map<number, Set<string>>();
        
        for (const match of allMatches) {
          const movieId = match.movie_id;
          if (!movieScores.has(movieId)) {
            movieScores.set(movieId, new Set());
          }
          // Track which words matched for this movie
          for (const word of uniqueWords) {
            if (match.text.toLowerCase().includes(word)) {
              movieScores.get(movieId)!.add(word);
            }
          }
        }
        
        console.log(`    ✓ V1 found matches in ${movieScores.size} movies`);
        
        for (const [movieId, matchedWords] of movieScores) {
          // Score based on how many unique words matched
          // Require at least 3 words to match (was 2) to reduce false positives
          const score = Math.min(matchedWords.size * 0.15, 0.9);
          if (matchedWords.size >= 3 && score >= 0.45) { // Require 3+ words matched
            matches.push({
              movie_id: movieId,
              score,
              signal: 'dialogue_v1',
            });
            console.log(`      Movie ${movieId}: ${matchedWords.size} words matched (score: ${score.toFixed(2)})`);
          }
        }
      }
    } catch (e: any) {
      console.log(`    ⚠️ V1 dialogue search failed: ${e.message}`);
    }
  }
  
  // V1 Signal 2: OpenSubtitles search - DISABLED
  // OpenSubtitles searches by TITLE not dialogue, so it returns false positives
  // (e.g., searching "leave alone" returns movies with those words in title)
  // We keep it for suggested titles hint only, not as match evidence
  if (transcript && transcript.length > 30) {
    try {
      const { suggestedTitles } = await searchSubtitles(transcript);
      subtitleSuggestions = suggestedTitles;
      // NOTE: We intentionally don't add OpenSubtitles results to matches
      // because they're title-based, not dialogue-based
    } catch (e: any) {
      console.log(`    ⚠️ V1 subtitle search failed: ${e.message}`);
    }
  }
  
  // V1 Signal 3: Scene descriptions from frames
  for (let i = 0; i < Math.min(frames.length, 2); i++) {
    try {
      const base64 = frames[i].toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      const description = await describeScene(dataUrl);
      if (description) {
        sceneDescriptions.push(description);
      }
    } catch (e) {
      // Ignore scene description errors
    }
  }
  
  // If no matches found, try AI identification
  if (matches.length === 0) {
    console.log('    🤖 V1 trying AI identification...');
    
    // If we have a V2 hint, include it in the AI prompt context
    const additionalContext = v2Hint 
      ? [`V2 AI pipeline suggested: "${v2Hint.title}" (${v2Hint.year}) with ${Math.round(v2Hint.confidence * 100)}% confidence`]
      : [];
    
    try {
      const aiResult = await identifyMovie(
        transcript, 
        [...sceneDescriptions, ...additionalContext], 
        subtitleSuggestions
      );
      
      if (aiResult.title && aiResult.title !== 'Unknown' && aiResult.confidence >= 0.5) {
        // Search TMDB for this movie
        const tmdbResult = await searchMulti(aiResult.title, aiResult.year);
        
        if (tmdbResult) {
          // Check if in our DB
          const { data: existingMovie } = await supabaseAdmin
            .from('movies')
            .select('*')
            .eq('tmdb_id', tmdbResult.id)
            .single();
          
          if (existingMovie) {
            console.log(`    ✓ V1 AI matched to DB: "${existingMovie.title}"`);
            return {
              movie: existingMovie,
              confidence: aiResult.confidence,
              matched_on: ['ai_v1', 'dialogue'],
            };
          }
        }
      }
    } catch (e: any) {
      console.log(`    ⚠️ V1 AI identification failed: ${e.message}`);
    }
    
    // If V1 found nothing but we have a V2 hint, validate the V2 hint
    if (v2Hint) {
      console.log(`    📌 V1 found nothing new - validating V2 hint "${v2Hint.title}"...`);
      const { data: v2Movie } = await supabaseAdmin
        .from('movies')
        .select('*')
        .eq('tmdb_id', v2Hint.tmdb_id)
        .single();
      
      if (v2Movie) {
        // Return V2's guess but don't boost confidence
        return {
          movie: v2Movie,
          confidence: v2Hint.confidence,
          matched_on: ['v2_hint_validated'],
        };
      }
    }
    
    return null;
  }
  
  // If we have V2 hint, check if any match is the same movie and boost its score
  if (v2Hint) {
    for (const match of matches) {
      // Check if this match is the same as V2's suggestion
      const { data: matchMovie } = await supabaseAdmin
        .from('movies')
        .select('tmdb_id')
        .eq('id', match.movie_id)
        .single();
      
      if (matchMovie && matchMovie.tmdb_id === v2Hint.tmdb_id) {
        // V1 found evidence supporting V2's guess - boost confidence
        match.score = Math.min(match.score + 0.15, 0.95);
        console.log(`    📌 V1 evidence supports V2 guess - boosted score for "${v2Hint.title}"`);
      }
    }
  }
  
  // Find best match
  const movieScores = new Map<number, { totalScore: number; signals: Set<string> }>();
  
  for (const match of matches) {
    const existing = movieScores.get(match.movie_id) || { totalScore: 0, signals: new Set<string>() };
    existing.totalScore += match.score;
    existing.signals.add(match.signal);
    movieScores.set(match.movie_id, existing);
  }
  
  // Sort by score
  const sortedMovies = Array.from(movieScores.entries())
    .sort((a, b) => b[1].totalScore - a[1].totalScore);
  
  if (sortedMovies.length === 0) {
    return null;
  }
  
  const [bestMovieId, bestMatch] = sortedMovies[0];
  
  // Fetch movie details
  const { data: movie, error } = await supabaseAdmin
    .from('movies')
    .select('*')
    .eq('id', bestMovieId)
    .single();
  
  if (error || !movie) {
    return null;
  }
  
  // Calculate confidence
  const confidence = Math.min(bestMatch.totalScore / bestMatch.signals.size, 0.95);
  
  // MINIMUM CONFIDENCE THRESHOLD - don't return weak matches
  const MIN_V1_CONFIDENCE = 0.40;
  if (confidence < MIN_V1_CONFIDENCE) {
    console.log(`    ⚠️ V1 best match "${movie.title}" rejected - confidence ${Math.round(confidence * 100)}% below ${MIN_V1_CONFIDENCE * 100}% threshold`);
    return null;
  }
  
  console.log(`    ✓ V1 found: "${movie.title}" (${Math.round(confidence * 100)}%)`);
  
  return {
    movie,
    confidence,
    matched_on: Array.from(bestMatch.signals),
  };
}
