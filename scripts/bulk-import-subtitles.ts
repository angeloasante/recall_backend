/**
 * Bulk import subtitles for all movies in the database
 * This downloads subtitle files from OpenSubtitles and extracts key dialogues
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;
const BATCH_SIZE = 10; // Process 10 movies at a time
const DELAY_MS = 2000; // Delay between API calls to avoid rate limiting

interface SubtitleLine {
  text: string;
  start: number;
  end: number;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchSubtitlesForMovie(imdbId: string): Promise<any[]> {
  if (!OPENSUBTITLES_API_KEY) {
    console.log('  ⚠️ No OpenSubtitles API key');
    return [];
  }

  try {
    const cleanImdbId = imdbId.replace('tt', '');
    const url = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${cleanImdbId}&languages=en`;
    
    const response = await fetch(url, {
      headers: {
        'Api-Key': OPENSUBTITLES_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0',
      },
    });

    if (!response.ok) {
      console.log(`  ⚠️ OpenSubtitles error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  } catch (error: any) {
    console.log(`  ⚠️ Search failed: ${error.message}`);
    return [];
  }
}

async function downloadSubtitle(fileId: number): Promise<string | null> {
  if (!OPENSUBTITLES_API_KEY) return null;

  try {
    // Request download link
    const response = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers: {
        'Api-Key': OPENSUBTITLES_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'MovieMVP/1.0',
      },
      body: JSON.stringify({ file_id: fileId }),
    });

    if (!response.ok) {
      console.log(`  ⚠️ Download request failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const downloadLink = data.link;

    if (!downloadLink) {
      console.log('  ⚠️ No download link returned');
      return null;
    }

    // Download the actual subtitle file
    const subtitleResponse = await fetch(downloadLink);
    if (!subtitleResponse.ok) {
      console.log('  ⚠️ Subtitle download failed');
      return null;
    }

    return await subtitleResponse.text();
  } catch (error: any) {
    console.log(`  ⚠️ Download error: ${error.message}`);
    return null;
  }
}

function parseSRT(srtContent: string): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  const blocks = srtContent.split(/\n\n+/);

  for (const block of blocks) {
    const parts = block.trim().split('\n');
    if (parts.length >= 3) {
      // Skip index, parse timestamp
      const timeLine = parts[1];
      const textLines = parts.slice(2).join(' ');
      
      // Clean up text
      const cleanText = textLines
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/\{[^}]*\}/g, '') // Remove formatting
        .replace(/♪.*♪/g, '') // Remove music notes
        .replace(/\[.*?\]/g, '') // Remove [descriptions]
        .trim();

      if (cleanText && cleanText.length > 10 && cleanText.length < 200) {
        // Parse timestamp
        const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})/);
        const startSeconds = timeMatch 
          ? parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3])
          : 0;

        lines.push({
          text: cleanText,
          start: startSeconds,
          end: startSeconds + 5,
        });
      }
    }
  }

  return lines;
}

function extractKeyDialogues(lines: SubtitleLine[], maxLines: number = 50): SubtitleLine[] {
  // Filter for meaningful dialogue (not too short, not sound effects)
  const meaningful = lines.filter(line => {
    const text = line.text.toLowerCase();
    // Skip sound effects, music, etc.
    if (text.startsWith('-') && text.length < 20) return false;
    if (text.includes('♪')) return false;
    if (/^\[.*\]$/.test(text)) return false;
    if (text.length < 15) return false;
    return true;
  });

  // Sample evenly throughout the movie
  if (meaningful.length <= maxLines) return meaningful;
  
  const step = Math.floor(meaningful.length / maxLines);
  const sampled: SubtitleLine[] = [];
  
  for (let i = 0; i < meaningful.length && sampled.length < maxLines; i += step) {
    sampled.push(meaningful[i]);
  }

  return sampled;
}

async function processMovie(movie: any): Promise<number> {
  console.log(`\n📽️  Processing: ${movie.title} (${movie.year})`);
  
  if (!movie.imdb_id) {
    console.log('  ⚠️ No IMDB ID, skipping');
    return 0;
  }

  // Check if we already have dialogues for this movie
  const { count } = await supabase
    .from('movie_dialogues')
    .select('*', { count: 'exact', head: true })
    .eq('movie_id', movie.id);

  if (count && count >= 10) {
    console.log(`  ✓ Already has ${count} dialogues, skipping`);
    return 0;
  }

  // Search for subtitles
  const subtitles = await searchSubtitlesForMovie(movie.imdb_id);
  await delay(500);

  if (subtitles.length === 0) {
    console.log('  ⚠️ No subtitles found');
    return 0;
  }

  // Find the best subtitle (highest download count)
  const bestSubtitle = subtitles.reduce((best: any, current: any) => {
    const currentDownloads = current.attributes?.download_count || 0;
    const bestDownloads = best?.attributes?.download_count || 0;
    return currentDownloads > bestDownloads ? current : best;
  }, subtitles[0]);

  const fileId = bestSubtitle?.attributes?.files?.[0]?.file_id;
  if (!fileId) {
    console.log('  ⚠️ No file ID found');
    return 0;
  }

  console.log(`  📥 Downloading subtitle (file_id: ${fileId})...`);
  const srtContent = await downloadSubtitle(fileId);
  await delay(1000);

  if (!srtContent) {
    console.log('  ⚠️ Download failed');
    return 0;
  }

  // Parse and extract key dialogues
  const allLines = parseSRT(srtContent);
  console.log(`  📝 Parsed ${allLines.length} subtitle lines`);

  const keyDialogues = extractKeyDialogues(allLines, 30);
  console.log(`  ✂️  Selected ${keyDialogues.length} key dialogues`);

  // Insert into database
  let inserted = 0;
  for (const dialogue of keyDialogues) {
    const { error } = await supabase.from('movie_dialogues').insert({
      movie_id: movie.id,
      text: dialogue.text,
      start_timestamp: dialogue.start,
      end_timestamp: dialogue.end,
      source: 'opensubtitles_bulk',
    });

    if (!error) inserted++;
  }

  console.log(`  ✅ Inserted ${inserted} dialogues`);
  return inserted;
}

async function main() {
  console.log('🎬 Starting bulk subtitle import...\n');

  // Get all movies with IMDB IDs
  const { data: movies, error } = await supabase
    .from('movies')
    .select('id, title, year, imdb_id')
    .not('imdb_id', 'is', null)
    .order('id');

  if (error) {
    console.error('Failed to fetch movies:', error.message);
    return;
  }

  console.log(`Found ${movies?.length || 0} movies with IMDB IDs\n`);

  let totalImported = 0;
  let processed = 0;

  for (const movie of movies || []) {
    try {
      const imported = await processMovie(movie);
      totalImported += imported;
      processed++;

      // Rate limiting
      if (processed % BATCH_SIZE === 0) {
        console.log(`\n⏳ Processed ${processed} movies, waiting ${DELAY_MS}ms...`);
        await delay(DELAY_MS);
      }
    } catch (error: any) {
      console.error(`  ❌ Error: ${error.message}`);
    }
  }

  console.log('\n========================================');
  console.log(`✅ Bulk import complete!`);
  console.log(`   Movies processed: ${processed}`);
  console.log(`   Total dialogues imported: ${totalImported}`);
  console.log('========================================\n');
}

main().catch(console.error);
