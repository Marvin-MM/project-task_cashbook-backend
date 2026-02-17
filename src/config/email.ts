import nodemailer, { Transporter } from 'nodemailer';
import { config } from './index';
import { logger } from '../utils/logger';
import { emailQueue } from './queues';

let transporter: Transporter | null = null;

export function getEmailTransporter(): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_SECURE,
            auth: {
                user: config.SMTP_USER,
                pass: config.SMTP_PASS,
            },
        });
    }
    return transporter;
}

export interface EmailOptions {
    to: string;
    subject: string;
    html: string;
    attachments?: Array<{
        filename: string;
        content: Buffer;
        contentType: string;
    }>;
}

/**
 * Send email via BullMQ queue (non-blocking).
 * The email will be processed by the email worker with retry logic.
 */
export async function sendEmail(options: EmailOptions): Promise<void> {
    try {
        await emailQueue.add('send-email', {
            to: options.to,
            subject: options.subject,
            html: options.html,
            attachments: options.attachments?.map((att) => ({
                filename: att.filename,
                content: att.content.toString('base64'),
                contentType: att.contentType,
            })),
        });

        logger.info('Email queued successfully', { to: options.to, subject: options.subject });
    } catch (error) {
        logger.error('Failed to queue email', {
            to: options.to,
            subject: options.subject,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

/**
 * Send email directly (synchronous, bypasses the queue).
 * Used in critical paths where we need immediate delivery confirmation.
 */
export async function sendEmailDirect(options: EmailOptions): Promise<void> {
    try {
        const transport = getEmailTransporter();
        await transport.sendMail({
            from: `"${config.EMAIL_FROM_NAME}" <${config.EMAIL_FROM}>`,
            to: options.to,
            subject: options.subject,
            html: options.html,
            attachments: options.attachments,
        });
        logger.info('Email sent directly', { to: options.to, subject: options.subject });
    } catch (error) {
        logger.error('Failed to send email directly', {
            to: options.to,
            subject: options.subject,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
