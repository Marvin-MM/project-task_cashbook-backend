import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AuthenticatedRequest, AuditAction } from '../../core/types';
import { NotFoundError } from '../../core/errors/AppError';
import { ReportQueryDto } from './reports.dto';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { logger } from '../../utils/logger';
import { dbBreaker } from '../../config/breakers';

@injectable()
export class ReportsService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async generateReport(cashbookId: string, userId: string, query: ReportQueryDto) {
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
        });

        if (!cashbook || !cashbook.isActive) {
            throw new NotFoundError('Cashbook');
        }

        const where: any = {
            cashbookId,
            isDeleted: false,
            entryDate: {
                gte: new Date(query.startDate),
                lte: new Date(query.endDate),
            },
        };

        if (query.type) where.type = query.type;
        if (query.categoryId) where.categoryId = query.categoryId;

        const entries = await dbBreaker.execute(() =>
            this.prisma.entry.findMany({
                where,
                include: {
                    category: { select: { name: true } },
                    contact: { select: { name: true } },
                    paymentMode: { select: { name: true } },
                    createdBy: { select: { firstName: true, lastName: true } },
                },
                orderBy: { entryDate: 'asc' },
            })
        );

        // Calculate summary
        let totalIncome = 0;
        let totalExpense = 0;

        for (const entry of entries) {
            const amount = Number(entry.amount);
            if (entry.type === 'INCOME') {
                totalIncome += amount;
            } else {
                totalExpense += amount;
            }
        }

        const net = totalIncome - totalExpense;

        // Log report generation
        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId: cashbook.workspaceId,
                action: AuditAction.REPORT_GENERATED,
                resource: 'report',
                details: {
                    cashbookId,
                    format: query.format,
                    startDate: query.startDate,
                    endDate: query.endDate,
                    entriesCount: entries.length,
                } as any,
            },
        });

        return {
            cashbook: { id: cashbook.id, name: cashbook.name, currency: cashbook.currency },
            period: { startDate: query.startDate, endDate: query.endDate },
            summary: {
                totalIncome: totalIncome.toString(),
                totalExpense: totalExpense.toString(),
                net: net.toString(),
                entriesCount: entries.length,
            },
            entries: entries.map((e: any) => ({
                id: e.id,
                type: e.type,
                amount: e.amount.toString(),
                description: e.description,
                category: e.category?.name || null,
                contact: e.contact?.name || null,
                paymentMode: e.paymentMode?.name || null,
                entryDate: e.entryDate.toISOString(),
                createdBy: e.createdBy ? `${e.createdBy.firstName} ${e.createdBy.lastName}` : null,
            })),
        };
    }

    async generatePDF(data: any): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 50 });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Header
            doc.fontSize(20).text(`${data.cashbook.name} - Financial Report`, { align: 'center' });
            doc.moveDown();
            doc.fontSize(10).text(`Period: ${data.period.startDate} to ${data.period.endDate}`, { align: 'center' });
            doc.text(`Currency: ${data.cashbook.currency}`, { align: 'center' });
            doc.moveDown(2);

            // Summary
            doc.fontSize(14).text('Summary', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(10);
            doc.text(`Total Income: ${data.summary.totalIncome}`);
            doc.text(`Total Expense: ${data.summary.totalExpense}`);
            doc.text(`Net: ${data.summary.net}`);
            doc.text(`Total Entries: ${data.summary.entriesCount}`);
            doc.moveDown(2);

            // Entries table
            doc.fontSize(14).text('Entries', { underline: true });
            doc.moveDown(0.5);

            // Table header
            const tableTop = doc.y;
            const colWidths = [70, 55, 70, 200, 100];
            const headers = ['Date', 'Type', 'Amount', 'Description', 'Category'];

            doc.fontSize(8).font('Helvetica-Bold');
            let xPos = 50;
            headers.forEach((h, i) => {
                doc.text(h, xPos, tableTop, { width: colWidths[i] });
                xPos += colWidths[i];
            });

            doc.font('Helvetica');
            let yPos = tableTop + 15;

            for (const entry of data.entries) {
                if (yPos > 700) {
                    doc.addPage();
                    yPos = 50;
                }

                xPos = 50;
                const row = [
                    new Date(entry.entryDate).toLocaleDateString(),
                    entry.type,
                    entry.amount,
                    entry.description.substring(0, 50),
                    entry.category || '-',
                ];

                row.forEach((cell, i) => {
                    doc.text(cell, xPos, yPos, { width: colWidths[i] });
                    xPos += colWidths[i];
                });

                yPos += 15;
            }

            doc.end();
        });
    }

    async generateExcel(data: any): Promise<Buffer> {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Report');

        // Summary section
        sheet.addRow([data.cashbook.name, 'Financial Report']).font = { bold: true, size: 14 };
        sheet.addRow([`Period: ${data.period.startDate} to ${data.period.endDate}`]);
        sheet.addRow([`Currency: ${data.cashbook.currency}`]);
        sheet.addRow([]);
        sheet.addRow(['Total Income', data.summary.totalIncome]).font = { bold: true };
        sheet.addRow(['Total Expense', data.summary.totalExpense]).font = { bold: true };
        sheet.addRow(['Net', data.summary.net]).font = { bold: true };
        sheet.addRow([]);

        // Entries header
        const headerRow = sheet.addRow(['Date', 'Type', 'Amount', 'Description', 'Category', 'Contact', 'Payment Mode', 'Created By']);
        headerRow.font = { bold: true };
        headerRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        });

        // Entries data
        for (const entry of data.entries) {
            sheet.addRow([
                new Date(entry.entryDate).toLocaleDateString(),
                entry.type,
                parseFloat(entry.amount),
                entry.description,
                entry.category || '-',
                entry.contact || '-',
                entry.paymentMode || '-',
                entry.createdBy || '-',
            ]);
        }

        // Auto-fit columns
        sheet.columns.forEach((col) => {
            col.width = 18;
        });

        return Buffer.from(await workbook.xlsx.writeBuffer());
    }
}

// Controller
@injectable()
export class ReportsController {
    constructor(private reportsService: ReportsService) { }

    async generate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.reportsService.generateReport(
                req.params.cashbookId as string,
                req.user.userId,
                req.query as any
            );

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Report data generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async download(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.reportsService.generateReport(
                req.params.cashbookId as string,
                req.user.userId,
                req.query as any
            );

            const format = (req.query.format as string) || 'pdf';

            if (format === 'pdf') {
                const pdfBuffer = await this.reportsService.generatePDF(data);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${data.cashbook.name}-report.pdf"`);
                res.send(pdfBuffer);
            } else {
                const excelBuffer = await this.reportsService.generateExcel(data);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${data.cashbook.name}-report.xlsx"`);
                res.send(excelBuffer);
            }
        } catch (error) {
            next(error);
        }
    }
}
