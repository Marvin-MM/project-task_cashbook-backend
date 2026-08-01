import { injectable } from 'tsyringe';
import { Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { LedgerReportsService } from './ledger-reports.service';
import { LedgerIntegrityService } from '../../core/ledger/integrity.service';
import { AuthenticatedRequest } from '../../core/types';
import { AuditAction } from '../../core/types';
import { getPrismaClient } from '../../config/database';

/** Reports are as-of "now" unless the caller says otherwise. */
const dateOr = (value: unknown, fallback: Date): Date =>
    typeof value === 'string' ? new Date(value) : fallback;

/** 1 January of the given date's year — the default fiscal year start. */
const januaryFirst = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

@injectable()
export class LedgerReportsController {
    constructor(
        private service: LedgerReportsService,
        private integrity: LedgerIntegrityService,
    ) { }

    /** Financial reports are sensitive; record who ran what. */
    private async audit(req: AuthenticatedRequest, reportType: string, params: unknown) {
        try {
            await getPrismaClient().auditLog.create({
                data: {
                    userId: req.user.userId,
                    workspaceId: req.params.workspaceId as string,
                    action: AuditAction.REPORT_GENERATED,
                    resource: 'ledger_report',
                    resourceId: null,
                    details: { reportType, params } as never,
                    ipAddress: req.ip ?? null,
                    userAgent: req.get('user-agent') ?? null,
                },
            });
        } catch {
            // Never fail a read because its audit row could not be written.
        }
    }

    async balanceSheet(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const asOf = dateOr(req.query.asOf, new Date());
            const fiscalYearStart = dateOr(req.query.fiscalYearStart, januaryFirst(asOf));

            const data = await this.service.balanceSheet(workspaceId, asOf, fiscalYearStart);
            await this.audit(req, 'BALANCE_SHEET', { asOf, fiscalYearStart });

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Balance sheet generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async incomeStatement(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const period = {
                from: new Date(req.query.from as string),
                to: new Date(req.query.to as string),
            };
            const cashbookId = (req.query.cashbookId as string | undefined) ?? null;

            const data = await this.service.incomeStatement(workspaceId, period, cashbookId);
            await this.audit(req, 'INCOME_STATEMENT', { ...period, cashbookId });

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Income statement generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async trialBalance(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const asOf = dateOr(req.query.asOf, new Date());
            const includeZeroBalances = req.query.includeZeroBalances === 'true';

            const data = await this.service.trialBalance(workspaceId, asOf, includeZeroBalances);
            await this.audit(req, 'TRIAL_BALANCE', { asOf });

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Trial balance generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async generalLedger(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const data = await this.service.generalLedger(
                workspaceId,
                req.query.ledgerAccountId as string,
                { from: new Date(req.query.from as string), to: new Date(req.query.to as string) },
            );
            await this.audit(req, 'GENERAL_LEDGER', { ledgerAccountId: req.query.ledgerAccountId });

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'General ledger generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async cashFlow(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const period = {
                from: new Date(req.query.from as string),
                to: new Date(req.query.to as string),
            };

            const data = await this.service.cashFlow(workspaceId, period);
            await this.audit(req, 'CASH_FLOW', period);

            res.status(StatusCodes.OK).json({
                success: true,
                message: 'Cash flow statement generated',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    async aging(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const type = (req.query.type as 'RECEIVABLE' | 'PAYABLE') ?? 'RECEIVABLE';
            const asOf = dateOr(req.query.asOf, new Date());

            const data = await this.service.aging(workspaceId, type, asOf);
            await this.audit(req, 'AGING', { type, asOf });

            res.status(StatusCodes.OK).json({
                success: true,
                message: `${type === 'RECEIVABLE' ? 'Receivables' : 'Payables'} aging generated`,
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * On-demand integrity check. Answers "do the books balance?" with a specific
     * account and difference rather than a yes/no.
     */
    async integrityCheck(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await this.integrity.verifyWorkspace(req.params.workspaceId as string);
            res.status(StatusCodes.OK).json({
                success: true,
                message: data.ok ? 'Ledger is consistent' : 'Ledger inconsistencies detected',
                data,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Rebuild the cached balances from the ledger.
     *
     * Separate from the check because it writes, and because it deliberately
     * refuses the cases it cannot honestly fix — a non-zero trial balance is
     * not a caching problem and "repairing" the cache to agree with a wrong
     * ledger would hide a real accounting error.
     */
    async repairBalances(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
        try {
            const workspaceId = req.params.workspaceId as string;
            const result = await this.integrity.repairCachedBalances(workspaceId);

            await getPrismaClient().auditLog.create({
                data: {
                    userId: req.user.userId,
                    workspaceId,
                    action: AuditAction.LEDGER_BALANCES_REPAIRED,
                    resource: 'workspace',
                    resourceId: workspaceId,
                    details: {
                        repaired: result.repaired.map((finding) => ({
                            check: finding.check,
                            subject: finding.subject,
                            from: finding.actual,
                            to: finding.expected,
                        })),
                        remaining: result.remaining.length,
                    } as any,
                },
            });

            res.status(StatusCodes.OK).json({
                success: true,
                message: result.repaired.length === 0
                    ? 'Nothing needed recalculating'
                    : `Recalculated ${result.repaired.length} balance(s) from the ledger`,
                data: result,
            });
        } catch (error) {
            next(error);
        }
    }
}
