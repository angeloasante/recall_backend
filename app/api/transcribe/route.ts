import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}

export async function POST(request: NextRequest) {
  console.log('📥 Transcribe endpoint hit!');
  let tempFilePath: string | null = null;
  
  try {
    const contentType = request.headers.get('content-type') || '';
    console.log('📋 Content-Type:', contentType);
    
    let audioBuffer: Buffer;
    let extension = 'm4a';
    
    if (contentType.includes('application/json')) {
      // Handle base64 JSON upload from React Native
      console.log('📦 Receiving base64 JSON data...');
      const body = await request.json();
      
      if (!body.audio) {
        return NextResponse.json(
          { error: 'No audio data provided' },
          { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
        );
      }
      
      audioBuffer = Buffer.from(body.audio, 'base64');
      extension = body.filename?.split('.').pop() || 'm4a';
      
      console.log('🎤 Received base64 audio:', {
        size: audioBuffer.length,
        extension,
      });
    } else {
      // Handle FormData upload (original method)
      console.log('📦 Receiving FormData...');
      const formData = await request.formData();
      const audioFile = formData.get('audio') as File;

      if (!audioFile) {
        return NextResponse.json(
          { error: 'No audio file provided' },
          { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
        );
      }

      console.log('🎤 Received audio for transcription:', {
        name: audioFile.name,
        type: audioFile.type,
        size: audioFile.size,
      });

      const bytes = await audioFile.arrayBuffer();
      audioBuffer = Buffer.from(bytes);
      extension = audioFile.name.split('.').pop() || 'm4a';
    }
    
    // Create temp file with proper extension
    tempFilePath = join(tmpdir(), `whisper-${Date.now()}.${extension}`);
    await writeFile(tempFilePath, audioBuffer);

    console.log('💾 Temp file created:', tempFilePath);

    // Create a File object for OpenAI
    const file = await import('fs').then(fs => fs.createReadStream(tempFilePath!));

    console.log('🤖 Sending to OpenAI Whisper...');
    // Transcribe using Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
      language: 'en',
      response_format: 'json',
    });

    console.log('📝 Transcription result:', transcription.text);

    // Clean up temp file
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }

    return NextResponse.json({
      text: transcription.text,
      success: true,
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });

  } catch (error: any) {
    console.error('Transcription error:', error);
    
    // Clean up temp file on error
    if (tempFilePath) {
      await unlink(tempFilePath).catch(() => {});
    }

    return NextResponse.json(
      { error: error.message || 'Transcription failed' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
