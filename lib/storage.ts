import { supabaseAdmin } from './supabase';

const BUCKET_NAME = 'uploads';
const FILE_SIZE_LIMIT = 1073741824; // 1GB (increased from 500MB)

// Initialize bucket (run once)
export async function initStorageBucket() {
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  
  const bucketExists = buckets?.some(b => b.name === BUCKET_NAME);
  
  if (!bucketExists) {
    await supabaseAdmin.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: FILE_SIZE_LIMIT,
      allowedMimeTypes: ['video/*', 'image/*'],
    });
    console.log(`✓ Created storage bucket: ${BUCKET_NAME}`);
  } else {
    // Update existing bucket's file size limit
    await supabaseAdmin.storage.updateBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: FILE_SIZE_LIMIT,
      allowedMimeTypes: ['video/*', 'image/*'],
    });
    console.log(`✓ Updated storage bucket: ${BUCKET_NAME} (limit: ${FILE_SIZE_LIMIT / 1024 / 1024}MB)`);
  }
}

// Upload video to Supabase Storage
export async function uploadVideo(buffer: Buffer, filename: string): Promise<string> {
  const key = `videos/${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(key, buffer, {
      contentType: 'video/mp4',
      upsert: false,
    });

  if (error) {
    console.error('Upload error:', error);
    throw new Error(`Failed to upload video: ${error.message}`);
  }

  // Get public URL
  const { data: urlData } = supabaseAdmin.storage
    .from(BUCKET_NAME)
    .getPublicUrl(key);

  return urlData.publicUrl;
}

// Upload image/frame to Supabase Storage
export async function uploadFrame(buffer: Buffer, movieId: string, index: number): Promise<string> {
  const key = `frames/${movieId}/frame_${index}.jpg`;
  
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(key, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload frame: ${error.message}`);
  }

  const { data: urlData } = supabaseAdmin.storage
    .from(BUCKET_NAME)
    .getPublicUrl(key);

  return urlData.publicUrl;
}

// Delete a file from storage
export async function deleteFile(path: string): Promise<void> {
  await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .remove([path]);
}

// Get signed URL for private access (if bucket is private)
export async function getSignedUrl(path: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .createSignedUrl(path, expiresIn);

  if (error) {
    throw new Error(`Failed to create signed URL: ${error.message}`);
  }

  return data.signedUrl;
}
