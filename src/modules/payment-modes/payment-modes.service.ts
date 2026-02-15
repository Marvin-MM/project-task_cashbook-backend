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
