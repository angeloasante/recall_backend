import OpenAI, { toFile } from 'openai';
import { Readable } from 'stream';

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Timeout helper for Whisper (30 seconds max)
const WHISPER_TIMEOUT_MS = 30000;

// Transcribe audio using Whisper with timeout
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  // Convert Buffer to a format OpenAI can accept
  const file = await toFile(audioBuffer, 'audio.wav', { type: 'audio/wav' });
  
  // Create a promise that times out
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Whisper timeout after ${WHISPER_TIMEOUT_MS / 1000}s`)), WHISPER_TIMEOUT_MS);
  });
  
  const transcriptionPromise = openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'en',
  });

  // Race between transcription and timeout
  const transcription = await Promise.race([transcriptionPromise, timeoutPromise]);
  return transcription.text;
}

// Describe a scene using GPT-4 Vision
export async function describeScene(imageUrl: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this movie scene briefly: setting, characters, action, and mood. 2-3 sentences max.',
          },
          {
            type: 'image_url',
            image_url: { url: imageUrl },
          },
        ],
      },
    ],
    max_tokens: 150,
  });

  return response.choices[0].message.content || '';
}

// Identify actors using GPT-4o Vision (fallback when Gemini fails)
export async function identifyActorsGPT(imageBase64: string): Promise<{
  actors: string[];
  confidence: number;
  reasoning?: string;
}> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Identify any recognizable actors or celebrities in this movie/TV frame.

Look carefully at:
1. Facial features, skin tone, hair
2. Body type, distinctive features
3. This appears to be from a professional production

Return JSON only:
{
  "actors": ["Full Actor Name"],
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}

If no recognizable actors, return empty array with 0 confidence.`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 200,
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return {
    actors: result.actors || [],
    confidence: result.confidence || 0,
    reasoning: result.reasoning,
  };
}

// Generate embedding for text
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text,
  });

  return response.data[0].embedding;
}

// Identify a movie or TV show from transcript and scene descriptions
export async function identifyMovie(
  transcript: string,
  sceneDescriptions: string[],
  subtitleHints: string[] = [] // Movie/TV titles suggested by OpenSubtitles
): Promise<{ title: string; year: number | null; confidence: number; reasoning: string }> {
  const hintsSection = subtitleHints.length > 0 
    ? `\nPOSSIBLE MOVIES/TV SHOWS (from subtitle database match - these are strong hints!):\n${subtitleHints.slice(0, 5).map(t => `- ${t}`).join('\n')}\n`
    : '';

  const prompt = `You are an expert in movies AND TV shows. Based on the following information from a video clip, identify the movie OR TV series.

AUDIO TRANSCRIPT:
${transcript || '(no transcript available)'}

VISUAL SCENE DESCRIPTIONS:
${sceneDescriptions.length > 0 ? sceneDescriptions.map((s, i) => `Scene ${i + 1}: ${s}`).join('\n') : '(no visual descriptions available)'}
${hintsSection}
Based on the dialogue, visual elements, characters, and setting, identify the movie or TV show. Consider:
- Specific dialogue or quotes
- Character appearances (blue-skinned = Avatar, superheroes, animated characters, etc.)
- Setting and visual style (sci-fi shows like Doctor Who, etc.)
- Any recognizable actors or voices
- This could be a TV series, miniseries, or movie - identify whichever it is!
${subtitleHints.length > 0 ? '- The subtitle hints above are strong indicators - if one matches the transcript/visuals, prioritize it!' : ''}

Respond with JSON only:
{
  "title": "Movie or TV Show Title",
  "year": 2024,
  "confidence": 0.85,
  "reasoning": "Brief explanation of why you identified this"
}

If you're not sure, still make your best guess with a lower confidence score (0.3-0.5).`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: 300,
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  
  return {
    title: result.title || 'Unknown',
    year: result.year || null,
    confidence: result.confidence || 0.3,
    reasoning: result.reasoning || 'No reasoning provided',
  };
}

/**
 * Multi-signal AI aggregation for movie/TV identification
 * Combines all extracted signals to make a final determination
 */
export interface SignalData {
  transcript: string;
  sceneDescriptions: string[];
  ocrText: string[];
  movieTitleOnScreen?: string;
  creditsOnScreen: string[];
  actorsIdentified: string[];
  actorConfidence: number;
  databaseMatches: Array<{ title: string; year: number; score: number }>;
}

