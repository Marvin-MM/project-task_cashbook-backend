import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest } from '../../core/types';
import { NotFoundError, AppError } from '../../core/errors/AppError';
import { getS3Client } from '../../config/s3';
import { config } from '../../config';
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import { s3Breaker } from '../../config/breakers';

@injectable()
export class FilesService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
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

        const fileKey = `attachments/${cashbookId}/${entryId}/${uuidv4()}-${file.originalname}`;

        try {
            const s3 = getS3Client();
            await s3Breaker.execute(() =>
                s3.send(
                    new PutObjectCommand({
                        Bucket: config.S3_BUCKET_NAME,
                        Key: fileKey,
                        Body: file.buffer,
                        ContentType: file.mimetype,
                        ServerSideEncryption: 'AES256',
                    })
                )
            );
        } catch (error) {
            logger.error('S3 upload failed', { error });
            throw new AppError('File upload failed', 500, 'UPLOAD_FAILED');
        }

        const attachment = await this.prisma.attachment.create({
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
        return this.prisma.attachment.findMany({
            where: { entryId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getDownloadUrl(attachmentId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        const s3 = getS3Client();
        const url = await s3Breaker.execute(() =>
            getSignedUrl(
                s3,
                new GetObjectCommand({
                    Bucket: config.S3_BUCKET_NAME,
                    Key: attachment.s3Key,
                }),
                { expiresIn: 3600 }
            )
        );

        return { url, fileName: attachment.fileName, fileType: attachment.mimeType };
    }

    async deleteAttachment(attachmentId: string, userId: string) {
        const attachment = await this.prisma.attachment.findUnique({
            where: { id: attachmentId },
        });

        if (!attachment) {
            throw new NotFoundError('Attachment');
        }

        try {
            const s3 = getS3Client();
            await s3Breaker.execute(() =>
                s3.send(
                    new DeleteObjectCommand({
                        Bucket: config.S3_BUCKET_NAME,
                        Key: attachment.s3Key,
                    })
                )
            );
        } catch (error) {
            logger.error('S3 deletion failed (circuit breaker)', { error });
        }

        await this.prisma.attachment.delete({
            where: { id: attachmentId },
        });
    }
}

// Controller
@injectable()
export class FilesController {
    constructor(private filesService: FilesService) { }

    async upload(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            if (!req.file) {
                throw new AppError('No file provided', 400, 'NO_FILE');
            }

            const attachment = await this.filesService.uploadAttachment(
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
            const attachments = await this.filesService.getAttachments(req.params.entryId as string);
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
            const result = await this.filesService.getDownloadUrl(req.params.attachmentId as string);
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
            await this.filesService.deleteAttachment(req.params.attachmentId as string, req.user.userId);
            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Attachment deleted',
            });
        } catch (error) {
            next(error);
        }
    }
}
