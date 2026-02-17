import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ReportsService } from './reports.service';
import { AuthenticatedRequest } from '../../core/types';

@injectable()
export class ReportsController {
    constructor(private reportsService: ReportsService) { }

    /**
     * Synchronous report data generation.
     */
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

    /**
     * Synchronous report download (PDF/Excel).
     */
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

    /**
     * Queue an async report job. Returns immediately with job ID.
     */
    async queueReport(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.reportsService.queueReport(
                req.params.cashbookId as string,
                req.user.userId,
                req.user.email,
                req.query as any
            );

            res.status(StatusCodes.ACCEPTED).json({
                success: true,
                message: 'Report generation queued. You will receive an email when ready.',
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Check the status of a queued report job.
     */
    async jobStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await this.reportsService.getJobStatus(req.params.jobId as string);

            res.status(StatusCodes.OK).json({
                success: true,
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }
}
