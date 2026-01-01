import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME!;

// Upload file to R2
export async function uploadToR2(
  buffer: Buffer,
  key: string,
  contentType: string = 'application/octet-stream'
): Promise<string> {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// Upload video
export async function uploadVideo(buffer: Buffer, filename: string): Promise<string> {
  const key = `videos/${Date.now()}-${filename}`;
  return uploadToR2(buffer, key, 'video/mp4');
}

// Upload image/frame
export async function uploadFrame(buffer: Buffer, movieId: string, index: number): Promise<string> {
  const key = `frames/${movieId}/frame_${index}.jpg`;
  return uploadToR2(buffer, key, 'image/jpeg');
}

// Get signed URL for temporary access
export async function getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(r2Client, command, { expiresIn });
}
