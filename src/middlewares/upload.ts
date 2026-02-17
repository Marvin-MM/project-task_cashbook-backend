import multer from 'multer';
import { ValidationError } from '../core/errors/AppError';
import { logger } from '../utils/logger';

const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
];

/**
 * Magic number signatures for validating file types by content,
 * not just the client-supplied MIME type (which can be spoofed).
 */
const MAGIC_NUMBERS: { mime: string; bytes: number[] }[] = [
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF header
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
    // Office Open XML (docx, xlsx) — PK zip header
    {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: [0x50, 0x4b, 0x03, 0x04],
    },
    {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: [0x50, 0x4b, 0x03, 0x04],
    },
    // Legacy Office (.doc, .xls) — Compound File Binary Format
    { mime: 'application/msword', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
    { mime: 'application/vnd.ms-excel', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
    // CSV is plain text, no magic number — skip
];

function matchesMagicNumber(buffer: Buffer, mime: string): boolean {
    // CSV has no magic number, allow based on MIME only
    if (mime === 'text/csv') return true;

    const signatures = MAGIC_NUMBERS.filter((m) => m.mime === mime);
    if (signatures.length === 0) {
        // If we have no signature to check against, also check the generic PK/CFB
        // signatures for Office formats
        return true;
    }

    return signatures.some((sig) => {
        if (buffer.length < sig.bytes.length) return false;
        return sig.bytes.every((byte, i) => buffer[i] === byte);
    });
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const storage = multer.memoryStorage();

const fileFilter = (
    _req: Express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
): void => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(new ValidationError(
            `File type '${file.mimetype}' is not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        ));
        return;
    }
    cb(null, true);
};

export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE,
        files: 5,
    },
});

/**
 * Middleware to validate file content via magic numbers.
 * Must run AFTER multer has parsed the file into `req.file.buffer`.
 */
export function validateFileContent(
    req: any,
    _res: any,
    next: any
): void {
    if (!req.file) {
        next();
        return;
    }

    const { buffer, mimetype, originalname } = req.file;

    if (!matchesMagicNumber(buffer, mimetype)) {
        logger.warn('File magic number mismatch — potential spoofing', {
            originalname,
            claimedMime: mimetype,
        });
        next(new ValidationError(
            `File content does not match the declared type '${mimetype}'. The file may be corrupted or spoofed.`
        ));
        return;
    }

    next();
}
