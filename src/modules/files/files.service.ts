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
        // Verify entry belongs to cashbook and isn't deleted
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
                    s3Key: objectName,
                },
            });

            return attachment;
        } catch (error) {
            if (error instanceof AppError) throw error;
            
            logger.error('File upload failed', { error });
            throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
        }
    }

    /**
     * Attach a file to a task, a task report, or an expense claim.
     *
     * Separate entry point from the cashbook path above because the ownership
     * check is different in kind — there is no entry to verify, and the caller
     * has already been authorized against the owning record. What this adds is
     * the guarantee that the row it writes satisfies attachments_exactly_one_owner.
     */
    async uploadOwnedAttachment(
        owner: { taskId: string } | { taskReportId: string } | { expenseClaimId: string },
        userId: string,
        file: Express.Multer.File,
    ) {
        try {
            const { objectName, mimeType, fileSize } = await this.storageService.processAndUpload(file);

            return await this.prisma.attachment.create({
                data: {
                    ...owner,
                    uploadedById: userId,
                    fileName: file.originalname,
                    mimeType,
                    fileSize,
                    s3Key: objectName,
                },
            });
        } catch (error) {
            if (error instanceof AppError) throw error;
            logger.error('File upload failed', { error, owner });
            throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
        }
    }

    /** Files on one owner, newest first. */
    async listOwnedAttachments(
        owner: { taskId: string } | { taskReportId: string } | { expenseClaimId: string },
    ) {
        return this.prisma.attachment.findMany({
            where: { ...owner, isDeleted: false },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                fileName: true,
                fileSize: true,
                mimeType: true,
                createdAt: true,
                uploadedById: true,
            },
        });
    }

    async getAttachments(entryId: string) {
        return this.prisma.attachment.findMany({
            where: { 
                entryId,
                isDeleted: false // Ensure we don't fetch soft-deleted attachments
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Generates a 15-minute Presigned URL for direct secure access from MinIO.
     */
    async getPresignedUrl(attachmentId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment || attachment.isDeleted) {
            throw new NotFoundError('Attachment');
        }

        // We will add generatePresignedUrl to the StorageService next.
        // 900 seconds = 15 minutes.
        const url = await this.storageService.generatePresignedUrl(attachment.s3Key, 900);

        return {
            url,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
        };
    }

    /**
     * Soft-deletes the attachment to maintain financial audit trails.
     * The actual file remains safely in MinIO.
     */
    async deleteAttachment(attachmentId: string, userId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment || attachment.isDeleted) {
            throw new NotFoundError('Attachment');
        }

        // Soft delete the record in the database
        await this.prisma.attachment.update({
            where: { id: attachmentId },
            data: {
                isDeleted: true,
                deletedAt: new Date(),
                // Optionally track who deleted it if you add a deletedById field to your schema
            },
        });
        
        logger.info('Attachment soft-deleted', { attachmentId, userId, objectName: attachment.s3Key });
    }
}