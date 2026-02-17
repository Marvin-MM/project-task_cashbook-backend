import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { getMinioClient } from '../config/minio';
import { config } from '../config';
import { minioBreaker } from '../config/breakers';

/**
 * MinIO Cleanup Job — removes orphaned attachments.
 *
 * An attachment is "orphaned" when the DB row has been deleted but
 * the MinIO object still exists (e.g. because delete failed at the time).
 * This job is designed to run as a periodic cron task.
 */
@injectable()
export class MinioCleanupJob {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    /**
     * Find and delete MinIO objects that have no corresponding Attachment row.
     * Processes in batches to avoid memory pressure.
     */
    async run(): Promise<{ deleted: number; errors: number }> {
        let deleted = 0;
        let errors = 0;

        const client = getMinioClient();
        const prefix = 'attachments/';

        try {
            const objectsStream = client.listObjects(config.MINIO_BUCKET, prefix, true);
            const batch: string[] = [];
            const BATCH_SIZE = 100;

            for await (const item of objectsStream) {
                if (item.name) {
                    batch.push(item.name);
                }

                if (batch.length >= BATCH_SIZE) {
                    const result = await this.cleanupBatch(batch);
                    deleted += result.deleted;
                    errors += result.errors;
                    batch.length = 0;
                }
            }

            // Process remaining items
            if (batch.length > 0) {
                const result = await this.cleanupBatch(batch);
                deleted += result.deleted;
                errors += result.errors;
            }
        } catch (err) {
            logger.error('MinIO cleanup: failed to list objects', { err });
            errors++;
        }

        logger.info('MinIO cleanup complete', { deleted, errors });
        return { deleted, errors };
    }

    private async cleanupBatch(keys: string[]): Promise<{ deleted: number; errors: number }> {
        let deleted = 0;
        let errors = 0;

        // Check which keys still have a DB row
        const existing = await this.prisma.attachment.findMany({
            where: { s3Key: { in: keys } },
            select: { s3Key: true },
        });

        const existingSet = new Set(existing.map((a) => a.s3Key));
        const orphaned = keys.filter((k) => !existingSet.has(k));

        if (orphaned.length === 0) return { deleted: 0, errors: 0 };

        // Delete orphaned objects one by one
        for (const objectName of orphaned) {
            try {
                const client = getMinioClient();
                await minioBreaker.execute(() =>
                    client.removeObject(config.MINIO_BUCKET, objectName)
                );
                deleted++;
            } catch (err) {
                errors++;
                logger.error('MinIO cleanup: failed to delete object', { objectName, err });
            }
        }

        logger.info(`MinIO cleanup: deleted ${deleted} orphaned objects`);
        return { deleted, errors };
    }
}
