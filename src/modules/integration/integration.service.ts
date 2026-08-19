import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { EntriesService } from '../entries/entries.service';
import { NotFoundError } from '../../core/errors/AppError';
import { IntegrateEntryDto, IntegrateBatchDto } from './integration.dto';
import { logger } from '../../utils/logger';

@injectable()
export class IntegrationService {
    constructor(
        private entriesService: EntriesService,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) {}

    /** Post one entry with durable API-key provenance and idempotency. */
    async submitEntry(
        cashbookId: string,
        _workspaceId: string,
        apiKeyId: string,
        createdById: string,
        dto: IntegrateEntryDto,
    ) {
        if (dto.externalRef) {
            const existing = await this.findByExternalRef(cashbookId, apiKeyId, dto.externalRef);
            if (existing) return { entry: existing, idempotent: true };
        }

        try {
            const entry = await this.entriesService.createEntry(cashbookId, createdById, {
                type: dto.type,
                amount: dto.amount,
                chargeAmount: dto.chargeAmount,
                description: dto.description,
                entryDate: dto.entryDate ?? new Date().toISOString(),
                categoryId: dto.categoryId,
                contactId: dto.contactId,
                paymentModeId: dto.paymentModeId,
                integrationApiKeyId: apiKeyId,
                externalRef: dto.externalRef,
            });
            return { entry, idempotent: false };
        } catch (error: any) {
            // The unique index, rather than this initial lookup, is the
            // concurrency boundary for simultaneous retries.
            if (dto.externalRef && error?.code === 'P2002') {
                const existing = await this.findByExternalRef(cashbookId, apiKeyId, dto.externalRef);
                if (existing) return { entry: existing, idempotent: true };
            }
            throw error;
        }
    }

    /** Best-effort batch: every result is reported and posted independently. */
    async submitBatch(
        cashbookId: string,
        workspaceId: string,
        apiKeyId: string,
        createdById: string,
        dto: IntegrateBatchDto,
    ) {
        const results: { index: number; status: 'ok' | 'error'; entryId?: string; error?: string }[] = [];
        for (let i = 0; i < dto.entries.length; i++) {
            try {
                const { entry } = await this.submitEntry(
                    cashbookId, workspaceId, apiKeyId, createdById, dto.entries[i],
                );
                results.push({ index: i, status: 'ok', entryId: entry.id });
            } catch (err: any) {
                results.push({ index: i, status: 'error', error: err.message });
                logger.warn(`Integration batch entry ${i} failed: ${err.message}`);
            }
        }
        return results;
    }

    async getBookSummary(cashbookId: string) {
        const cashbook = await this.prisma.cashbook.findUnique({
            where: { id: cashbookId },
            select: {
                id: true, bookRef: true, name: true, currency: true, balance: true,
                totalIncome: true, totalExpense: true,
            },
        });
        if (!cashbook) throw new NotFoundError('Cashbook');
        return cashbook;
    }

    private findByExternalRef(cashbookId: string, integrationApiKeyId: string, externalRef: string) {
        return this.prisma.entry.findUnique({
            where: { cashbookId_integrationApiKeyId_externalRef: {
                cashbookId, integrationApiKeyId, externalRef,
            } },
            include: {
                category: true,
                contact: true,
                paymentMode: true,
                createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
        });
    }
}
