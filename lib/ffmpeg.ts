import ffmpeg from 'fluent-ffmpeg';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

// Try to find FFmpeg path dynamically to avoid Next.js bundling issues
function getFFmpegPath(): string {
  // Try common locations
  const possiblePaths = [
    '/opt/homebrew/bin/ffmpeg', // Homebrew on Apple Silicon
    '/usr/local/bin/ffmpeg',    // Homebrew on Intel Mac
    '/usr/bin/ffmpeg',          // Linux
  ];
  
  for (const path of possiblePaths) {
    try {
      execSync(`${path} -version`, { stdio: 'ignore' });
      return path;
    } catch {
      continue;
    }
  }
  
  // Try system PATH
  try {
    const path = execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch {
    // Fall through
  }
  
  throw new Error('FFmpeg not found. Please install FFmpeg: brew install ffmpeg');
}

// Set FFmpeg path
try {
  const ffmpegPath = getFFmpegPath();
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('✓ FFmpeg found at:', ffmpegPath);
} catch (error) {
  console.error('❌ FFmpeg setup error:', error);
}

// Extract audio from video
export async function extractAudio(videoBuffer: Buffer): Promise<Buffer> {
  const tempDir = join(tmpdir(), 'movie-mvp');
  await mkdir(tempDir, { recursive: true });
  
  const uniqueId = randomUUID();
  const inputPath = join(tempDir, `audio-input-${uniqueId}.mp4`);
  const outputPath = join(tempDir, `audio-output-${uniqueId}.wav`);

  await writeFile(inputPath, videoBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .output(outputPath)
      .on('end', async () => {
        try {
          const audioBuffer = await readFile(outputPath);
          // Cleanup temp files
          await unlink(inputPath).catch(() => {});
          await unlink(outputPath).catch(() => {});
          resolve(audioBuffer);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', async (error) => {
        await unlink(inputPath).catch(() => {});
        reject(error);
      })
      .run();
  });
}

// Extract frames from video
// Extracts frames evenly distributed across the entire video duration
export async function extractFrames(
  videoBuffer: Buffer,
  count: number = 10  // Default to 10 frames for better coverage
): Promise<Buffer[]> {
  const tempDir = join(tmpdir(), 'movie-mvp');
  await mkdir(tempDir, { recursive: true });
  
  const uniqueId = randomUUID();
  const inputPath = join(tempDir, `frames-input-${uniqueId}.mp4`);
  await writeFile(inputPath, videoBuffer);

  // Get video duration
  const duration = await getVideoDuration(inputPath);
  console.log(`    📹 Video duration: ${duration.toFixed(1)}s, extracting ${count} frames`);
  
  // Calculate timestamps for evenly spaced frames across ENTIRE video
  // Skip first 5% and last 5% to avoid black frames/credits
  const startOffset = duration * 0.05;
  const endOffset = duration * 0.95;
  const usableDuration = endOffset - startOffset;
  
  const timestamps = Array.from({ length: count }, (_, i) =>
    startOffset + (usableDuration / (count + 1)) * (i + 1)
  );

  const frames: Buffer[] = [];

  for (const timestamp of timestamps) {
    const frame = await extractFrameAtTime(inputPath, timestamp);
    frames.push(frame);
  }

  // Cleanup
  await unlink(inputPath).catch(() => {});

  return frames;
}

// Get video duration in seconds
function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 10);
    });
  });
}

// Extract a single frame at a specific timestamp
// Using high quality settings for better actor recognition
function extractFrameAtTime(videoPath: string, timestamp: number): Promise<Buffer> {
  const outputPath = join(tmpdir(), 'movie-mvp', `frame-${randomUUID()}.jpg`);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      // High quality output for better face recognition
      .outputOptions([
        '-q:v', '2',           // High quality JPEG (1-31, lower is better)
        '-vf', 'scale=1920:-1:flags=lanczos', // Scale to 1920px width, maintain aspect ratio
      ])
      .output(outputPath)
      .on('end', async () => {
        try {
          const buffer = await readFile(outputPath);
          await unlink(outputPath).catch(() => {});
          console.log(`    📷 Frame extracted: ${Math.round(buffer.length / 1024)}KB`);
          resolve(buffer);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', reject)
      .run();
  });
}
