import { injectable } from 'tsyringe';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getMinioClient } from '../../config/minio';
import { config } from '../../config';
import { minioBreaker } from '../../config/breakers';
import { AppError } from '../../core/errors/AppError';
import { logger } from '../../utils/logger';

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
]);

const PDF_MIME = 'application/pdf';

@injectable()
export class StorageService {
    /**
     * Validate, compress, and upload a file to MinIO.
     * Images → WebP (Sharp). PDFs → Ghostscript compression.
     * Returns the stored object name (filename in bucket).
     */
    async processAndUpload(file: Express.Multer.File): Promise<{
        objectName: string;
        mimeType: string;
        fileSize: number;
    }> {
        // ── Validation ──
        if (file.size > MAX_FILE_SIZE) {
            throw new AppError(
                `File exceeds the ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
                400,
                'FILE_TOO_LARGE'
            );
        }

        // Verify magic numbers using file-type
        const { fileTypeFromBuffer } = await import('file-type');
        const detected = await fileTypeFromBuffer(file.buffer);

        // CSV / plain text won't have a detectable type — allow if MIME matches
        if (detected) {
            const allowedMagic = [...IMAGE_MIMES, PDF_MIME];
            if (
                !allowedMagic.includes(detected.mime) &&
                !['application/msword', 'application/zip'].includes(detected.mime)
            ) {
                throw new AppError(
                    `File content does not match an allowed type. Detected: ${detected.mime}`,
                    400,
                    'INVALID_FILE_TYPE'
                );
            }
        }

        // ── Route by type ──
        if (IMAGE_MIMES.has(file.mimetype)) {
            return this.processImage(file);
        } else if (file.mimetype === PDF_MIME) {
            return this.processPDF(file);
        } else {
            // Other allowed types (docs, xlsx, csv) — upload as-is
            return this.uploadRaw(file);
        }
    }

    /**
     * Image pipeline: resize to max 1920px wide → convert to WebP (quality 80).
     */
    private async processImage(file: Express.Multer.File): Promise<{
        objectName: string;
        mimeType: string;
        fileSize: number;
    }> {
        const objectName = `attachments/${uuidv4()}.webp`;

        const buffer = await sharp(file.buffer)
            .resize({ width: 1920, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

        const client = getMinioClient();
        await minioBreaker.execute(() =>
            client.putObject(config.MINIO_BUCKET, objectName, buffer, buffer.length, {
                'Content-Type': 'image/webp',
            })
        );

        logger.debug('Image processed and uploaded', {
            original: file.originalname,
            originalSize: file.size,
            compressedSize: buffer.length,
            objectName,
        });

        return { objectName, mimeType: 'image/webp', fileSize: buffer.length };
    }

    /**
     * PDF pipeline: compress via Ghostscript (gs).
     * Uses unique temp filenames to avoid collisions with concurrent uploads.
     */
    private async processPDF(file: Express.Multer.File): Promise<{
        objectName: string;
        mimeType: string;
        fileSize: number;
    }> {
        const uuid = uuidv4();
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${uuid}-input.pdf`);
        const outputPath = path.join(tmpDir, `${uuid}-output.pdf`);
        const objectName = `attachments/${uuid}.pdf`;

        try {
            // Write input to temp
            await fs.writeFile(inputPath, file.buffer);

            // Compress with Ghostscript
            await execFileAsync('gs', [
                '-sDEVICE=pdfwrite',
                '-dCompatibilityLevel=1.4',
                '-dPDFSETTINGS=/ebook',
                '-dNOPAUSE',
                '-dQUIET',
                '-dBATCH',
                `-sOutputFile=${outputPath}`,
                inputPath,
            ]);

            // Upload compressed file directly from disk
            const client = getMinioClient();
            await minioBreaker.execute(() =>
                client.fPutObject(config.MINIO_BUCKET, objectName, outputPath, {
                    'Content-Type': 'application/pdf',
                })
            );

            const stat = await fs.stat(outputPath);

            logger.debug('PDF compressed and uploaded', {
                original: file.originalname,
                originalSize: file.size,
                compressedSize: stat.size,
                objectName,
            });

            return { objectName, mimeType: 'application/pdf', fileSize: stat.size };
        } catch (error) {
            // If Ghostscript fails, upload the original PDF
            logger.warn('Ghostscript compression failed, uploading original PDF', { error });

            const client = getMinioClient();
            await minioBreaker.execute(() =>
                client.putObject(config.MINIO_BUCKET, objectName, file.buffer, file.size, {
                    'Content-Type': 'application/pdf',
                })
            );

            return { objectName, mimeType: 'application/pdf', fileSize: file.size };
        } finally {
            // Always clean up temp files
            await fs.unlink(inputPath).catch(() => { });
            await fs.unlink(outputPath).catch(() => { });
        }
    }

    /**
     * Upload other file types (docs, xlsx, csv) as-is.
     */
    private async uploadRaw(file: Express.Multer.File): Promise<{
        objectName: string;
        mimeType: string;
        fileSize: number;
    }> {
        const ext = path.extname(file.originalname) || '';
        const objectName = `attachments/${uuidv4()}${ext}`;

        const client = getMinioClient();
        await minioBreaker.execute(() =>
            client.putObject(config.MINIO_BUCKET, objectName, file.buffer, file.size, {
                'Content-Type': file.mimetype,
            })
        );

        return { objectName, mimeType: file.mimetype, fileSize: file.size };
    }

    /**
     * Stream a file from MinIO. Returns a Readable stream.
     */
    async getObject(objectName: string): Promise<Readable> {
        const client = getMinioClient();
        return minioBreaker.execute(() =>
            client.getObject(config.MINIO_BUCKET, objectName)
        );
    }

    /**
     * Get object metadata (size, content-type, etc).
     */
    async statObject(objectName: string) {
        const client = getMinioClient();
        return minioBreaker.execute(() =>
            client.statObject(config.MINIO_BUCKET, objectName)
        );
    }

    /**
     * Delete an object from MinIO.
     */
    async deleteObject(objectName: string): Promise<void> {
        const client = getMinioClient();
        await minioBreaker.execute(() =>
            client.removeObject(config.MINIO_BUCKET, objectName)
        );
    }

    /**
     * List all objects with a given prefix (for cleanup jobs).
     */
    listObjects(prefix: string): AsyncIterable<string> {
        const client = getMinioClient();
        const stream = client.listObjects(config.MINIO_BUCKET, prefix, true);

        return {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        return new Promise((resolve, reject) => {
                            stream.once('data', (item) => {
                                if (item.name) {
                                    resolve({ value: item.name, done: false });
                                } else {
                                    resolve({ value: undefined as any, done: true });
                                }
                            });
                            stream.once('end', () => resolve({ value: undefined as any, done: true }));
                            stream.once('error', reject);
                        });
                    },
                };
            },
        };
    }
}
