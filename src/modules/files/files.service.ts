import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest } from '../../core/types';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { getPrismaClient } from '../../config/database';
import { getS3Client } from '../../config/s3';
import { config } from '../../config';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';

const prisma = getPrismaClient();

export class FilesService {
    async uploadAttachment(
        cashbookId: string,
        entryId: string,
        userId: string,
        file: Express.Multer.File
    ) {
        // Verify entry belongs to cashbook
        const entry = await prisma.entry.findUnique({
            where: { id: entryId },
            include: { cashbook: true },
        });

        if (!entry || entry.cashbookId !== cashbookId || entry.isDeleted) {
            throw new NotFoundError('Entry');
        }

        const fileKey = `attachments/${cashbookId}/${entryId}/${uuidv4()}-${file.originalname}`;

        try {
            const s3 = getS3Client();
            await s3.send(
                new PutObjectCommand({
                    Bucket: config.S3_BUCKET_NAME,
                    Key: fileKey,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                    ServerSideEncryption: 'AES256',
                })
            );
        } catch (error) {
            logger.error('S3 upload failed', { error });
            throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
        }

        const attachment = await prisma.attachment.create({
            data: {
                entryId,
                cashbookId,
                uploadedById: userId,
                fileName: file.originalname,
                mimeType: file.mimetype,
                fileSize: file.size,
                s3Key: fileKey,
            },
        });

        return attachment;
    }

    async getAttachments(entryId: string) {
        return prisma.attachment.findMany({
            where: { entryId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getDownloadUrl(attachmentId: string) {
        const attachment = await prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        const s3 = getS3Client();
        const url = await getSignedUrl(
            s3,
            new GetObjectCommand({
                Bucket: config.S3_BUCKET_NAME,
                Key: attachment.s3Key,
            }),
            { expiresIn: 3600 }
        );

        return { url, fileName: attachment.fileName, fileType: attachment.mimeType };
    }

    async deleteAttachment(attachmentId: string, userId: string) {
        const attachment = await prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        try {
            const s3 = getS3Client();
            await s3.send(
                new DeleteObjectCommand({
                    Bucket: config.S3_BUCKET_NAME,
                    Key: attachment.s3Key,
                })
            );
        } catch (error) {
            logger.error('S3 deletion failed', { error });
        }

        await prisma.attachment.delete({
            where: { id: attachmentId },
        });
    }
}

// Controller
const filesService = new FilesService();

export class FilesController {
    async upload(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.file) {
                throw new AppError('No file provided', 400, 'NO_FILE');
            }

            const attachment = await filesService.uploadAttachment(
                req.params.cashbookId as string,
                req.params.entryId as string,
                req.user.userId,
                req.file
            );

            res.status(StatusCodes.CREATED).json({
                success: true,
                message: 'File uploaded successfully',
                data: attachment,
            });
        } catch (error) {
            next(error);
        }
    }

    async getAll(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const attachments = await filesService.getAttachments(req.params.entryId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Attachments retrieved',
                data: attachments,
            });
        } catch (error) {
            next(error);
        }
    }

    async download(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await filesService.getDownloadUrl(req.params.attachmentId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Download URL generated',
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }

    async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            await filesService.deleteAttachment(req.params.attachmentId as string, req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Attachment deleted',
            });
        } catch (error) {
            next(error);
        }
    }
}
