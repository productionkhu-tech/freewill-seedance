// One-off verification: isR2Url / extractR2Key behavior on real presigned URLs +
// DeleteObject success against a key we just uploaded. Run after the smoke server
// has uploaded test_r2_smoke. Removes the test object so R2 stays tidy.
const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;

if (!R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error('R2 env vars missing'); process.exit(1);
}

const r2 = new S3Client({
  region: 'auto', endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});

const r2Hostname = new URL(R2_ENDPOINT).hostname;
function isR2Url(url) { try { return new URL(url).hostname === r2Hostname; } catch { return false; } }
function extractR2Key(url) {
  try {
    const u = new URL(url);
    const prefix = `/${R2_BUCKET}/`;
    if (u.pathname.startsWith(prefix)) return decodeURIComponent(u.pathname.slice(prefix.length));
    return null;
  } catch { return null; }
}

const cases = [
  // Real presigned URL we just received from /api/upload-public
  'https://545d611ede4df5505cb90242ce97be78.r2.cloudflarestorage.com/seedance2-260514/test_r2_smoke-c1ae284a-1779072410251.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256',
  // Must NOT match — protect tmpfiles / BytePlus / asset://
  'https://tmpfiles.org/dl/abc/file.mp4',
  'https://ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com/foo.mp4',
  'asset://character/00001',
  'data:image/png;base64,iVBORw0KGgo=',
];

console.log('=== URL classification ===');
for (const u of cases) {
  console.log(`isR2=${isR2Url(u)} key=${extractR2Key(u)} ← ${u.substring(0, 70)}${u.length > 70 ? '…' : ''}`);
}

(async () => {
  const key = 'test_r2_smoke-c1ae284a-1779072410251.mp4';
  console.log(`\n=== DeleteObject ${key} ===`);
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    console.log('  delete OK');
  } catch (e) {
    console.error('  delete failed:', e.message);
  }
  // Verify it's actually gone
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    console.error('  ✗ object still exists (Head succeeded)');
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey') {
      console.log('  ✓ HeadObject 404 — object truly gone');
    } else {
      console.warn('  Head error (treat as ok):', e.name, e.message);
    }
  }
})();
