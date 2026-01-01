import { supabase } from './supabase';

interface SubtitleResult {
  movie_id: number;
  similarity: number;
  matched_text: string;
  imdb_id: string;
}

interface SubtitleSearchResult {
  matches: SubtitleResult[];
  suggestedTitles: string[]; // Only titles that actually matched dialogue (from our DB)
}

/**
 * Search OpenSubtitles API for matching subtitles
 * NOTE: OpenSubtitles 'query' param searches by title/filename, NOT dialogue content!
 * So we can only use it to find movies in our DB, not as reliable hints for GPT.
 */
export async function searchSubtitles(
  transcript: string
): Promise<SubtitleSearchResult> {
  const API_KEY = process.env.OPENSUBTITLES_API_KEY;
  
  if (!API_KEY) {
    console.log('  ⚠️ OpenSubtitles API key not configured');
    return { matches: [], suggestedTitles: [] };
  }
  
  // Extract key phrases from transcript (use meaningful chunk)
  const query = transcript
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .substring(0, 100)
    .trim();
  
  if (!query || query.length < 10) {
    console.log('  ⚠️ Transcript too short for subtitle search');
    return { matches: [], suggestedTitles: [] };
  }
  
  console.log(`  🔍 Searching OpenSubtitles for: "${query.substring(0, 50)}..."`);  
  console.log(`  ⚠️ Note: OpenSubtitles searches by TITLE, not dialogue content`);
  
  try {
    // Search OpenSubtitles for this quote (with 10s timeout)
    const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    url.searchParams.append('query', query);
    url.searchParams.append('languages', 'en');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`  ⚠️ OpenSubtitles API error: ${response.status} - ${errorText}`);
      return { matches: [], suggestedTitles: [] };
    }
    
    const data = await response.json();
    
    if (!data.data || data.data.length === 0) {
      console.log('  ⚠️ No subtitle matches found');
      return { matches: [], suggestedTitles: [] };
    }
    
    console.log(`  ✓ OpenSubtitles returned ${data.data.length} results (title matches, not dialogue)`);
    
    // DON'T use these as matches - they're TITLE matches, not dialogue!
    // OpenSubtitles API searches by movie title, not dialogue content
    // Only log for debugging
    for (const subtitle of data.data.slice(0, 5)) {
      const feature = subtitle.attributes?.feature_details;
      if (feature) {
        const title = feature.title || feature.movie_name;
        const year = feature.year;
        if (title) {
          console.log(`    📺 Title match (ignored): "${title}" (${year || '?'})`);
        }
      }
    }
    
    // IMPORTANT: We return empty matches because OpenSubtitles title-based
    // matching is unreliable for dialogue recognition. The API doesn't actually
    // search subtitle content - it searches movie titles/filenames.
    // Keeping this function for potential future use with a proper subtitle search API.
    console.log(`  ✓ 0 dialogue matches (OpenSubtitles only searches titles)`);
    return { matches: [], suggestedTitles: [] };
    
  } catch (error: any) {
    console.error('  ❌ OpenSubtitles search failed:', error.message);
    return { matches: [], suggestedTitles: [] };
  }
}

/**
 * Alternative: Search for subtitles by IMDB ID
 * Useful when we already know the movie
 */
export async function getSubtitlesForMovie(imdb_id: string): Promise<string[]> {
  const API_KEY = process.env.OPENSUBTITLES_API_KEY;
  
  if (!API_KEY) return [];
  
  try {
    const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    url.searchParams.append('imdb_id', imdb_id.replace('tt', ''));
    url.searchParams.append('languages', 'en');
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0'
      }
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
    
    // Return subtitle file IDs for potential download
    return data.data?.map((s: any) => s.attributes?.files?.[0]?.file_id).filter(Boolean) || [];
    
  } catch (error) {
    return [];
  }
}

/**
 * Search for subtitles by IMDB ID (returns full results)
 */
export async function searchSubtitlesByImdbId(imdb_id: string): Promise<any[] | null> {
  const API_KEY = process.env.OPENSUBTITLES_API_KEY;
  
  if (!API_KEY) return null;
  
  try {
    const url = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    url.searchParams.append('imdb_id', imdb_id.replace('tt', ''));
    url.searchParams.append('languages', 'en');
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0'
      }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.data || null;
    
  } catch (error) {
    return null;
  }
}

/**
 * Download a subtitle file by file_id
 */
export async function downloadSubtitle(file_id: number): Promise<string | null> {
  const API_KEY = process.env.OPENSUBTITLES_API_KEY;
  
  if (!API_KEY) return null;
  
  try {
    // First, get download link
    const response = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers: {
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0'
      },
      body: JSON.stringify({ file_id })
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const downloadUrl = data.link;
    
    if (!downloadUrl) return null;
    
    // Download the actual subtitle file
    const subResponse = await fetch(downloadUrl);
    if (!subResponse.ok) return null;
    
    return await subResponse.text();
    
  } catch (error) {
    return null;
  }
}

/**
 * Parse SRT subtitle content into structured lines
 */
export function parseSubtitleContent(content: string): Array<{ text: string; start: string; end: string }> {
  const lines: Array<{ text: string; start: string; end: string }> = [];
  const blocks = content.split(/\n\n+/);
  
  for (const block of blocks) {
    const blockLines = block.trim().split('\n');
    if (blockLines.length < 3) continue;
    
    // Find timestamp line (format: 00:01:23,456 --> 00:01:25,789)
    const timestampLine = blockLines.find(l => l.includes('-->'));
    if (!timestampLine) continue;
    
    const [start, end] = timestampLine.split('-->').map(t => t.trim());
    
    // Get text lines (everything after timestamp)
    const timestampIndex = blockLines.indexOf(timestampLine);
    const textLines = blockLines.slice(timestampIndex + 1);
    const text = textLines
      .join(' ')
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/\{[^}]*\}/g, '') // Remove style tags
      .trim();
    
    if (text && text.length > 3) {
      lines.push({ text, start, end });
    }
  }
  
  return lines;
}

