import { S3Client } from '@aws-sdk/client-s3';
import { config } from './index';

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
    if (!s3Client) {
        s3Client = new S3Client({
            region: config.AWS_REGION,
            credentials: {
                accessKeyId: config.AWS_ACCESS_KEY_ID,
                secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
            },
        });
    }
    return s3Client;
}
