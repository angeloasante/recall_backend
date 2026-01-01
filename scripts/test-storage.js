const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  console.log('Testing Supabase Storage...\n');
  
  // List buckets
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  console.log('Existing buckets:', buckets?.map(b => b.name) || []);
  if (listError) console.log('List error:', listError);
  
  // Try to create bucket if not exists
  const uploadsBucket = buckets?.find(b => b.name === 'uploads');
  if (!uploadsBucket) {
    console.log('\nCreating "uploads" bucket...');
    const { error: createError } = await supabase.storage.createBucket('uploads', {
      public: true,
      fileSizeLimit: 104857600, // 100MB
      allowedMimeTypes: ['video/*', 'image/*', 'text/*'],
    });
    if (createError) {
      console.log('Create bucket error:', createError);
    } else {
      console.log('✓ Bucket created successfully');
    }
  } else {
    console.log('✓ "uploads" bucket exists');
  }
  
  // Try a test upload
  console.log('\nTesting upload...');
  const testBuffer = Buffer.from('test video content');
  const { data, error } = await supabase.storage
    .from('uploads')
    .upload('test/test-' + Date.now() + '.txt', testBuffer, { upsert: true });
  
  if (error) {
    console.log('Upload error:', error);
  } else {
    console.log('✓ Upload successful:', data.path);
    
    // Get public URL
    const { data: urlData } = supabase.storage.from('uploads').getPublicUrl(data.path);
    console.log('Public URL:', urlData?.publicUrl);
  }
}

test().catch(console.error);
