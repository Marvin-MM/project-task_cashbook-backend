import { S3Client } from '@aws-sdk/client-s3';
import { config } from './index';

export const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: config.CF_R2_ACCESS_KEY_ID,
        secretAccessKey: config.CF_R2_SECRET_ACCESS_KEY,
    },
    // R2 requires setting this for compatibility
    forcePathStyle: true,
});
