import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generates an enhanced, detailed movie overview using AI
 * Takes the basic TMDB overview and expands it into a rich description
 */
export async function generateEnhancedOverview(
  title: string,
  year: number | null,
  existingOverview: string | null
): Promise<string> {
  // If existing overview is already long enough (500+ chars), keep it
  if (existingOverview && existingOverview.length >= 500) {
    return existingOverview;
  }

  try {
    const prompt = existingOverview 
      ? `Expand this movie overview into a detailed, engaging description (500-700 characters). Keep the facts accurate and don't make up plot points that aren't implied:

Movie: "${title}" (${year || 'Unknown year'})
Current overview: "${existingOverview}"

Write an expanded overview that:
- Maintains factual accuracy based on the original
- Adds context about themes, tone, and what makes the movie interesting
- Is engaging and well-written
- Does NOT spoil major plot twists
- Is 500-700 characters long

Return ONLY the expanded overview text, no quotes or extra formatting.`
      : `Write a brief but engaging movie overview (400-500 characters) for:

Movie: "${title}" (${year || 'Unknown year'})

The overview should:
- Be factually accurate based on common knowledge about this movie
- Describe the basic premise without major spoilers
- Mention key themes or what makes it notable
- Be 400-500 characters long

If you don't have reliable information about this specific movie, write: "A film that invites viewers on a cinematic journey. More details coming soon."

Return ONLY the overview text, no quotes or extra formatting.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cheaper and fast, good for this task
      messages: [
        {
          role: 'system',
          content: 'You are a professional movie database curator. Write accurate, engaging movie descriptions without spoilers. Be concise but informative.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const enhancedOverview = response.choices[0]?.message?.content?.trim();
    
    if (enhancedOverview && enhancedOverview.length > 100) {
      console.log(`  🤖 AI enhanced overview: ${existingOverview?.length || 0} -> ${enhancedOverview.length} chars`);
      return enhancedOverview;
    }
    
    // Fallback to existing if AI response is too short
    return existingOverview || 'No description available.';
  } catch (error) {
    console.error('Error generating enhanced overview:', error);
    // Return existing overview on error
    return existingOverview || 'No description available.';
  }
}

/**
 * Alternative: Use Gemini for overview enhancement (if preferred)
 */
export async function generateEnhancedOverviewGemini(
  title: string,
  year: number | null,
  existingOverview: string | null
): Promise<string> {
  // If existing overview is already long enough (500+ chars), keep it
  if (existingOverview && existingOverview.length >= 500) {
    return existingOverview;
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.log('  ⚠️ No Gemini API key, skipping overview enhancement');
    return existingOverview || 'No description available.';
  }

  try {
    const prompt = existingOverview 
      ? `Expand this movie overview into a detailed, engaging description (500-700 characters). Keep the facts accurate:

Movie: "${title}" (${year || 'Unknown year'})
Current overview: "${existingOverview}"

Write an expanded overview that maintains factual accuracy, adds context about themes and tone, and is engaging without spoilers. Return ONLY the expanded text.`
      : `Write a brief movie overview (400-500 characters) for "${title}" (${year || 'Unknown year'}). Be factually accurate and engaging without spoilers. Return ONLY the overview text.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 300,
          },
        }),
      }
    );

    const data = await response.json();
    const enhancedOverview = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    
    if (enhancedOverview && enhancedOverview.length > 100) {
      console.log(`  🤖 Gemini enhanced overview: ${existingOverview?.length || 0} -> ${enhancedOverview.length} chars`);
      return enhancedOverview;
    }
    
    return existingOverview || 'No description available.';
  } catch (error) {
    console.error('Error generating enhanced overview with Gemini:', error);
    return existingOverview || 'No description available.';
  }
}
