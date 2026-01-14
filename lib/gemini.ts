/**
 * Gemini Flash API for fast visual analysis
 * Used for OCR (text on screen) and actor recognition
 * Falls back gracefully if GEMINI_API_KEY is not configured
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Timeout for Gemini API calls (10 seconds - reduced for faster failures)
const GEMINI_TIMEOUT_MS = 10000;

// Check if Gemini is available
export const isGeminiAvailable = () => !!GEMINI_API_KEY;

// Helper to create a timeout promise
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg)), ms)
    )
  ]);
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message: string;
  };
}

/**
 * Transcribe audio using Gemini (alternative to Whisper)
 * Gemini 2.0 Flash supports audio input
 */
export async function transcribeAudioGemini(audioBuffer: Buffer): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const audioBase64 = audioBuffer.toString('base64');
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 second timeout

  try {
    const response = await fetch(
      `${GEMINI_BASE_URL}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: 'audio/wav',
                    data: audioBase64,
                  },
                },
                {
                  text: 'Transcribe this audio clip. Return ONLY the transcribed text, nothing else. If you hear dialogue from a movie or TV show, include it exactly as spoken.',
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);
    const data: GeminiResponse = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Gemini transcription timed out after 20s');
    }
    throw error;
  }
}

/**
 * Analyze image with Gemini Flash
 * Using gemini-2.0-flash (stable) - has higher quota than experimental
 */
async function analyzeWithGemini(
  imageBase64: string,
  prompt: string,
  model: string = 'gemini-2.0-flash'
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: imageBase64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);
    const data: GeminiResponse = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Gemini API timeout after ${GEMINI_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
}

/**
 * Quick pre-scan to check if a frame has visible faces
 * Used to prioritize which frames to do full actor identification on
 */
export async function quickFaceScan(frameBase64: string): Promise<{
  hasFaces: boolean;
  faceCount: number;
  hasClearFrontalFace: boolean;
}> {
  const prompt = `Quick scan: Are there any human faces visible in this image?

IMPORTANT: A "clear frontal face" means:
- Face is looking toward the camera (not turned away or in profile)
- Both eyes are visible
- Face is well-lit and in focus
- Face takes up a reasonable portion of the frame (not tiny in background)

Return JSON only:
{
  "hasFaces": true/false (any faces at all, even partial),
  "faceCount": number of faces visible (0 if none),
  "hasClearFrontalFace": true ONLY if at least one face meets ALL the criteria above
}

Be conservative with hasClearFrontalFace - only true if you could realistically identify the person.`;

  try {
    const result = await analyzeWithGemini(frameBase64, prompt);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { hasFaces: false, faceCount: 0, hasClearFrontalFace: false };
  } catch (error) {
    return { hasFaces: false, faceCount: 0, hasClearFrontalFace: false };
  }
}

/**
 * Extract text visible on screen (OCR)
 * Looks for: titles, credits, subtitles, signs, etc.
 */
export async function extractScreenText(frameBase64: string): Promise<{
  text: string[];
  movieTitle?: string;
  credits?: string[];
}> {
  const prompt = `Analyze this movie/TV frame and extract ALL visible text.

Look for:
1. Movie/show title if visible
2. Opening/closing credits (actor names, director, etc.)
3. On-screen subtitles or captions
4. Signs, newspapers, or any readable text in the scene
5. Watermarks or channel logos

Return as JSON:
{
  "text": ["all", "visible", "text", "items"],
  "movieTitle": "title if visible or null",
  "credits": ["actor names", "if visible in credits"]
}

Only return the JSON, no other text.`;

  try {
    const result = await analyzeWithGemini(frameBase64, prompt);
    
    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return { text: [] };
  } catch (error: any) {
    console.error('  ⚠️ OCR failed:', error.message);
    return { text: [] };
  }
}

/**
 * Identify actors/people in the frame
 */
export async function identifyActors(frameBase64: string): Promise<{
  actors: string[];
  characters?: string[];
  confidence: number;
}> {
  const prompt = `You are an expert at identifying actors and celebrities. Carefully analyze this movie/TV frame.

STRICT REQUIREMENTS - You MUST be able to:
1. See a CLEAR, FRONT-FACING view of the person's face
2. Identify SPECIFIC facial features (eyes, nose, mouth shape)
3. Be AT LEAST 85% certain of your identification

DO NOT IDENTIFY IF:
- Face is turned away from camera or in profile
- Person is wearing a mask, hat, or sunglasses covering face
- Face is too small, blurry, dark, or partially obscured
- You're only guessing based on body shape, hair color, or clothing
- The person MIGHT look similar but you're not 100% sure
- The actor you're thinking of has passed away (e.g., don't guess deceased actors)

MODERN ACTORS/CELEBRITIES (2020s era - prioritize these):
- Vince Staples (rapper/actor, dark skin, often wears caps, distinctive face)
- Zendaya, Timothée Chalamet, Florence Pugh, Sydney Sweeney
- Pedro Pascal, Oscar Isaac, Jonathan Majors
- Keke Palmer, Lakeith Stanfield, Brian Tyree Henry
- Maitreyi Ramakrishnan, Awkwafina, Simu Liu
- Glen Powell, Austin Butler, Jacob Elordi
- Jenna Ortega, Millie Bobby Brown, Hailee Steinfeld

ESTABLISHED ACTORS:
- Kevin Hart, Dwayne Johnson, Will Smith, Denzel Washington
- Tom Hanks, Tom Cruise, Brad Pitt, Leonardo DiCaprio
- Morgan Freeman, Samuel L. Jackson, Idris Elba
- Scarlett Johansson, Jennifer Lawrence, Margot Robbie

Return as JSON:
{
  "actors": ["Full Actor Name"],
  "characters": ["Character name if recognizable"],
  "confidence": 0.0 to 1.0,
  "reasoning": "Describe the SPECIFIC facial features you can clearly see",
  "face_visible": true or false
}

CRITICAL: If you cannot see a clear front-facing view of someone's face, return:
{"actors": [], "characters": [], "confidence": 0, "reasoning": "No clear face visible", "face_visible": false}

Only return the JSON, no other text.`;

  try {
    const result = await analyzeWithGemini(frameBase64, prompt);
    
    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Log reasoning if provided
      if (parsed.reasoning) {
        console.log(`    🎭 Actor reasoning: ${parsed.reasoning}`);
      }
      
      // FILTER: Only accept identifications where face is clearly visible and confidence >= 0.8
      if (parsed.face_visible === false || parsed.confidence < 0.8) {
        console.log(`    ⚠️ Actor identification rejected (face_visible: ${parsed.face_visible}, confidence: ${parsed.confidence})`);
        return { actors: [], confidence: 0 };
      }
      
      return {
        actors: parsed.actors || [],
        characters: parsed.characters,
        confidence: parsed.confidence || 0
      };
    }
    
    return { actors: [], confidence: 0 };
  } catch (error: any) {
    console.error('  ⚠️ Actor identification failed:', error.message);
    return { actors: [], confidence: 0 };
  }
}

/**
 * Describe scene with Gemini (alternative to GPT-4V)
 */
export async function describeSceneGemini(frameBase64: string): Promise<string> {
  const prompt = `Describe this movie/TV scene in detail for identification purposes.

Include:
1. Setting/location (indoor/outdoor, time period, specific location type)
2. Visual style (lighting, color palette, cinematography)
3. Action happening in the scene
4. Any distinctive props, costumes, or visual elements
5. Genre indicators (action, comedy, horror, sci-fi, etc.)
6. Production quality hints (big budget, indie, TV show, etc.)

Be specific and descriptive to help identify which movie or TV show this is from.`;

  try {
    return await analyzeWithGemini(frameBase64, prompt);
  } catch (error: any) {
    console.error('  ⚠️ Scene description failed:', error.message);
    return '';
  }
}

/**
 * Combined analysis - run all Gemini analyses on a frame
 */
export async function analyzeFrameComplete(frameBase64: string): Promise<{
  ocr: { text: string[]; movieTitle?: string; credits?: string[] };
  actors: { actors: string[]; characters?: string[]; confidence: number };
  scene: string;
}> {
  // Run all analyses in parallel for speed
  const [ocr, actors, scene] = await Promise.all([
    extractScreenText(frameBase64),
    identifyActors(frameBase64),
    describeSceneGemini(frameBase64),
  ]);

  return { ocr, actors, scene };
}

/**
 * ONE-SHOT Movie Recognition - Everything in ONE Gemini Call
 * Analyzes frames, audio transcript, and identifies the movie all at once
 * This is MUCH faster than multiple separate API calls
 */
export async function recognizeMovieOneShot(
  frames: Buffer[],
  audioTranscript: string
): Promise<{
  title: string;
  year: number | null;
  confidence: number;
  reasoning: string;
  matchedSignals: string[];
  alternativeTitles: Array<{ title: string; year: number; confidence: number }>;
  actors: string[];
  ocrText: string[];
  sceneDescription: string;
}> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  // Convert frames to base64 and build parts array
  const imageParts = frames.slice(0, 4).map((frame, i) => ({
    inline_data: {
      mime_type: 'image/jpeg',
      data: frame.toString('base64'),
    },
  }));

  const prompt = `You are an expert movie and TV show identifier. I'm showing you ${frames.length} frames from a video clip along with the audio transcript. Your job is to analyze ALL signals and identify the movie or TV show.

=== SIGNAL 1: AUDIO TRANSCRIPT ===
${audioTranscript || '(no audio transcript available)'}

=== SIGNAL 2: VISUAL FRAMES ===
I've provided ${frames.length} frames from the video. Analyze them for:
- Actor faces (who do you recognize?)
- On-screen text (titles, credits, subtitles - IGNORE TikTok/Instagram/YouTube watermarks)
- Scene setting, action, mood, visual style, costumes, props

=== CRITICAL IDENTIFICATION RULES ===

**TRANSCRIPT IS MOST IMPORTANT**: The dialogue/transcript is the strongest signal. If it mentions specific plot points, settings, or unique terminology - PRIORITIZE THIS over uncertain visual identification.

**IGNORE SOCIAL MEDIA WATERMARKS**: TikTok, Instagram, YouTube logos/handles are WHERE the clip is shared, NOT the source. Identify the ORIGINAL movie/TV show.

**BE VERY CAREFUL WITH 2024-2026 CONTENT**: Many new shows exist that you may not know well. If the transcript describes a unique plot (like sea creatures, aliens, specific scenarios), search your knowledge for 2024-2026 releases.

**COMMON MISIDENTIFICATIONS TO AVOID**:
- If transcript mentions "war", "land", "sea", "aquatic beings", "gills", "scales" = likely "The War Between the Land and the Sea" (2025), NOT Monarch or Aquaman
- If monster/creature content, check if it matches a specific 2024-2026 release before defaulting to older shows

**KEVIN HART + DWAYNE JOHNSON MOVIES (when BOTH are identified)**:
- "Central Intelligence" (2016) - Comedy, CIA agent recruits old classmate
- "Jumanji: Welcome to the Jungle" (2017) - Adventure, video game jungle world
- "Jumanji: The Next Level" (2019) - Adventure, video game sequel

**KEVIN HART SOLO MOVIES (only Kevin Hart alone)**:
- "Me Time" (2022) - Netflix comedy with Mark Wahlberg, wild cats/mountain lion
- "Lift" (2024) - Heist movie
- "Die Hart" (2020-2023) - Action comedy series (NO Dwayne Johnson!)
- "Ride Along" (2014, 2016) - Comedy with Ice Cube

**DWAYNE JOHNSON SOLO MOVIES (only Dwayne Johnson alone)**:
- "Black Adam" (2022) - Superhero
- "Red Notice" (2021) - Action comedy with Ryan Reynolds
- "Jungle Cruise" (2021) - Adventure with Emily Blunt
- "Fast & Furious" franchise - Action

**SCI-FI/TECH THRILLER RECOGNITION** (identify by TRANSCRIPT/PLOT):
- "Upgrade" (2018) - STEM chip, paralysis cure, AI controlling body, "human body as weapon", self-driving car accident, revenge thriller with Logan Marshall-Green
- "Ex Machina" (2014) - AI/robot, Turing test, isolated research facility
- "Blade Runner 2049" (2017) - Replicants, dystopian LA, memory implants
- "The Creator" (2023) - AI war, robot child, futuristic war
- "M3GAN" (2022) - AI doll, child companion robot gone wrong
- "Transcendence" (2014) - Mind uploading, AI consciousness

**WAR/DRAMA RECOGNITION**:
- "Beasts of No Nation" (2015) - Child soldiers, African civil war, Idris Elba as warlord
- "Blood Diamond" (2006) - Sierra Leone, conflict diamonds, Leonardo DiCaprio
- "Hotel Rwanda" (2004) - Rwandan genocide, hotel manager saves refugees

**SEA CREATURES / AQUATIC SCI-FI** (very important!):
- "The War Between the Land and the Sea" (2025) - Doctor Who spinoff, UNIT, ancient sea species emerges from ocean, war between humans and aquatic beings, gills, scales, military response, Russell T Davies
- "Aquaman" (2018, 2023) - DC superhero, underwater kingdom Atlantis, Jason Momoa
- "The Shape of Water" (2017) - Mute woman falls for amphibian creature, 1960s lab, Guillermo del Toro
- "Underwater" (2020) - Kristen Stewart, deep sea drilling, Lovecraftian creatures
- "The Abyss" (1989) - Underwater aliens, deep sea oil rig

**DOCTOR WHO UNIVERSE**:
- "The War Between the Land and the Sea" (2025) - UNIT spinoff, sea creatures vs humanity, aquatic invasion
- "Doctor Who" (2005-present) - Time Lord, TARDIS, various alien threats
- "Torchwood" (2006-2011) - Cardiff, alien artifacts, Captain Jack

**SCENE CONTEXT CLUES**:
- Kevin Hart + Dwayne Johnson + comedy/action = "Central Intelligence" or "Jumanji"
- Modern day + spy/CIA themes = "Central Intelligence" (2016)
- Jungle/video game world = "Jumanji" films
- AI chip + paralyzed protagonist + revenge = "Upgrade" (2018)
- Child soldiers + African setting + Idris Elba = "Beasts of No Nation"
- Aquatic creatures + gills + scales + war/invasion = "The War Between the Land and the Sea" (2025)
- Sea creature + UNIT + military = "The War Between the Land and the Sea" (2025)
- Underwater lab + creature + romance = "The Shape of Water" (2017)

=== YOUR TASK ===
1. **TRANSCRIPT FIRST**: If transcript contains distinctive dialogue or plot elements, prioritize this
2. **BE SKEPTICAL OF ACTOR IDs**: Face recognition can misidentify actors, especially with beards/different lighting
3. If actors identified don't make sense together, they may be wrong - trust transcript
4. For sci-fi/tech thrillers, focus on the TECHNOLOGY described, not just actors
5. ALWAYS provide 2-3 alternative guesses

=== RESPOND WITH JSON ===
{
  "title": "Movie or TV Show Title",
  "year": 2024,
  "confidence": 0.0-1.0,
  "reasoning": "Detailed explanation of how you identified this. Mention which signals matched and why you trust them.",
  "matchedSignals": ["transcript", "actors", "scene", "ocr"],
  "alternativeTitles": [
    {"title": "Second guess", "year": 2023, "confidence": 0.5},
    {"title": "Third guess", "year": 2022, "confidence": 0.3}
  ],
  "actors": ["Actor Name 1", "Actor Name 2"],
  "ocrText": ["any text seen on screen excluding social media watermarks"],
  "sceneDescription": "Brief description of setting, action, mood, visual style"
}

If you cannot identify the movie with any confidence, use title "Unknown" and confidence 0.3.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for this comprehensive call

  try {
    const response = await fetch(
      `${GEMINI_BASE_URL}/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                ...imageParts,
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2048,
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);
    const data: GeminiResponse = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Parse JSON from response
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Gemini response');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    return {
      title: result.title || 'Unknown',
      year: result.year || null,
      confidence: result.confidence || 0.3,
      reasoning: result.reasoning || 'No reasoning provided',
      matchedSignals: result.matchedSignals || [],
      alternativeTitles: result.alternativeTitles || [],
      actors: result.actors || [],
      ocrText: result.ocrText || [],
      sceneDescription: result.sceneDescription || '',
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Gemini one-shot recognition timed out after 30s');
    }
    throw error;
  }
}
