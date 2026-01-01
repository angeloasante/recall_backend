import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { transcribeAudio, describeScene, generateEmbedding, identifyMovie } from '@/lib/openai';
import { extractAudio, extractFrames } from '@/lib/ffmpeg';
import { uploadVideo } from '@/lib/storage';
import { searchSubtitles } from '@/lib/opensubtitles';
import { searchMovie, searchMulti, buildImageUrl, TMDBTVShow } from '@/lib/tmdb';
import { generateEnhancedOverview } from '@/lib/enhance-overview';

// Route segment config for Next.js 14 App Router
// Large file uploads are handled automatically by formData()
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds timeout

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  console.log('\n========== RECOGNITION REQUEST START ==========');

  try {
    // 1. Parse the uploaded video and convert to buffer (combined for speed)
    console.log('📥 Step 1: Parsing video...');
    const formData = await req.formData();
    const videoFile = formData.get('video') as File;

    if (!videoFile) {
      console.log('❌ No video file in request');
      return NextResponse.json(
        { error: 'No video file provided' },
        { status: 400 }
      );
    }

    const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
    console.log(`✓ Video ready: ${videoFile.name} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

    // 2. Start storage upload in background (non-blocking) + create DB record
    console.log('📥 Step 2: Starting background tasks...');
    let videoUrl = 'uploading...';
    let upload: any = null;

    // Create upload record immediately with uploading status
    const { data: uploadData, error: uploadError } = await supabaseAdmin
      .from('user_uploads')
      .insert({ video_url: 'uploading...' })
      .select()
      .single();

    if (!uploadError) {
      upload = uploadData;
      console.log(`✓ Upload record: ID ${upload?.id}`);
    }

    // Fire and forget - upload happens while we process
    const uploadPromise = uploadVideo(videoBuffer, videoFile.name)
      .then(async (url) => {
        videoUrl = url;
        console.log(`  ✓ Video uploaded to Supabase Storage`);
        return url;
      })
      .catch(err => {
        console.log(`  ⚠️ Video upload failed: ${err.message}`);
        videoUrl = 'upload_failed';
        return 'upload_failed';
      });

    // 3. Extract features in PARALLEL (audio + frames at same time)
    console.log('📥 Step 3: Extracting audio and frames (in parallel)...');
    
    const [audioResult, framesResult] = await Promise.allSettled([
      extractAudio(videoBuffer).then(buf => {
        console.log(`  ✓ Audio extracted: ${buf?.length || 0} bytes`);
        return buf;
      }).catch(err => {
        console.error('  ❌ Audio extraction failed:', err.message);
        return null;
      }),
      extractFrames(videoBuffer, 5).then(f => {
        console.log(`  ✓ Frames extracted: ${f.length} frames`);        return f;
      }).catch(err => {
        console.error('  ❌ Frame extraction failed:', err.message);
        return [];
      }),
    ]);

    const audioBuffer = audioResult.status === 'fulfilled' ? audioResult.value : null;
    const frames = framesResult.status === 'fulfilled' ? framesResult.value : [];

    // 4. Run recognition methods
    console.log('📥 Step 4: Running recognition...');
    const matches: Array<{ movie_id: number; score: number; signal: string }> = [];
    let transcript = '';
    const sceneDescriptions: string[] = [];
    let subtitleSuggestions: string[] = []; // Only from actual DB matches

    // Signal 1: Dialogue recognition (if audio extracted)
    if (audioBuffer && audioBuffer.length > 0) {
      console.log('  🎤 Transcribing audio with Whisper...');
      try {
        transcript = await transcribeAudio(audioBuffer);
        console.log(`  ✓ Transcript (${transcript.length} chars): "${transcript.substring(0, 150)}..."`);

        if (transcript && transcript.length > 10) {
          // Extract key phrases for text search (first few words of sentences)
          const keyPhrases = transcript
            .split(/[.!?]/)
            .filter(s => s.trim().length > 10)
            .slice(0, 5)
            .map(s => s.trim().substring(0, 50));
          
          console.log('  🔍 Searching dialogues in database (text match)...');
          
          // Text-based dialogue search (more reliable than embeddings for exact quotes)
          for (const phrase of keyPhrases) {
            const searchPhrase = phrase.replace(/[^\w\s]/g, '').substring(0, 30);
            if (searchPhrase.length < 10) continue;
            
            const { data: textMatches } = await supabaseAdmin
              .from('movie_dialogues')
              .select('movie_id, text')
              .ilike('text', `%${searchPhrase}%`)
              .limit(3);
            
            if (textMatches && textMatches.length > 0) {
              console.log(`    ✓ Text match for "${searchPhrase}": ${textMatches.length} results`);
              for (const match of textMatches) {
                matches.push({
                  movie_id: match.movie_id,
                  score: 2.0, // High score for exact text match
                  signal: 'dialogue_text',
                });
              }
            }
          }
          
          // Also try RPC embedding search (if available)
          const { data: dialogueMatches, error: dialogueError } = await supabaseAdmin.rpc('search_dialogues', {
            search_query: transcript,
            match_threshold: 0.1,
            match_count: 5,
          });

          if (dialogueError) {
            console.log('  ⚠️ Embedding search unavailable:', dialogueError.message);
          } else if (dialogueMatches && dialogueMatches.length > 0) {
            console.log(`  ✓ Embedding matches found: ${dialogueMatches.length}`);
            matches.push(
              ...dialogueMatches.map((m: any) => ({
                movie_id: m.movie_id,
                score: m.score,
                signal: 'dialogue_embedding',
              }))
            );
          }
          
          console.log(`  ✓ Total dialogue matches: ${matches.filter(m => m.signal.startsWith('dialogue')).length}`);
          
          // OpenSubtitles DISABLED - it searches by TITLE not dialogue, causing false matches
          // The text-based dialogue search above is more reliable
        } else {
          console.log('  ⚠️ Transcript too short, skipping dialogue search');
        }
      } catch (error: any) {
        console.error('  ❌ Transcription failed:', error.message);
      }
    } else {
      console.log('  ⚠️ No audio extracted, skipping dialogue recognition');
    }

    // Signal 2: Visual recognition (if frames extracted) - PARALLEL PROCESSING
    if (frames.length > 0) {
      console.log(`  🖼️ Analyzing ${frames.length} frames with GPT-4V (in parallel)...`);
      
      const framePromises = frames.map(async (frame, i) => {
        const frameNum = i + 1;
        try {
          // Convert frame to base64 for GPT-4V
          const base64Frame = frame.toString('base64');
          const frameUrl = `data:image/jpeg;base64,${base64Frame}`;

          // Get scene description
          const description = await describeScene(frameUrl);
          console.log(`    ✓ Frame ${frameNum}: "${description.substring(0, 60)}..."`);

          // Generate embedding
          const embedding = await generateEmbedding(description);

          // Search scenes in database
          const { data: sceneMatches, error: sceneError } = await supabaseAdmin.rpc('match_scenes', {
            query_embedding: JSON.stringify(embedding),
            match_threshold: 0.6,
            match_count: 5,
          });

          if (sceneError) {
            console.error(`    ❌ Frame ${frameNum} search error:`, sceneError.message);
            return { description, matches: [] };
          }

          return {
            description,
            matches: sceneMatches?.map((m: any) => ({
              movie_id: m.movie_id,
              score: m.score,
              signal: 'visual',
            })) || [],
          };
        } catch (error: any) {
          console.error(`    ❌ Frame ${frameNum} failed:`, error.message);
          return { description: '', matches: [] };
        }
      });

      // Wait for all frames to complete in parallel
      const frameResults = await Promise.all(framePromises);
      
      // Collect results
      for (const result of frameResults) {
        if (result.description) {
          sceneDescriptions.push(result.description);
        }
        matches.push(...result.matches);
      }
      
      console.log(`    ✓ All ${frames.length} frames processed, ${matches.filter(m => m.signal === 'visual').length} visual matches`);
    } else {
      console.log('  ⚠️ No frames extracted, skipping visual recognition');
    }

    // 7. Aggregate results using voting
    console.log('📥 Step 5: Aggregating results...');
    console.log(`  Total matches collected: ${matches.length}`);
    
    if (matches.length === 0) {
      console.log('⚠️ No database matches found, trying AI identification...');

      // FALLBACK: Use GPT to identify the movie directly
      if (transcript || sceneDescriptions.length > 0) {
        console.log('  🤖 Asking GPT to identify the movie...');
        try {
          const movieGuess = await identifyMovie(transcript, sceneDescriptions, subtitleSuggestions);
          console.log(`  ✓ GPT identified: "${movieGuess.title}" (${movieGuess.year}) - ${(movieGuess.confidence * 100).toFixed(0)}% confident`);
          console.log(`  📝 Reasoning: ${movieGuess.reasoning}`);

          if (movieGuess.confidence >= 0.5) {
            // Search for this movie in our database with flexible matching
            console.log('  🔍 Searching database for this movie...');
            const mainTitle = movieGuess.title.split(/[:\-–]/)[0].trim();
            
            const { data: foundMovies } = await supabaseAdmin
              .from('movies')
              .select('*')
              .or(`title.ilike.%${movieGuess.title}%,title.ilike.%${mainTitle}%`)
              .limit(5);

            // Find best match - prefer exact year match, but for TV shows accept any year 
            // (since GPT might identify season year vs first air date)
            let movie = foundMovies?.find(m => m.year === movieGuess.year);
            
            // If no exact year match but we have a title match, use it (TV shows have different season years)
            if (!movie && foundMovies && foundMovies.length > 0) {
              // For close title matches, use the first one (likely correct for TV series)
              const exactTitleMatch = foundMovies.find(m => 
                m.title.toLowerCase() === movieGuess.title.toLowerCase()
              );
              if (exactTitleMatch) {
                console.log(`  ✓ Using existing DB entry with different year (TV series season vs first air date)`);
                movie = exactTitleMatch;
              }
            }
            
            console.log(`  Found ${foundMovies?.length || 0} potential matches`);
            if (foundMovies && foundMovies.length > 0) {
              console.log(`    Candidates: ${foundMovies.map(m => `${m.title} (${m.year})`).join(', ')}`);
            }

            // If no match found, fetch from TMDB (movies AND TV shows) and save
            if (!movie && movieGuess.confidence >= 0.5) {
              console.log(`  🎬 Not in DB, searching TMDB (movies + TV): "${movieGuess.title}" (${movieGuess.year})`);
              
              // Try multi-search first (covers both movies and TV)
              const tmdbResult = await searchMulti(movieGuess.title, movieGuess.year);
              
              if (tmdbResult) {
                const isTV = tmdbResult.media_type === 'tv';
                const tvShow = tmdbResult as TMDBTVShow;
                const tmdbMovie = tmdbResult as any;
                
                const title = isTV ? tvShow.name : tmdbMovie.title;
                const releaseYear = isTV 
                  ? (tvShow.first_air_date?.substring(0, 4))
                  : (tmdbMovie.release_date?.substring(0, 4));
                
                console.log(`  ✓ Found on TMDB: "${title}" (${releaseYear}) [${isTV ? 'TV Series' : 'Movie'}]`);
                
                // Check if already exists by tmdb_id (handles duplicate key scenario)
                const { data: existingByTmdb } = await supabaseAdmin
                  .from('movies')
                  .select('*')
                  .eq('tmdb_id', tmdbResult.id)
                  .single();
                
                if (existingByTmdb) {
                  console.log(`  ✓ Already in DB by tmdb_id: "${existingByTmdb.title}" (ID: ${existingByTmdb.id})`);
                  movie = existingByTmdb;
                } else {
                  // Enhance overview with AI if it's short
                  const movieYear = releaseYear ? parseInt(releaseYear) : movieGuess.year;
                  let enhancedOverview = tmdbResult.overview || movieGuess.reasoning;
                  
                  if (!enhancedOverview || enhancedOverview.length < 300) {
                    console.log(`  🤖 Enhancing short overview (${enhancedOverview?.length || 0} chars)...`);
                    enhancedOverview = await generateEnhancedOverview(title, movieYear, enhancedOverview);
                  }
                  
                  // Save to our database
                  const { data: newMovie, error: insertError } = await supabaseAdmin
                    .from('movies')
                    .insert({
                      title: title,
                      year: movieYear,
                      overview: enhancedOverview,
                      poster_url: buildImageUrl(tmdbResult.poster_path),
                      backdrop_url: buildImageUrl(tmdbResult.backdrop_path, 'w1280'),
                      tmdb_id: tmdbResult.id,
                      imdb_id: (tmdbMovie as any).imdb_id || null,
                    })
                    .select()
                    .single();
                  
                  if (!insertError) {
                    console.log(`  ✓ Saved "${newMovie.title}" to database (ID: ${newMovie.id})`);
                    movie = newMovie;
                  } else {
                    console.error(`  ❌ Failed to save: ${insertError.message}`);
                  }
                }
              } else {
                // TMDB didn't find it, create basic entry with AI-enhanced overview
                console.log(`  ⚠️ Not found on TMDB, creating basic entry`);
                
                // Generate AI overview even for unknown movies
                let enhancedOverview = movieGuess.reasoning;
                if (!enhancedOverview || enhancedOverview.length < 200) {
                  console.log(`  🤖 Generating AI overview for unknown movie...`);
                  enhancedOverview = await generateEnhancedOverview(movieGuess.title, movieGuess.year, movieGuess.reasoning);
                }
                
                const { data: newMovie } = await supabaseAdmin
                  .from('movies')
                  .insert({
                    title: movieGuess.title,
                    year: movieGuess.year,
                    overview: enhancedOverview,
                  })
                  .select()
                  .single();
                movie = newMovie;
              }
            }

            if (movie) {
              const processingTime = Date.now() - startTime;
              
              // Update upload record
              if (upload) {
                await supabaseAdmin
                  .from('user_uploads')
                  .update({
                    result_movie_id: movie.id,
                    confidence_score: movieGuess.confidence,
                    matched_signals: { ai_identification: true },
                    processing_time_ms: processingTime,
                  })
                  .eq('id', upload.id);
              }

              console.log(`\n✅ SUCCESS (AI): "${movie.title}" (${(movieGuess.confidence * 100).toFixed(1)}% confidence)`);
              console.log(`⏱️ Processing time: ${processingTime}ms`);
              console.log('========== RECOGNITION REQUEST END (AI SUCCESS) ==========\n');

              return NextResponse.json({
                movie,
                confidence: movieGuess.confidence,
                matched_on: ['ai_identification'],
                reasoning: movieGuess.reasoning,
                processing_time: processingTime,
              });
            }
          }
        } catch (aiError: any) {
          console.error('  ❌ AI identification failed:', aiError.message);
        }
      }

      // Save to failed matches for review
      if (upload) {
        const { error: failedError } = await supabaseAdmin.from('failed_matches').insert({
          upload_id: upload.id,
          video_url: videoUrl,
        });
        if (failedError) {
          console.error('Failed to save failed match:', failedError.message);
        }
      }

      console.log('❌ No matches found from any signal');
      console.log('========== RECOGNITION REQUEST END (NO MATCH) ==========\n');
      return NextResponse.json(
        { error: 'No match found', upload_id: upload?.id },
        { status: 404 }
      );
    }

    // Count votes by movie_id with weighted scores
    const voteCounts: Record<number, { score: number; signals: Set<string> }> = {};
    
    for (const match of matches) {
      if (!voteCounts[match.movie_id]) {
        voteCounts[match.movie_id] = { score: 0, signals: new Set() };
      }
      voteCounts[match.movie_id].score += match.score;
      voteCounts[match.movie_id].signals.add(match.signal);
    }

    console.log(`  Unique movies matched: ${Object.keys(voteCounts).length}`);

    // Find best match
    const sortedMovies = Object.entries(voteCounts).sort(
      ([, a], [, b]) => b.score - a.score
    );

    const [bestMovieId, bestMatch] = sortedMovies[0];
    const totalScore = Object.values(voteCounts).reduce((sum, m) => sum + m.score, 0);
    const confidence = bestMatch.score / totalScore;

    console.log(`  Best match: movie_id=${bestMovieId}, score=${bestMatch.score}, confidence=${(confidence * 100).toFixed(1)}%`);

    // If confidence is too low, try AI identification instead
    if (confidence < 0.4) {
      console.log('  ⚠️ Database confidence too low (<40%), trying AI identification...');
      
      if (transcript || sceneDescriptions.length > 0) {
        try {
          const movieGuess = await identifyMovie(transcript, sceneDescriptions, subtitleSuggestions);
          console.log(`  🤖 GPT identified: "${movieGuess.title}" (${movieGuess.year}) - ${(movieGuess.confidence * 100).toFixed(0)}% confident`);
          console.log(`  📝 Reasoning: ${movieGuess.reasoning}`);

          if (movieGuess.confidence >= 0.5) {
            // Search for this movie in our database with flexible matching
            // Extract main title (before colon or dash for subtitles)
            const mainTitle = movieGuess.title.split(/[:\-–]/)[0].trim();
            
            const { data: foundMovies } = await supabaseAdmin
              .from('movies')
              .select('*')
              .or(`title.ilike.%${movieGuess.title}%,title.ilike.%${mainTitle}%`)
              .limit(5);

            // Find best match - prefer exact year, but for TV shows accept title match
            let aiMovie = foundMovies?.find(m => m.year === movieGuess.year);
            
            // If no exact year match but we have a title match, use it (TV shows have different season years)
            if (!aiMovie && foundMovies && foundMovies.length > 0) {
              const exactTitleMatch = foundMovies.find(m => 
                m.title.toLowerCase() === movieGuess.title.toLowerCase()
              );
              if (exactTitleMatch) {
                console.log(`  ✓ Using existing DB entry with different year (TV series season vs first air date)`);
                aiMovie = exactTitleMatch;
              }
            }
            
            console.log(`  🔍 Found ${foundMovies?.length || 0} potential matches in DB`);
            if (foundMovies && foundMovies.length > 0) {
              console.log(`    Candidates: ${foundMovies.map(m => `${m.title} (${m.year})`).join(', ')}`);
            }

            // If no match found, fetch from TMDB and save
            if (!aiMovie && movieGuess.confidence >= 0.5) {
              console.log(`  🎬 Movie not in DB, fetching from TMDB: "${movieGuess.title}" (${movieGuess.year})`);
              
              // Use searchMulti to find BOTH movies and TV shows
              const tmdbResult = await searchMulti(movieGuess.title, movieGuess.year);
              
              if (tmdbResult) {
                const isTV = tmdbResult.media_type === 'tv';
                const tvShow = tmdbResult as TMDBTVShow;
                const title = isTV ? tvShow.name : (tmdbResult as any).title;
                const releaseDate = isTV ? tvShow.first_air_date : (tmdbResult as any).release_date;
                
                console.log(`  ✓ Found on TMDB (${isTV ? 'TV' : 'Movie'}): "${title}" (${releaseDate?.substring(0, 4)})`);
                
                // Check if already exists by tmdb_id (handles duplicate key scenario)
                const { data: existingByTmdb } = await supabaseAdmin
                  .from('movies')
                  .select('*')
                  .eq('tmdb_id', tmdbResult.id)
                  .single();
                
                if (existingByTmdb) {
                  console.log(`  ✓ Already in DB by tmdb_id: "${existingByTmdb.title}" (ID: ${existingByTmdb.id})`);
                  aiMovie = existingByTmdb;
                } else {
                  // Save to our database
                  const { data: newMovie, error: insertError } = await supabaseAdmin
                    .from('movies')
                    .insert({
                      title: title,
                      year: releaseDate ? parseInt(releaseDate.substring(0, 4)) : movieGuess.year,
                      overview: tmdbResult.overview || movieGuess.reasoning,
                      poster_url: buildImageUrl(tmdbResult.poster_path),
                      backdrop_url: buildImageUrl(tmdbResult.backdrop_path, 'w1280'),
                      tmdb_id: tmdbResult.id,
                      imdb_id: (tmdbResult as any).imdb_id || null,
                    })
                    .select()
                    .single();
                  
                  if (insertError) {
                    console.error(`  ⚠️ Failed to save movie: ${insertError.message}`);
                  } else {
                    console.log(`  ✓ Saved "${newMovie.title}" to database (ID: ${newMovie.id})`);
                    aiMovie = newMovie;
                  }
                }
              } else {
                // TMDB didn't find it, create basic entry
                console.log(`  ⚠️ Not found on TMDB, creating basic entry`);
                const { data: newMovie } = await supabaseAdmin
                  .from('movies')
                  .insert({
                    title: movieGuess.title,
                    year: movieGuess.year,
                    overview: movieGuess.reasoning,
                  })
                  .select()
                  .single();
                aiMovie = newMovie;
              }
            }

            if (aiMovie) {
              const processingTime = Date.now() - startTime;
              
              if (upload) {
                await supabaseAdmin
                  .from('user_uploads')
                  .update({
                    result_movie_id: aiMovie.id,
                    confidence_score: movieGuess.confidence,
                    matched_signals: { ai_identification: true, tmdb_fetched: !foundMovies?.find(m => m.year === movieGuess.year) },
                    processing_time_ms: processingTime,
                  })
                  .eq('id', upload.id);
              }

              console.log(`\n✅ SUCCESS (AI Override): "${aiMovie.title}" (${(movieGuess.confidence * 100).toFixed(1)}% confidence)`);
              console.log(`⏱️ Processing time: ${processingTime}ms`);
              console.log('========== RECOGNITION REQUEST END (AI OVERRIDE) ==========\n');

              return NextResponse.json({
                movie: aiMovie,
                confidence: movieGuess.confidence,
                matched_on: ['ai_identification'],
                reasoning: movieGuess.reasoning,
                processing_time: processingTime,
              });
            }
          }
        } catch (aiError: any) {
          console.error('  ❌ AI identification failed:', aiError.message);
        }
      }
    }

    // 8. Get movie details
    console.log('📥 Fetching movie details...');
    const { data: movie, error: movieError } = await supabaseAdmin
      .from('movies')
      .select('*')
      .eq('id', bestMovieId)
      .single();

    if (movieError || !movie) {
      console.error('❌ Movie not found:', movieError?.message);
      console.log('========== RECOGNITION REQUEST END (MOVIE NOT FOUND) ==========\n');
      return NextResponse.json(
        { error: 'Movie not found in database' },
        { status: 404 }
      );
    }

    console.log(`✓ Movie found: "${movie.title}" (${movie.year})`);

    // 6. Update upload record with final video URL and result
    const processingTime = Date.now() - startTime;
    console.log('📥 Step 6: Updating upload record...');
    
    // Wait for background upload to finish
    await uploadPromise;
    
    if (upload) {
      const { error: updateError } = await supabaseAdmin
        .from('user_uploads')
        .update({
          video_url: videoUrl, // Update with actual URL from background upload
          result_movie_id: parseInt(bestMovieId),
          confidence_score: confidence,
          matched_signals: {
            dialogue: bestMatch.signals.has('dialogue'),
            visual: bestMatch.signals.has('visual'),
          },
          processing_time_ms: processingTime,
        })
        .eq('id', upload.id);
      
      if (updateError) {
        console.error('⚠️ Failed to update upload record:', updateError.message);
      } else {
        console.log('✓ Upload record updated');
      }
    }

    // 7. Update analytics
    console.log('📥 Step 7: Updating analytics...');
    const { error: analyticsError } = await supabaseAdmin.rpc('increment_search_count', {
      p_movie_id: parseInt(bestMovieId),
    });
    
    if (analyticsError) {
      console.error('⚠️ Analytics update failed:', analyticsError.message);
    }

    console.log(`\n✅ SUCCESS: "${movie.title}" (${(confidence * 100).toFixed(1)}% confidence)`);
    console.log(`⏱️ Processing time: ${processingTime}ms`);
    console.log('========== RECOGNITION REQUEST END (SUCCESS) ==========\n');

    // 11. Return result
    return NextResponse.json({
      movie,
      confidence,
      matched_on: Array.from(bestMatch.signals),
      processing_time: processingTime,
    });

  } catch (error: any) {
    console.error('\n❌ FATAL ERROR:', error.message);
    console.error('Stack:', error.stack);
    console.log('========== RECOGNITION REQUEST END (ERROR) ==========\n');
    return NextResponse.json(
      { error: 'Processing failed', details: error.message },
      { status: 500 }
    );
  }
}
