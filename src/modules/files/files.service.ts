import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { StorageService } from './storage.service';
import { logger } from '../../utils/logger';

@injectable()
export class FilesService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
        private storageService: StorageService,
    ) { }

    async uploadAttachment(
        cashbookId: string,
        entryId: string,
        userId: string,
        file: Express.Multer.File
    ) {
        // Verify entry belongs to cashbook
        const entry = await this.prisma.entry.findUnique({
            where: { id: entryId },
            include: { cashbook: true },
        });

        if (!entry || entry.cashbookId !== cashbookId || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        try {
            const { objectName, mimeType, fileSize } = await this.storageService.processAndUpload(file);

            const attachment = await this.prisma.attachment.create({
                data: {
                    entryId,
                    cashbookId,
                    uploadedById: userId,
                    fileName: file.originalname,
                    mimeType,
                    fileSize,
                    s3Key: objectName, // Field name kept for DB compatibility
                },
            });

            return attachment;
        } catch (error) {
            if (error instanceof AppError) throw error;
            logger.error('File upload failed', { error });
            throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
        }
    }

    async getAttachments(entryId: string) {
        return this.prisma.attachment.findMany({
            where: { entryId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Stream a file from MinIO. Returns the stream + metadata for piping to response.
     */
    async streamFile(attachmentId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        const stream = await this.storageService.getObject(attachment.s3Key);

        return {
            stream,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
        };
    }

    async deleteAttachment(attachmentId: string, userId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        try {
            await this.storageService.deleteObject(attachment.s3Key);
        } catch (error) {
            logger.error('MinIO deletion failed', { error, objectName: attachment.s3Key });
        }

        await this.prisma.attachment.delete({
            where: { id: attachmentId },
        });
    }
}
