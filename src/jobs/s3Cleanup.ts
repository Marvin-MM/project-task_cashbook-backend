import { injectable, inject } from 'tsyringe';
import { PrismaClient, WorkspaceRole } from '@prisma/client';
import { logger } from '../utils/logger';
import { getS3Client } from '../config/s3';
import { config } from '../config';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { s3Breaker } from '../config/breakers';

/**
 * S3 Cleanup Job — removes orphaned attachments.
 *
 * An attachment is "orphaned" when the DB row has been deleted but
 * the S3 object still exists (e.g. because S3 delete failed at the time).
 * This job is designed to run as a periodic cron task.
 */
@injectable()
export class S3CleanupJob {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    /**
     * Find and delete S3 objects that have no corresponding Attachment row.
     * Processes in batches to avoid memory pressure.
     */
    async run(): Promise<{ deleted: number; errors: number }> {
        let deleted = 0;
        let errors = 0;
        let continuationToken: string | undefined;

        const s3 = getS3Client();
        const prefix = 'attachments/';

        do {
            try {
                const listResult = await s3Breaker.execute(() =>
                    s3.send(
                        new ListObjectsV2Command({
                            Bucket: config.S3_BUCKET_NAME,
                            Prefix: prefix,
                            MaxKeys: 100,
                            ContinuationToken: continuationToken,
                        })
                    )
                );

                const objects = listResult.Contents ?? [];
                continuationToken = listResult.NextContinuationToken;

                if (objects.length === 0) continue;

                const keys: string[] = objects
                    .map((o: { Key?: string }) => o.Key)
                    .filter((k): k is string => !!k);

                // Check which keys still have a DB row
                const existing = await this.prisma.attachment.findMany({
                    where: { s3Key: { in: keys } },
                    select: { s3Key: true },
                });

                const existingSet = new Set(existing.map((a) => a.s3Key));
                const orphaned = keys.filter((k: string) => !existingSet.has(k));

                if (orphaned.length === 0) continue;

                // Delete orphaned objects
                try {
                    await s3Breaker.execute(() =>
                        s3.send(
                            new DeleteObjectsCommand({
                                Bucket: config.S3_BUCKET_NAME,
                                Delete: {
                                    Objects: orphaned.map((Key: string) => ({ Key })),
                                    Quiet: true,
                                },
                            })
                        )
                    );
                    deleted += orphaned.length;
                    logger.info(`S3 cleanup: deleted ${orphaned.length} orphaned objects`);
                } catch (err) {
                    errors += orphaned.length;
                    logger.error('S3 cleanup: failed to delete batch', { err });
                }
            } catch (err) {
                logger.error('S3 cleanup: failed to list objects', { err });
                errors++;
                break;
            }
        } while (continuationToken);

        logger.info(`S3 cleanup complete`, { deleted, errors });
        return { deleted, errors };
    }
}
