import { PaymentModesRepository } from './payment-modes.repository';
import { NotFoundError, ConflictError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import { CreatePaymentModeDto, UpdatePaymentModeDto } from './payment-modes.dto';
import { getPrismaClient } from '../../config/database';

const prisma = getPrismaClient();
const paymentModesRepository = new PaymentModesRepository();

export class PaymentModesService {
    async getPaymentModes(workspaceId: string) {
        return paymentModesRepository.findByWorkspaceId(workspaceId);
    }

    async createPaymentMode(workspaceId: string, userId: string, dto: CreatePaymentModeDto) {
        const existing = await paymentModesRepository.findByNameAndWorkspace(workspaceId, dto.name);
        if (existing && existing.isActive) throw new ConflictError('A payment mode with this name already exists');
        const mode = await paymentModesRepository.create({ workspaceId, name: dto.name });
        await prisma.auditLog.create({
            data: { userId, workspaceId, action: AuditAction.PAYMENT_MODE_CREATED, resource: 'payment_mode', resourceId: mode.id, details: { name: dto.name } as any },
        });
        return mode;
    }

    async updatePaymentMode(paymentModeId: string, userId: string, dto: UpdatePaymentModeDto) {
        const mode = await paymentModesRepository.findById(paymentModeId);
        if (!mode || !mode.isActive) throw new NotFoundError('Payment mode');
        if (dto.name) {
            const existing = await paymentModesRepository.findByNameAndWorkspace(mode.workspaceId, dto.name);
            if (existing && existing.id !== paymentModeId && existing.isActive) throw new ConflictError('A payment mode with this name already exists');
        }
        return paymentModesRepository.update(paymentModeId, dto);
    }

    async deletePaymentMode(paymentModeId: string, userId: string) {
        const mode = await paymentModesRepository.findById(paymentModeId);
        if (!mode || !mode.isActive) throw new NotFoundError('Payment mode');
        await paymentModesRepository.softDelete(paymentModeId);
    }
}
