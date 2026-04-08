import multer from 'multer';
import { AppError } from '../core/errors/AppError';

// 10 MB limit for logos
const LOGO_SIZE_LIMIT = 10 * 1024 * 1024;

const storage = multer.memoryStorage();

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    // Only accept image formats that sharp can reasonably convert to PNG
    const allowedImageMimes = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/bmp',
        'image/tiff',
        'image/svg+xml' // We can rasterize SVG if needed, but safe to allow
    ];

    if (allowedImageMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new AppError(`File type ${file.mimetype} is not supported. Please upload a valid image.`, 400, 'UNSUPPORTED_FILE_TYPE'));
    }
};

export const uploadImageMemory = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: LOGO_SIZE_LIMIT,
        files: 1
    }
});
