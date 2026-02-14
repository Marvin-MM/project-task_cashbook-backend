import nodemailer, { Transporter } from 'nodemailer';
import { config } from './index';
import { logger } from '../utils/logger';

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

export async function sendEmail(options: EmailOptions): Promise<void> {
    try {
        const transport = getEmailTransporter();
        await transport.sendMail({
            from: `"${config.EMAIL_FROM_NAME}" <${config.EMAIL_FROM}>`,
            to: options.to,
            subject: options.subject,
            html: options.html,
            attachments: options.attachments,
        });
        logger.info('Email sent successfully', { to: options.to, subject: options.subject });
    } catch (error) {
        logger.error('Failed to send email', {
            to: options.to,
            subject: options.subject,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
