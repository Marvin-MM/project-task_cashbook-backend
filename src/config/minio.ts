import * as Minio from 'minio';
import { config } from './index';
import { logger } from '../utils/logger';

let minioClient: Minio.Client | null = null;

export function getMinioClient(): Minio.Client {
    if (!minioClient) {
        minioClient = new Minio.Client({
            endPoint: config.MINIO_ENDPOINT,
            port: config.MINIO_PORT,
            useSSL: config.MINIO_USE_SSL,
            accessKey: config.MINIO_ACCESS_KEY,
            secretKey: config.MINIO_SECRET_KEY,
        });
    }
    return minioClient;
}

/**
 * Ensure the configured bucket exists. Call once at startup.
 */
export async function ensureBucket(): Promise<void> {
    const client = getMinioClient();
    const exists = await client.bucketExists(config.MINIO_BUCKET);
    if (!exists) {
        await client.makeBucket(config.MINIO_BUCKET);
        logger.info(`✅ MinIO bucket "${config.MINIO_BUCKET}" created`);
    } else {
        logger.info(`✅ MinIO bucket "${config.MINIO_BUCKET}" already exists`);
    }
}
