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
