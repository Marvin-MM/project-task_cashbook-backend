import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { FilesService } from './files.service';
import { AuthenticatedRequest } from '../../core/types';
import { AppError } from '../../core/errors/AppError';

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

    /**
     * Proxy-stream a file from MinIO → response.
     * Sets Content-Type and Content-Disposition: inline.
     */
    async viewFile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const { stream, fileName, mimeType, fileSize } = await this.filesService.streamFile(
                req.params.attachmentId as string
            );

            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
            if (fileSize) {
                res.setHeader('Content-Length', fileSize);
            }

            stream.pipe(res);

            stream.on('error', (err) => {
                if (!res.headersSent) {
                    next(new AppError('Failed to stream file', 500, 'STREAM_ERROR'));
                }
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
