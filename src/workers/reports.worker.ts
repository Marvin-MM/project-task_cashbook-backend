import { Worker, Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { Readable, PassThrough } from 'stream';
import { bullmqConnection, emailQueue } from '../config/queues';
import { getPrismaClient } from '../config/database';
import { logger } from '../utils/logger';

export interface ReportJobData {
    cashbookId: string;
    userId: string;
    recipientEmail: string;
    query: {
        startDate: string;
        endDate: string;
        type?: string;
        categoryId?: string;
        format?: string;
    };
}

// ─── Async Generator: Cursor-based Pagination ──────────
// Fetches entries in batches of 1000 using Prisma cursor pagination.
// Yields records one-by-one → O(1) memory usage.

type EntryWithRelations = Prisma.EntryGetPayload<{
    include: {
        category: { select: { name: true } };
        contact: { select: { name: true } };
        paymentMode: { select: { name: true } };
        createdBy: { select: { firstName: true; lastName: true } };
    };
}>;

async function* streamEntries(
    prisma: PrismaClient,
    cashbookId: string,
    where: Prisma.EntryWhereInput
): AsyncGenerator<EntryWithRelations> {
    const BATCH_SIZE = 1000;
    let cursor: string | undefined;

    while (true) {
        const batch: EntryWithRelations[] = await prisma.entry.findMany({
            where,
            take: BATCH_SIZE,
            ...(cursor
                ? { skip: 1, cursor: { id: cursor } }
                : {}
            ),
            orderBy: { entryDate: 'asc' },
            include: {
                category: { select: { name: true } },
                contact: { select: { name: true } },
                paymentMode: { select: { name: true } },
                createdBy: { select: { firstName: true, lastName: true } },
            },
        });

        if (batch.length === 0) break;

        for (const entry of batch) {
            yield entry;
        }

        cursor = batch[batch.length - 1].id;

        // If we got fewer than BATCH_SIZE, we've reached the end
        if (batch.length < BATCH_SIZE) break;
    }
}

// ─── PDF Generation (Streaming) ────────────────────────

function generateStreamingPDF(
    cashbookName: string,
    currency: string,
    period: { startDate: string; endDate: string },
): { doc: PDFKit.PDFDocument; output: PassThrough } {
    const doc = new PDFDocument({ margin: 50 });
    const output = new PassThrough();
    doc.pipe(output);

    // Header
    doc.fontSize(20).text(`${cashbookName} - Financial Report`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Period: ${period.startDate} to ${period.endDate}`, { align: 'center' });
    doc.text(`Currency: ${currency}`, { align: 'center' });
    doc.moveDown(2);

    // Table header
    doc.fontSize(14).text('Entries', { underline: true });
    doc.moveDown(0.5);

    const colWidths = [70, 55, 70, 200, 100];
    const headers = ['Date', 'Type', 'Amount', 'Description', 'Category'];

    doc.fontSize(8).font('Helvetica-Bold');
    let xPos = 50;
    headers.forEach((h, i) => {
        doc.text(h, xPos, doc.y, { width: colWidths[i], continued: i < headers.length - 1 });
        xPos += colWidths[i];
    });
    doc.text(''); // New line after headers
    doc.font('Helvetica');
    doc.moveDown(0.3);

    return { doc, output };
}

function addEntryToPDF(
    doc: PDFKit.PDFDocument,
    entry: EntryWithRelations,
    colWidths: number[]
) {
    if (doc.y > 700) {
        doc.addPage();
    }

    const yPos = doc.y;
    let xPos = 50;
    const row = [
        new Date(entry.entryDate).toLocaleDateString(),
        entry.type,
        entry.amount.toString(),
        (entry.description || '').substring(0, 50),
        entry.category?.name || '-',
    ];

    doc.fontSize(8);
    row.forEach((cell, i) => {
        doc.text(cell, xPos, yPos, { width: colWidths[i] });
        xPos += colWidths[i];
    });
}

function addSummaryToPDF(
    doc: PDFKit.PDFDocument,
    summary: { totalIncome: number; totalExpense: number; count: number }
) {
    doc.moveDown(2);
    doc.fontSize(14).text('Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text(`Total Income: ${summary.totalIncome.toFixed(2)}`);
    doc.text(`Total Expense: ${summary.totalExpense.toFixed(2)}`);
    doc.text(`Net: ${(summary.totalIncome - summary.totalExpense).toFixed(2)}`);
    doc.text(`Total Entries: ${summary.count}`);
}

// ─── Worker ────────────────────────────────────────────

export function createReportsWorker(): Worker<ReportJobData> {
    const worker = new Worker<ReportJobData>(
        'reports',
        async (job: Job<ReportJobData>) => {
            const { cashbookId, userId, recipientEmail, query } = job.data;
            const prisma = getPrismaClient();

            logger.info('Processing report job', { jobId: job.id, cashbookId, recipientEmail });

            // Get cashbook info
            const cashbook = await prisma.cashbook.findUnique({
                where: { id: cashbookId },
            });

            if (!cashbook || !cashbook.isActive) {
                throw new Error(`Cashbook ${cashbookId} not found or inactive`);
            }

            // Build where clause
            const where: Prisma.EntryWhereInput = {
                cashbookId,
                isDeleted: false,
                entryDate: {
                    gte: new Date(query.startDate),
                    lte: new Date(query.endDate),
                },
            };

            if (query.type) where.type = query.type as any;
            if (query.categoryId) where.categoryId = query.categoryId;

            // ── Stream entries → PDF ──
            const colWidths = [70, 55, 70, 200, 100];
            const { doc, output } = generateStreamingPDF(
                cashbook.name,
                cashbook.currency,
                { startDate: query.startDate, endDate: query.endDate }
            );

            let totalIncome = 0;
            let totalExpense = 0;
            let count = 0;

            // Stream entries and write to PDF one at a time
            for await (const entry of streamEntries(prisma, cashbookId, where)) {
                addEntryToPDF(doc, entry, colWidths);

                const amount = Number(entry.amount);
                if (entry.type === 'INCOME') {
                    totalIncome += amount;
                } else {
                    totalExpense += amount;
                }
                count++;

                // Report progress every 1000 entries
                if (count % 1000 === 0) {
                    await job.updateProgress({ entriesProcessed: count });
                }
            }

            // Add summary at the end
            addSummaryToPDF(doc, { totalIncome, totalExpense, count });

            // Finalize PDF
            doc.end();

            // Collect the PDF buffer from the stream
            const chunks: Buffer[] = [];
            for await (const chunk of output) {
                chunks.push(chunk as Buffer);
            }
            const pdfBuffer = Buffer.concat(chunks);

            // Log audit
            await prisma.auditLog.create({
                data: {
                    userId,
                    workspaceId: cashbook.workspaceId,
                    action: 'REPORT_GENERATED',
                    resource: 'report',
                    details: {
                        cashbookId,
                        format: 'pdf',
                        startDate: query.startDate,
                        endDate: query.endDate,
                        entriesCount: count,
                    } as any,
                },
            });

            // Push email job with PDF attachment
            await emailQueue.add('report-email', {
                to: recipientEmail,
                subject: `${cashbook.name} - Financial Report`,
                html: `
                    <h2>Your report is ready</h2>
                    <p>Please find attached the financial report for <strong>${cashbook.name}</strong>.</p>
                    <p>Period: ${query.startDate} to ${query.endDate}</p>
                    <p>Total Entries: ${count}</p>
                    <p>Summary: Income ${totalIncome.toFixed(2)} | Expense ${totalExpense.toFixed(2)} | Net ${(totalIncome - totalExpense).toFixed(2)}</p>
                `,
                attachments: [{
                    filename: `${cashbook.name}-report.pdf`,
                    content: pdfBuffer.toString('base64'),
                    contentType: 'application/pdf',
                }],
            });

            logger.info('Report generated and email queued', {
                jobId: job.id,
                cashbookId,
                entriesCount: count,
                pdfSizeBytes: pdfBuffer.length,
            });

            return { entriesCount: count, pdfSizeBytes: pdfBuffer.length };
        },
        {
            connection: bullmqConnection,
            concurrency: 2, // Limit concurrent report generation
        }
    );

    worker.on('failed', (job, err) => {
        logger.error('Report job failed', {
            jobId: job?.id,
            cashbookId: job?.data?.cashbookId,
            error: err.message,
        });
    });

    worker.on('completed', (job, result) => {
        logger.info('Report job completed', { jobId: job.id, result });
    });

    return worker;
}
