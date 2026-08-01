/**
 * Chart of accounts, manual journals and period close.
 *
 * The accountant's surface. Non-accountant users never see any of this — the
 * Accounts page continues to show only wallets, and the entry form is unchanged.
 */
import { injectable, inject } from 'tsyringe';
import {
    FiscalPeriodStatus,
    JournalSourceType,
    LedgerAccountClass,
    LedgerAccountOrigin,
    PrismaClient,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AppError, ConflictError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { withFinancialTransaction } from '../../core/db/transaction';
import { PostingService } from '../../core/ledger/posting.service';
import { normalBalanceFor } from '../../core/ledger/coa.template';
import { ensureWorkspaceChartOfAccounts } from '../../core/ledger/coa.seed';
import { assertPeriodOpen, resolveReversalDate } from '../../core/ledger/period';
import type {
    CreateLedgerAccountDto,
    UpdateLedgerAccountDto,
    ManualJournalDto,
    ClosePeriodDto,
} from './chart-of-accounts.dto';

@injectable()
export class ChartOfAccountsService {
    constructor(
        @inject('PrismaClient') private prisma: PrismaClient,
        private postingService: PostingService,
    ) { }

    // ─── Chart of accounts ────────────────────────────────

    /** The full tree, with balances, for the accountant's CoA screen. */
    async list(workspaceId: string, options: { includeArchived?: boolean } = {}) {
        // Self-heal workspaces that predate the ledger, so the screen is never
        // empty just because the workspace was created before this existed.
        const count = await this.prisma.ledgerAccount.count({ where: { workspaceId } });
        if (count === 0) {
            const workspace = await this.prisma.workspace.findUnique({
                where: { id: workspaceId },
                select: { defaultCurrency: true },
            });
            if (workspace) {
                await this.prisma.$transaction((tx) =>
                    ensureWorkspaceChartOfAccounts(tx, workspaceId, workspace.defaultCurrency),
                );
            }
        }

        const accounts = await this.prisma.ledgerAccount.findMany({
            where: {
                workspaceId,
                ...(options.includeArchived ? {} : { archivedAt: null }),
            },
            orderBy: { code: 'asc' },
            select: {
                id: true, code: true, name: true, class: true, normalBalance: true,
                origin: true, systemKey: true, parentId: true, currency: true,
                isCashEquivalent: true, isPostable: true, isProtected: true,
                isActive: true, archivedAt: true,
                _count: { select: { lines: true, categories: true } },
            },
        });

        const balances = await this.prisma.$queryRaw<
            Array<{ ledger_account_id: string; net: Decimal }>
        >`
            SELECT ledger_account_id, COALESCE(SUM(debit - credit), 0) AS net
            FROM journal_lines
            WHERE workspace_id = ${workspaceId}::uuid
            GROUP BY ledger_account_id
        `;
        const balanceOf = new Map(balances.map((b) => [b.ledger_account_id, new Decimal(b.net)]));

        return accounts.map((a) => {
            const net = balanceOf.get(a.id) ?? new Decimal(0);
            return {
                ...a,
                lineCount: a._count.lines,
                mappedCategoryCount: a._count.categories,
                // Presentation sign: positive means "more of what this is".
                balance: (a.normalBalance === 'DEBIT' ? net : net.negated()).toFixed(4),
            };
        });
    }

    async create(workspaceId: string, userId: string, dto: CreateLedgerAccountDto) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { defaultCurrency: true },
        });
        if (!workspace) throw new NotFoundError('Workspace');

        const duplicate = await this.prisma.ledgerAccount.findUnique({
            where: { workspaceId_code: { workspaceId, code: dto.code } },
            select: { id: true },
        });
        if (duplicate) {
            throw new ConflictError(`An account with code "${dto.code}" already exists`);
        }

        if (dto.parentId) {
            const parent = await this.prisma.ledgerAccount.findFirst({
                where: { id: dto.parentId, workspaceId },
                select: { class: true },
            });
            if (!parent) throw new NotFoundError('Parent account');
            // A child that reports under a different section would make the
            // balance sheet incoherent.
            if (parent.class !== dto.class) {
                throw new AppError(
                    `Parent account is ${parent.class}; a ${dto.class} account cannot sit under it.`,
                    400,
                    'COA_CLASS_MISMATCH',
                );
            }
        }

        const account = await this.prisma.ledgerAccount.create({
            data: {
                workspaceId,
                code: dto.code,
                name: dto.name,
                class: dto.class as LedgerAccountClass,
                normalBalance: normalBalanceFor(dto.class as LedgerAccountClass),
                origin: LedgerAccountOrigin.USER,
                parentId: dto.parentId ?? null,
                currency: workspace.defaultCurrency,
                isCashEquivalent: dto.isCashEquivalent ?? false,
                isPostable: dto.isPostable ?? true,
                isProtected: false,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.ACCOUNT_CREATED,
                resource: 'ledger_account',
                resourceId: account.id,
                details: { code: account.code, name: account.name, class: account.class } as never,
            },
        });

        return account;
    }

    async update(id: string, workspaceId: string, userId: string, dto: UpdateLedgerAccountDto) {
        const account = await this.prisma.ledgerAccount.findFirst({
            where: { id, workspaceId },
        });
        if (!account) throw new NotFoundError('Ledger account');

        // System accounts are referenced by systemKey from the posting rules;
        // renaming is fine, re-coding or re-classing is not.
        if (account.isProtected) {
            if (dto.code && dto.code !== account.code) {
                throw new AppError(
                    'System accounts cannot be re-coded. Rename it instead.',
                    400,
                    'COA_PROTECTED',
                );
            }
            if (dto.class && dto.class !== account.class) {
                throw new AppError(
                    'System accounts cannot change classification.',
                    400,
                    'COA_PROTECTED',
                );
            }
        }

        // Reclassifying an account that already carries postings would silently
        // rewrite history across every past report.
        if (dto.class && dto.class !== account.class) {
            const lines = await this.prisma.journalLine.count({ where: { ledgerAccountId: id } });
            if (lines > 0) {
                throw new AppError(
                    `This account has ${lines} posting(s); changing its classification would ` +
                    'restate every report that includes them. Create a new account and reverse ' +
                    'the postings instead.',
                    400,
                    'COA_HAS_POSTINGS',
                );
            }
        }

        const updated = await this.prisma.ledgerAccount.update({
            where: { id },
            data: {
                ...(dto.name !== undefined ? { name: dto.name } : {}),
                ...(dto.code !== undefined ? { code: dto.code } : {}),
                ...(dto.class !== undefined
                    ? {
                        class: dto.class as LedgerAccountClass,
                        normalBalance: normalBalanceFor(dto.class as LedgerAccountClass),
                    }
                    : {}),
                ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
                ...(dto.isCashEquivalent !== undefined
                    ? { isCashEquivalent: dto.isCashEquivalent }
                    : {}),
                ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.ACCOUNT_UPDATED,
                resource: 'ledger_account',
                resourceId: id,
                details: { before: { code: account.code, name: account.name }, changes: dto } as never,
            },
        });

        return updated;
    }

    /**
     * Archive rather than delete. An account with postings can never be removed
     * without destroying the journals that reference it.
     */
    async archive(id: string, workspaceId: string, userId: string) {
        const account = await this.prisma.ledgerAccount.findFirst({
            where: { id, workspaceId },
            select: { id: true, code: true, name: true, isProtected: true },
        });
        if (!account) throw new NotFoundError('Ledger account');

        if (account.isProtected) {
            throw new AppError(
                'System accounts cannot be archived; the posting rules depend on them.',
                400,
                'COA_PROTECTED',
            );
        }

        const [lineCount, mappedCategories] = await Promise.all([
            this.prisma.journalLine.count({ where: { ledgerAccountId: id } }),
            this.prisma.category.count({ where: { glAccountId: id } }),
        ]);

        if (mappedCategories > 0) {
            throw new AppError(
                `${mappedCategories} category/categories still post to this account. ` +
                'Remap them first.',
                400,
                'COA_IN_USE',
            );
        }

        const archived = await this.prisma.ledgerAccount.update({
            where: { id },
            data: { archivedAt: new Date(), isActive: false },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.ACCOUNT_ARCHIVED,
                resource: 'ledger_account',
                resourceId: id,
                details: { code: account.code, name: account.name, lineCount } as never,
            },
        });

        return archived;
    }

    /** Map a category onto an income/expense account. Optional by design. */
    async mapCategory(
        workspaceId: string,
        categoryId: string,
        ledgerAccountId: string | null,
        userId: string,
    ) {
        const category = await this.prisma.category.findFirst({
            where: { id: categoryId, workspaceId },
        });
        if (!category) throw new NotFoundError('Category');

        if (ledgerAccountId) {
            const account = await this.prisma.ledgerAccount.findFirst({
                where: { id: ledgerAccountId, workspaceId },
                select: { class: true, isPostable: true },
            });
            if (!account) throw new NotFoundError('Ledger account');
            if (!account.isPostable) {
                throw new AppError(
                    'Cannot map a category to a roll-up parent account.',
                    400,
                    'COA_NOT_POSTABLE',
                );
            }
            if (account.class !== 'INCOME' && account.class !== 'EXPENSE') {
                throw new AppError(
                    'Categories may only map to income or expense accounts.',
                    400,
                    'COA_CLASS_MISMATCH',
                );
            }
        }

        const updated = await this.prisma.category.update({
            where: { id: categoryId },
            data: { glAccountId: ledgerAccountId },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.CATEGORY_UPDATED,
                resource: 'category',
                resourceId: categoryId,
                details: { glAccountId: ledgerAccountId } as never,
            },
        });

        return updated;
    }

    // ─── Manual journals ──────────────────────────────────

    /**
     * Post an arbitrary balanced journal.
     *
     * The escape hatch for everything the app's workflows do not model:
     * accruals, depreciation, owner drawings, corrections. It goes through the
     * same PostingService as every other event, so it is subject to the same
     * balance checks, the same append-only ledger, and the same reversal path.
     */
    async postManualJournal(workspaceId: string, userId: string, dto: ManualJournalDto) {
        const workspace = await this.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: { defaultCurrency: true },
        });
        if (!workspace) throw new NotFoundError('Workspace');

        const entryDate = new Date(dto.entryDate);

        const totalDebit = dto.lines.reduce((s, l) => s.add(l.debit ?? 0), new Decimal(0));
        const totalCredit = dto.lines.reduce((s, l) => s.add(l.credit ?? 0), new Decimal(0));
        if (!totalDebit.equals(totalCredit)) {
            throw new AppError(
                `Journal does not balance: debits ${totalDebit.toString()} ≠ credits ${totalCredit.toString()}`,
                400,
                'LEDGER_UNBALANCED',
            );
        }

        const accountIds = [...new Set(dto.lines.map((l) => l.ledgerAccountId))];
        const accounts = await this.prisma.ledgerAccount.findMany({
            where: { id: { in: accountIds }, workspaceId },
            select: { id: true, isPostable: true, archivedAt: true, name: true },
        });
        if (accounts.length !== accountIds.length) {
            throw new AppError(
                'One or more accounts do not belong to this workspace.',
                400,
                'COA_INVALID_ACCOUNT',
            );
        }
        for (const account of accounts) {
            if (!account.isPostable || account.archivedAt) {
                throw new AppError(
                    `Account "${account.name}" cannot be posted to.`,
                    400,
                    'COA_NOT_POSTABLE',
                );
            }
        }

        return withFinancialTransaction(this.prisma, async (tx) => {
            await assertPeriodOpen(tx, workspaceId, entryDate);

            const posted = await this.postingService.post(tx, {
                workspaceId,
                cashbookId: dto.cashbookId ?? null,
                currency: workspace.defaultCurrency,
                entryDate,
                description: dto.description,
                sourceType: JournalSourceType.MANUAL,
                sourceId: null,
                // Caller-supplied reference makes retries idempotent; otherwise a
                // timestamped key, which is unique per post.
                postingKey: dto.reference
                    ? `manual:${dto.reference}`
                    : `manual:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
                createdById: userId,
                legs: dto.lines.map((l) => ({
                    ref: { kind: 'EXPLICIT', ledgerAccountId: l.ledgerAccountId },
                    debit: l.debit ? new Decimal(l.debit) : undefined,
                    credit: l.credit ? new Decimal(l.credit) : undefined,
                    memo: l.memo ?? dto.description,
                    dims: {
                        contactId: l.contactId ?? null,
                        categoryId: l.categoryId ?? null,
                    },
                })),
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.REPORT_GENERATED,
                    resource: 'manual_journal',
                    resourceId: posted.id,
                    details: {
                        description: dto.description,
                        totalDebit: totalDebit.toString(),
                        lineCount: dto.lines.length,
                    } as never,
                },
            });

            return posted;
        });
    }

    /** Reverse any journal. The only way to undo a manual posting. */
    async reverseJournal(
        workspaceId: string,
        journalEntryId: string,
        userId: string,
        reason: string,
    ) {
        const journal = await this.prisma.journalEntry.findFirst({
            where: { id: journalEntryId, workspaceId },
            select: { postingKey: true, status: true, entryDate: true },
        });
        if (!journal) throw new NotFoundError('Journal entry');
        if (journal.status === 'REVERSED') {
            throw new ConflictError('This journal has already been reversed');
        }
        if (journal.status === 'REVERSING') {
            throw new AppError(
                'A reversing journal cannot itself be reversed. Post a fresh journal instead.',
                400,
                'LEDGER_REVERSAL_OF_REVERSAL',
            );
        }

        return withFinancialTransaction(this.prisma, async (tx) => {
            const reversalDate = await resolveReversalDate(tx, workspaceId, journal.entryDate);

            const reversal = await this.postingService.reverse(tx, {
                workspaceId,
                originalPostingKey: journal.postingKey,
                reason,
                createdById: userId,
                reversalDate,
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.ENTRY_DELETED,
                    resource: 'journal_entry',
                    resourceId: journalEntryId,
                    details: { reason, reversalDate } as never,
                },
            });

            return reversal;
        });
    }

    /** List journals for the accountant's drill-down. */
    async listJournals(
        workspaceId: string,
        params: { page: number; limit: number; sourceType?: string; from?: Date; to?: Date },
    ) {
        const skip = (params.page - 1) * params.limit;
        const where = {
            workspaceId,
            ...(params.sourceType ? { sourceType: params.sourceType as JournalSourceType } : {}),
            ...(params.from || params.to
                ? {
                    entryDate: {
                        ...(params.from ? { gte: params.from } : {}),
                        ...(params.to ? { lte: params.to } : {}),
                    },
                }
                : {}),
        };

        const [total, data] = await Promise.all([
            this.prisma.journalEntry.count({ where }),
            this.prisma.journalEntry.findMany({
                where,
                include: {
                    lines: {
                        orderBy: { lineNumber: 'asc' },
                        include: {
                            ledgerAccount: { select: { id: true, code: true, name: true, class: true } },
                        },
                    },
                    createdBy: { select: { id: true, firstName: true, lastName: true } },
                    cashbook: { select: { id: true, name: true } },
                },
                orderBy: { seq: 'desc' },
                skip,
                take: params.limit,
            }),
        ]);

        return { data, total, page: params.page, limit: params.limit };
    }

    // ─── Fiscal periods ───────────────────────────────────

    async listPeriods(workspaceId: string) {
        return this.prisma.fiscalPeriod.findMany({
            where: { workspaceId },
            orderBy: { startDate: 'desc' },
        });
    }

    /**
     * Close a period so nothing can be posted into it.
     *
     * This is what makes "the books are final" true rather than aspirational.
     * Reversals of a closed period post at the current date instead — see
     * resolveReversalDate.
     */
    async closePeriod(workspaceId: string, userId: string, dto: ClosePeriodDto) {
        const startDate = new Date(dto.startDate);
        const endDate = new Date(dto.endDate);

        if (endDate < startDate) {
            throw new AppError('endDate must be on or after startDate', 400, 'INVALID_PERIOD');
        }

        const overlapping = await this.prisma.fiscalPeriod.findFirst({
            where: {
                workspaceId,
                status: FiscalPeriodStatus.CLOSED,
                startDate: { lte: endDate },
                endDate: { gte: startDate },
            },
        });
        if (overlapping) {
            throw new ConflictError(
                `This range overlaps a period already closed (${overlapping.startDate.toISOString().slice(0, 10)} – ${overlapping.endDate.toISOString().slice(0, 10)})`,
            );
        }

        const period = await this.prisma.fiscalPeriod.upsert({
            where: { workspaceId_startDate: { workspaceId, startDate } },
            update: {
                endDate,
                status: FiscalPeriodStatus.CLOSED,
                closedById: userId,
                closedAt: new Date(),
                note: dto.note ?? null,
            },
            create: {
                workspaceId,
                startDate,
                endDate,
                status: FiscalPeriodStatus.CLOSED,
                closedById: userId,
                closedAt: new Date(),
                note: dto.note ?? null,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_UPDATED,
                resource: 'fiscal_period',
                resourceId: period.id,
                details: { startDate, endDate, status: 'CLOSED' } as never,
            },
        });

        return period;
    }

    async reopenPeriod(workspaceId: string, periodId: string, userId: string, reason: string) {
        const period = await this.prisma.fiscalPeriod.findFirst({
            where: { id: periodId, workspaceId },
        });
        if (!period) throw new NotFoundError('Fiscal period');

        const reopened = await this.prisma.fiscalPeriod.update({
            where: { id: periodId },
            data: {
                status: FiscalPeriodStatus.OPEN,
                closedById: null,
                closedAt: null,
                note: reason,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                userId,
                workspaceId,
                action: AuditAction.WORKSPACE_UPDATED,
                resource: 'fiscal_period',
                resourceId: periodId,
                details: { status: 'OPEN', reason } as never,
            },
        });

        return reopened;
    }

}
