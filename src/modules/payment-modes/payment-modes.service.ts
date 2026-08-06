import { injectable, inject } from 'tsyringe';
import { PrismaClient } from '@prisma/client';
import { PaymentModesRepository } from './payment-modes.repository';
import { NotFoundError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { CreatePaymentModeDto, UpdatePaymentModeDto } from './payment-modes.dto';

@injectable()
export class PaymentModesService {
    constructor(
        private paymentModesRepository: PaymentModesRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    async getPaymentModes(workspaceId: string) {
        return this.paymentModesRepository.findByWorkspaceId(workspaceId);
    }

    async createPaymentMode(workspaceId: string, userId: string, dto: CreatePaymentModeDto) {
        const existing = await this.paymentModesRepository.findByNameAndWorkspace(workspaceId, dto.name);
        if (existing && existing.isActive) throw new ConflictError('A payment mode with this name already exists');
        const mode = await this.paymentModesRepository.create({ workspaceId, name: dto.name });
        await this.prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PAYMENT_MODE_CREATED, resource: 'payment_mode', resourceId: mode.id, details: { name: dto.name } as any },
        });
        return mode;
    }

    /**
     * The payment method that goes with a wallet, get-or-create.
     *
     * A wallet already says what kind of money it holds — its AccountType is
     * "Cash", "Mobile Money", "Bank". Asking the person recording an entry to
     * separately name the payment method is asking the same question twice, and
     * is how a workspace ends up with "cash", "Cash " and "CASH" side by side.
     * So the entry screens call this the moment a wallet is picked and fill the
     * field in.
     *
     * ─── Why this is safe to expose more widely than createPaymentMode ───
     *
     * The name is NOT user-supplied: it is read from an AccountType that
     * already exists in this workspace. So this cannot mint arbitrary reference
     * data — the set of payment modes it can ever produce is bounded by the set
     * of account types somebody with MANAGE_REFERENCE_DATA already created.
     * That is what lets an ordinary data operator, who may record entries but
     * not manage reference data, still get the field filled in.
     *
     * Find-then-create with a race fallback, matching the discipline used
     * elsewhere for get-or-create: two people picking the same never-before-used
     * wallet type at the same instant both attempt the insert, the
     * `@@unique([workspaceId, name])` constraint lets exactly one through, and
     * the loser reads the winner's row instead of erroring. A soft-deleted mode
     * of the same name is reactivated rather than duplicated — the name is still
     * spoken for, so a second insert would fail the constraint anyway.
     */
    async ensurePaymentModeForAccount(workspaceId: string, accountId: string, userId: string) {
        const account = await this.prisma.account.findUnique({
            where: { id: accountId },
            include: { accountType: { select: { name: true } } },
        });
        if (!account || account.workspaceId !== workspaceId) {
            throw new NotFoundError('Wallet');
        }

        const name = account.accountType.name;

        const existing = await this.paymentModesRepository.findByNameAndWorkspace(workspaceId, name);
        if (existing) {
            if (existing.isActive) return existing;
            return this.paymentModesRepository.update(existing.id, { isActive: true } as never);
        }

        try {
            const created = await this.paymentModesRepository.create({ workspaceId, name });
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.PAYMENT_MODE_CREATED,
                    resource: 'payment_mode',
                    resourceId: created.id,
                    details: { name, source: 'wallet_account_type', accountId } as any,
                },
            });
            return created;
        } catch (error: any) {
            if (error?.code === 'P2002') {
                // The row the winner of the race just wrote. It exists by
                // definition — the constraint that sent us here is the proof —
                // so this never legitimately returns null.
                const winner = await this.paymentModesRepository
                    .findByNameAndWorkspace(workspaceId, name);
                if (winner) return winner;
            }
            throw error;
        }
    }

    async updatePaymentMode(paymentModeId: string, userId: string, dto: UpdatePaymentModeDto) {
        const mode = await this.paymentModesRepository.findById(paymentModeId);
        if (!mode || !mode.isActive) throw new NotFoundError('Payment mode');
        if (dto.name) {
            const existing = await this.paymentModesRepository.findByNameAndWorkspace(mode.workspaceId, dto.name);
            if (existing && existing.id !== paymentModeId && existing.isActive) throw new ConflictError('A payment mode with this name already exists');
        }
        return this.paymentModesRepository.update(paymentModeId, dto);
    }

    async deletePaymentMode(paymentModeId: string, userId: string) {
        const mode = await this.paymentModesRepository.findById(paymentModeId);
        if (!mode || !mode.isActive) throw new NotFoundError('Payment mode');
        await this.paymentModesRepository.softDelete(paymentModeId);
    }
}