export async function aggregateSignals(signals: SignalData): Promise<{
  title: string;
  year: number | null;
  confidence: number;
  reasoning: string;
  matchedSignals: string[];
}> {
  const prompt = `You are an expert movie and TV show identifier. Analyze ALL the following signals extracted from a video clip and determine what movie or TV show it is.

=== SIGNAL 1: AUDIO TRANSCRIPT ===
${signals.transcript || '(none available)'}

=== SIGNAL 2: VISUAL SCENE DESCRIPTIONS ===
${signals.sceneDescriptions.length > 0 
  ? signals.sceneDescriptions.map((s, i) => `Frame ${i + 1}: ${s}`).join('\n')
  : '(none available)'}

=== SIGNAL 3: ON-SCREEN TEXT (OCR) ===
${signals.ocrText.length > 0 ? signals.ocrText.join(', ') : '(none found)'}
${signals.movieTitleOnScreen ? `MOVIE TITLE VISIBLE: "${signals.movieTitleOnScreen}"` : ''}
${signals.creditsOnScreen.length > 0 ? `CREDITS VISIBLE: ${signals.creditsOnScreen.join(', ')}` : ''}

=== SIGNAL 4: ACTOR RECOGNITION ===
${signals.actorsIdentified.length > 0 
  ? `Identified actors (${Math.round(signals.actorConfidence * 100)}% confidence): ${signals.actorsIdentified.join(', ')}`
  : '(no actors identified)'}

=== SIGNAL 5: DATABASE MATCHES (from our movie database) ===
${signals.databaseMatches.length > 0
  ? signals.databaseMatches.map(m => `- "${m.title}" (${m.year}) - ${Math.round(m.score * 100)}% match`).join('\n')
  : '(no database matches)'}

=== CRITICAL INSTRUCTIONS ===

**IGNORE SOCIAL MEDIA WATERMARKS**: TikTok, Instagram, YouTube logos/handles are WHERE the clip is shared, NOT the source. Identify the ORIGINAL movie/TV show.

**MOST IMPORTANT RULE - VERIFY ALL ACTORS**: 
If multiple actors are identified, the movie MUST contain ALL of them.
For example: If you see Kevin Hart AND Dwayne Johnson, the movie MUST star BOTH actors.
"Die Hart" only has Kevin Hart - it does NOT have Dwayne Johnson!
"Central Intelligence" (2016) has BOTH Kevin Hart AND Dwayne Johnson.
"Jumanji" films have BOTH Kevin Hart AND Dwayne Johnson.

**KEVIN HART + DWAYNE JOHNSON MOVIES (when BOTH are identified)**:
- "Central Intelligence" (2016) - Comedy, CIA agent recruits old classmate
- "Jumanji: Welcome to the Jungle" (2017) - Adventure, video game jungle world
- "Jumanji: The Next Level" (2019) - Adventure, video game sequel
- "DC League of Super-Pets" (2022) - Animated, voice acting

**KEVIN HART SOLO MOVIES (only when Kevin Hart alone is identified)**:
- "Me Time" (2022) - Netflix comedy with Mark Wahlberg, wild cats/mountain lion
- "Lift" (2024) - Heist movie
- "Die Hart" series (2020-2023) - Action comedy series (NO Dwayne Johnson!)
- "The Man from Toronto" (2022) - Action comedy with Woody Harrelson
- "Fatherhood" (2021) - Drama
- "Ride Along" (2014, 2016) - Comedy with Ice Cube
- "Night School" (2018) - Comedy
- "Get Hard" (2015) - Comedy with Will Ferrell

**DWAYNE JOHNSON SOLO MOVIES (only when Dwayne Johnson alone is identified)**:
- "Black Adam" (2022) - Superhero
- "Red Notice" (2021) - Action comedy with Ryan Reynolds
- "Jungle Cruise" (2021) - Adventure with Emily Blunt
- "Rampage" (2018) - Action with giant animals
- "San Andreas" (2015) - Disaster movie
- "Fast & Furious" franchise - Action

**SCENE CONTEXT CLUES**:
- Kevin Hart + Dwayne Johnson + comedy/action = "Central Intelligence" or "Jumanji"
- Modern day setting + spy/CIA themes = "Central Intelligence" (2016)
- Jungle/video game world = "Jumanji" films
- Wild cats/mountain lion + Kevin Hart (alone) = "Me Time" (2022)

=== YOUR TASK ===
Analyze ALL signals and determine the movie/TV show:

1. **CRITICAL**: If multiple actors are identified, the movie MUST contain ALL of them
2. Match scene descriptions and dialogue to known movies featuring those specific actors TOGETHER
3. Use the transcript to identify specific scenes or dialogue patterns
4. DO NOT suggest a movie that only has ONE of the identified actors

Respond with JSON:
{
  "title": "Movie or TV Show Title",
  "year": 2024,
  "confidence": 0.0-1.0,
  "reasoning": "Explain which signals led to this identification and confirm ALL identified actors are in this movie",
  "matchedSignals": ["transcript", "actors", "scene", etc.]
}

If you cannot confidently identify the movie, respond with "Unknown" and confidence 0.3.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: 500,
  });

  const result = JSON.parse(response.choices[0].message.content || '{}');
  
  return {
    title: result.title || 'Unknown',
    year: result.year || null,
    confidence: result.confidence || 0.3,
    reasoning: result.reasoning || 'No reasoning provided',
    matchedSignals: result.matchedSignals || [],
  };
}
