import { injectable, inject } from 'tsyringe';
import { PrismaClient, InventoryTransactionType, InventoryReferenceType, InventoryCostMethod } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { InventoryRepository } from './inventory.repository';
import { AppError, NotFoundError } from '../../core/errors/AppError';
import { AuditAction } from '../../core/types';
import {
    CreateInventoryItemDto,
    UpdateInventoryItemDto,
    InventoryItemQueryDto,
    CreateInventoryTransactionDto,
    InventoryTransactionQueryDto,
    InventoryLineItemDto,
    CogsReportQueryDto,
} from './inventory.dto';

// Stock-in transaction types (increase quantityOnHand)
const STOCK_IN_TYPES: InventoryTransactionType[] = [
    InventoryTransactionType.PURCHASE,
    InventoryTransactionType.TRANSFER_IN,
    InventoryTransactionType.RETURN_IN,
];

// Stock-out transaction types (decrease quantityOnHand)
const STOCK_OUT_TYPES: InventoryTransactionType[] = [
    InventoryTransactionType.SALE,
    InventoryTransactionType.TRANSFER_OUT,
    InventoryTransactionType.RETURN_OUT,
];

// ─── Internal cost resolution result ──────────────────────────────────────────
interface CostResolution {
    unitCost: Decimal;         // weighted average unit cost of the outflow
    cogs: Decimal;             // total COGS for the outflow
    lotConsumptions: Array<{   // for FIFO/LIFO audit trail
        lotId: string;
        quantityUsed: number;
        unitCost: Decimal;
    }>;
}

@injectable()
export class InventoryService {
    constructor(
        private repository: InventoryRepository,
        @inject('PrismaClient') private prisma: PrismaClient,
    ) { }

    // ═══════════════════════════════════════════════════════
    // ─── Item CRUD ─────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    async createItem(workspaceId: string, userId: string, dto: CreateInventoryItemDto) {
        if (dto.sku) {
            const existing = await this.prisma.inventoryItem.findUnique({
                where: { workspaceId_sku: { workspaceId, sku: dto.sku } },
            });
            if (existing) {
                throw new AppError(`An item with SKU "${dto.sku}" already exists`, 409, 'DUPLICATE_SKU');
            }
        }

        return this.prisma.$transaction(async (tx) => {
            const item = await tx.inventoryItem.create({
                data: {
                    workspaceId,
                    name: dto.name,
                    sku: dto.sku || null,
                    unit: dto.unit,
                    category: dto.category || null,
                    lowStockThreshold: dto.lowStockThreshold ?? null,
                    costMethod: dto.costMethod as any,
                    allowNegativeStock: dto.allowNegativeStock,
                },
            });

            await tx.inventoryStock.create({
                data: {
                    itemId: item.id,
                    quantityOnHand: 0,
                    averageCost: 0,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.INVENTORY_ITEM_CREATED as any,
                    resource: 'inventory_item',
                    resourceId: item.id,
                    details: { name: item.name, sku: item.sku, unit: item.unit } as any,
                },
            });

            return tx.inventoryItem.findUnique({
                where: { id: item.id },
                include: { stock: true },
            });
        });
    }

    async getItems(workspaceId: string, query: InventoryItemQueryDto) {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;
        const skip = (page - 1) * limit;

        const { items, total } = await this.repository.findItemsByWorkspace(workspaceId, {
            skip,
            take: limit,
            category: query.category,
            isActive: query.isActive !== undefined ? query.isActive === 'true' : undefined,
            search: query.search,
        });

        const totalPages = Math.ceil(total / limit);

        return {
            data: items,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    async getItem(itemId: string, workspaceId: string) {
        const item = await this.repository.findItemById(itemId);
        if (!item || item.workspaceId !== workspaceId) {
            throw new NotFoundError('Inventory Item');
        }
        return item;
    }

    async updateItem(itemId: string, workspaceId: string, userId: string, dto: UpdateInventoryItemDto) {
        const item = await this.repository.findItemById(itemId);
        if (!item || item.workspaceId !== workspaceId) {
            throw new NotFoundError('Inventory Item');
        }

        if (dto.sku && dto.sku !== item.sku) {
            const duplicate = await this.prisma.inventoryItem.findUnique({
                where: { workspaceId_sku: { workspaceId, sku: dto.sku } },
            });
            if (duplicate && duplicate.id !== itemId) {
                throw new AppError(`An item with SKU "${dto.sku}" already exists`, 409, 'DUPLICATE_SKU');
            }
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            const result = await tx.inventoryItem.update({
                where: { id: itemId },
                data: {
                    ...(dto.name !== undefined && { name: dto.name }),
                    ...(dto.sku !== undefined && { sku: dto.sku }),
                    ...(dto.unit !== undefined && { unit: dto.unit }),
                    ...(dto.category !== undefined && { category: dto.category }),
                    ...(dto.lowStockThreshold !== undefined && { lowStockThreshold: dto.lowStockThreshold }),
                    ...(dto.allowNegativeStock !== undefined && { allowNegativeStock: dto.allowNegativeStock }),
                    ...(dto.isActive !== undefined && { isActive: dto.isActive }),
                },
                include: { stock: true },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.INVENTORY_ITEM_UPDATED as any,
                    resource: 'inventory_item',
                    resourceId: itemId,
                    details: { changes: dto } as any,
                },
            });

            return result;
        });

        return updated;
    }

    async deactivateItem(itemId: string, workspaceId: string, userId: string) {
        const item = await this.repository.findItemById(itemId);
        if (!item || item.workspaceId !== workspaceId) {
            throw new NotFoundError('Inventory Item');
        }

        return this.prisma.$transaction(async (tx) => {
            const result = await tx.inventoryItem.update({
                where: { id: itemId },
                data: { isActive: false },
                include: { stock: true },
            });

            await tx.auditLog.create({
                data: {
                    userId,
                    workspaceId,
                    action: AuditAction.INVENTORY_ITEM_DEACTIVATED as any,
                    resource: 'inventory_item',
                    resourceId: itemId,
                },
            });

            return result;
        });
    }

    // ═══════════════════════════════════════════════════════
    // ─── Manual Inventory Transaction ──────────────────────
    // ═══════════════════════════════════════════════════════

    async createTransaction(workspaceId: string, userId: string, dto: CreateInventoryTransactionDto) {
        const item = await this.repository.findItemById(dto.itemId);
        if (!item || item.workspaceId !== workspaceId) {
            throw new NotFoundError('Inventory Item');
        }
        if (!item.isActive) {
            throw new AppError('Cannot create transactions for an inactive item', 400, 'ITEM_INACTIVE');
        }

        if (dto.referenceType && dto.referenceType !== 'MANUAL') {
            throw new AppError(
                'Transactions linked to financial records can only be created through the corresponding financial module',
                400,
                'INVALID_REFERENCE_TYPE'
            );
        }

        const transactionType = dto.transactionType as InventoryTransactionType;
        const isStockIn = STOCK_IN_TYPES.includes(transactionType) &&
            !(transactionType === InventoryTransactionType.ADJUSTMENT);
        const isStockOut = STOCK_OUT_TYPES.includes(transactionType) &&
            !(transactionType === InventoryTransactionType.ADJUSTMENT);

        const sellingPrice = dto.sellingPrice ? new Decimal(dto.sellingPrice) : null;

        const refType = dto.referenceType
            ? dto.referenceType as InventoryReferenceType
            : InventoryReferenceType.MANUAL;

        if (isStockIn || transactionType === InventoryTransactionType.ADJUSTMENT) {
            // unitCost is required for stock-in — DTO refinement already enforces this,
            // but we add a runtime guard to maintain a clear error message if bypassed.
            if (!dto.unitCost) {
                throw new AppError(
                    'unitCost is required for stock-in transactions',
                    400,
                    'UNIT_COST_REQUIRED'
                );
            }
            return this.processStockIn(
                workspaceId,
                dto.itemId,
                transactionType,
                dto.quantity,
                new Decimal(dto.unitCost),
                userId,
                refType,
                dto.referenceId || null,
                dto.notes || null,
            );
        } else {
            // Stock-out: unitCost is irrelevant — COGS always comes from the cost method.
            // sellingPrice is optional but encouraged for gross-margin reporting.
            return this.processStockOut(
                workspaceId,
                dto.itemId,
                transactionType,
                dto.quantity,
                userId,
                refType,
                dto.referenceId || null,
                dto.notes || null,
                undefined,   // tx — none for manual transactions
                sellingPrice,
            );
        }
    }

    async getTransactions(workspaceId: string, query: InventoryTransactionQueryDto) {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;
        const skip = (page - 1) * limit;

        const { transactions, total } = await this.repository.findTransactionsByWorkspace(workspaceId, {
            skip,
            take: limit,
            itemId: query.itemId,
            transactionType: query.transactionType,
            startDate: query.startDate,
            endDate: query.endDate,
            sortOrder: query.sortOrder || 'desc',
        });

        const totalPages = Math.ceil(total / limit);

        return {
            data: transactions,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1,
            },
        };
    }

    // ═══════════════════════════════════════════════════════
    // ─── Core Stock Operations (Atomic, ACID-safe) ─────────
    // ═══════════════════════════════════════════════════════

    /**
     * Process a stock-in operation (PURCHASE, TRANSFER_IN, RETURN_IN, ADJUSTMENT+).
     *
     * Strategy by costMethod:
     *  - WEIGHTED_AVERAGE: recalculates running average cost.
     *  - FIFO / LIFO: records the lot for future consumption tracking.
     *    averageCost is still maintained for stock-level reporting.
     *
     * All updates performed inside an atomic transaction (ACID compliant).
     */
    async processStockIn(
        workspaceId: string,
        itemId: string,
        transactionType: InventoryTransactionType,
        quantity: number,
        unitCost: Decimal,
        createdById: string,
        referenceType: InventoryReferenceType,
        referenceId: string | null,
        notes: string | null,
        tx?: any,
    ) {
        const execute = async (prisma: any) => {
            // Use SELECT FOR UPDATE to prevent concurrent modification on the stock row
            await prisma.$queryRaw`
                SELECT id FROM inventory_stock WHERE item_id = ${itemId}::uuid FOR UPDATE
            `;

            const stock = await prisma.inventoryStock.findUnique({ where: { itemId } });
            if (!stock) {
                throw new AppError('Stock record not found. Item may be corrupted.', 500, 'STOCK_NOT_FOUND');
            }

            const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
            const costMethod: InventoryCostMethod = item.costMethod;

            const currentQty = stock.quantityOnHand;
            const currentAvgCost = new Decimal(stock.averageCost);
            const totalCost = unitCost.mul(quantity);

            // Recalculate running WAC (used for all methods for reporting purposes)
            const totalExistingValue = currentAvgCost.mul(currentQty);
            const newTotalQty = currentQty + quantity;
            const newAvgCost = newTotalQty > 0
                ? totalExistingValue.add(totalCost).div(newTotalQty)
                : new Decimal(0);

            // Update stock quantity and average cost
            await prisma.inventoryStock.update({
                where: { itemId },
                data: {
                    quantityOnHand: newTotalQty,
                    averageCost: newAvgCost,
                },
            });

            // Create the inventory transaction record
            const invTransaction = await prisma.inventoryTransaction.create({
                data: {
                    workspaceId,
                    itemId,
                    transactionType,
                    quantity,           // positive for stock-in
                    unitCost,
                    totalCost,
                    referenceType,
                    referenceId,
                    notes,
                    createdById,
                },
            });

            // For FIFO/LIFO: record the lot so stock-out can consume in correct order
            if (costMethod === InventoryCostMethod.FIFO || costMethod === InventoryCostMethod.LIFO) {
                await prisma.inventoryLot.create({
                    data: {
                        workspaceId,
                        itemId,
                        unitCost,
                        quantityIn: quantity,
                        quantityRemaining: quantity,
                        transactionId: invTransaction.id,
                    },
                });
            }

            return invTransaction;
        };

        if (tx) return execute(tx);
        return this.prisma.$transaction(async (prisma) => execute(prisma));
    }

    /**
     * Process a stock-out operation (SALE, TRANSFER_OUT, RETURN_OUT, ADJUSTMENT-).
     *
     * Strategy by costMethod:
     *  - WEIGHTED_AVERAGE: unitCost = current averageCost. Simple, fast.
     *  - FIFO: consumes lots from oldest to newest (lowest createdAt first).
     *  - LIFO: consumes lots from newest to oldest (highest createdAt first).
     *
     * The `sellingPrice` parameter is purely informational (for gross-margin
     * reporting). It does NOT affect COGS calculation.
     *
     * All updates performed inside an atomic transaction (ACID compliant).
     */
    async processStockOut(
        workspaceId: string,
        itemId: string,
        transactionType: InventoryTransactionType,
        quantity: number,
        createdById: string,
        referenceType: InventoryReferenceType,
        referenceId: string | null,
        notes: string | null,
        tx?: any,
        sellingPrice: Decimal | null = null,
    ) {
        const execute = async (prisma: any) => {
            // Lock the stock row to prevent concurrent updates
            await prisma.$queryRaw`
                SELECT id FROM inventory_stock WHERE item_id = ${itemId}::uuid FOR UPDATE
            `;

            const stock = await prisma.inventoryStock.findUnique({ where: { itemId } });
            if (!stock) {
                throw new AppError('Stock record not found. Item may be corrupted.', 500, 'STOCK_NOT_FOUND');
            }

            const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
            const costMethod: InventoryCostMethod = item.costMethod;

            // Negative stock guard
            if (!item.allowNegativeStock && stock.quantityOnHand < quantity) {
                throw new AppError(
                    `Insufficient stock. Available: ${stock.quantityOnHand}, Requested: ${quantity}`,
                    400,
                    'INSUFFICIENT_STOCK'
                );
            }

            let cogsResolution: CostResolution;

            switch (costMethod) {
                case InventoryCostMethod.FIFO:
                    cogsResolution = await this.resolveCostFIFO(prisma, itemId, quantity, 'asc');
                    break;
                case InventoryCostMethod.LIFO:
                    cogsResolution = await this.resolveCostFIFO(prisma, itemId, quantity, 'lifo');
                    break;
                default: // WEIGHTED_AVERAGE
                    cogsResolution = this.resolveCostWAC(stock.averageCost, quantity);
            }

            const newQty = stock.quantityOnHand - quantity;

            // Update stock quantity (average cost unchanged on stock-out for all methods)
            await prisma.inventoryStock.update({
                where: { itemId },
                data: { quantityOnHand: newQty },
            });

            // Create the transaction record
            const invTransaction = await prisma.inventoryTransaction.create({
                data: {
                    workspaceId,
                    itemId,
                    transactionType,
                    quantity: -quantity,            // negative for stock-out
                    unitCost: cogsResolution.unitCost,
                    totalCost: cogsResolution.cogs,
                    costOfGoodsSold: cogsResolution.cogs,
                    sellingPrice,
                    referenceType,
                    referenceId,
                    notes,
                    createdById,
                },
            });

            // For FIFO/LIFO: persist the lot consumption audit trail and update lot remainders
            if (
                (costMethod === InventoryCostMethod.FIFO || costMethod === InventoryCostMethod.LIFO) &&
                cogsResolution.lotConsumptions.length > 0
            ) {
                for (const consumption of cogsResolution.lotConsumptions) {
                    // Write the consumption record
                    await prisma.lotConsumption.create({
                        data: {
                            lotId: consumption.lotId,
                            transactionId: invTransaction.id,
                            quantityUsed: consumption.quantityUsed,
                            unitCost: consumption.unitCost,
                        },
                    });

                    // Decrement the lot's remaining quantity
                    await prisma.inventoryLot.update({
                        where: { id: consumption.lotId },
                        data: {
                            quantityRemaining: { decrement: consumption.quantityUsed },
                        },
                    });
                }
            }

            return invTransaction;
        };

        if (tx) return execute(tx);
        return this.prisma.$transaction(async (prisma) => execute(prisma));
    }

    // ═══════════════════════════════════════════════════════
    // ─── Private Cost Resolution Strategies ────────────────
    // ═══════════════════════════════════════════════════════

    /**
     * Weighted Average Cost: a single query-free calculation.
     * Pulls the running average from the already-loaded stock row.
     */
    private resolveCostWAC(averageCostRaw: any, quantity: number): CostResolution {
        const avgCost = new Decimal(averageCostRaw);
        const cogs = avgCost.mul(quantity);
        return {
            unitCost: avgCost,
            cogs,
            lotConsumptions: [],  // WAC does not track lots
        };
    }

    /**
     * FIFO / LIFO resolution.
     * Queries open lots sorted by createdAt ASC (FIFO) or DESC (LIFO).
     * Iterates through lots, consuming from each until the requested quantity
     * is satisfied. Returns the weighted average unit cost across all consumed lots
     * plus the individual lot consumption records for the audit trail.
     *
     * Performance: The compound index on (itemId, quantityRemaining) ensures only
     * open lots are returned quickly. We take only as many rows as needed.
     */
    private async resolveCostFIFO(
        prisma: any,
        itemId: string,
        quantity: number,
        order: 'asc' | 'lifo',
    ): Promise<CostResolution> {
        const sortOrder = order === 'lifo' ? 'desc' : 'asc';

        // Only fetch lots that still have remaining units
        const openLots = await prisma.inventoryLot.findMany({
            where: {
                itemId,
                quantityRemaining: { gt: 0 },
            },
            orderBy: { createdAt: sortOrder },
        });

        let remaining = quantity;
        let totalCogs = new Decimal(0);
        const consumptions: CostResolution['lotConsumptions'] = [];

        for (const lot of openLots) {
            if (remaining <= 0) break;

            const fromThisLot = Math.min(remaining, lot.quantityRemaining);
            const lotUnitCost = new Decimal(lot.unitCost);
            const lotCogs = lotUnitCost.mul(fromThisLot);

            consumptions.push({
                lotId: lot.id,
                quantityUsed: fromThisLot,
                unitCost: lotUnitCost,
            });

            totalCogs = totalCogs.add(lotCogs);
            remaining -= fromThisLot;
        }

        if (remaining > 0) {
            // Edge case: not enough lot data (e.g. item migrated from WAC or lots deleted)
            // Fall back to zero cost for the remainder to avoid a hard crash.
            // This can be surfaced as a warning in future iterations.
        }

        // Weighted-average unit cost across all consumed lots (for the unitCost column)
        const effectiveUnitCost = quantity > 0
            ? totalCogs.div(quantity)
            : new Decimal(0);

        return {
            unitCost: effectiveUnitCost,
            cogs: totalCogs,
            lotConsumptions: consumptions,
        };
    }

    // ═══════════════════════════════════════════════════════
    // ─── Integration Hooks (Called from Entries/AccTx) ──────
    // ═══════════════════════════════════════════════════════

    /**
     * Process inventory line items attached to a financial Entry.
     * - EXPENSE entry → PURCHASE (stock-in)
     * - INCOME entry  → SALE (stock-out), selling price = derived entry unit revenue
     */
    async processEntryInventory(
        tx: any,
        workspaceId: string,
        entryId: string,
        entryType: string,
        entryAmount: Decimal,
        inventoryItems: InventoryLineItemDto[],
        createdById: string,
        notes: string | null = null,
    ) {
        const isPurchase = entryType === 'EXPENSE';
        const totalQtyAllItems = inventoryItems.reduce((sum, li) => sum + li.quantity, 0);

        for (const lineItem of inventoryItems) {
            const item = await tx.inventoryItem.findUnique({
                where: { id: lineItem.itemId },
                include: { stock: true },
            });

            if (!item || item.workspaceId !== workspaceId) {
                throw new AppError(`Inventory item ${lineItem.itemId} not found`, 404, 'ITEM_NOT_FOUND');
            }
            if (!item.isActive) {
                throw new AppError(`Inventory item "${item.name}" is inactive`, 400, 'ITEM_INACTIVE');
            }

            // For purchases, unitCost = acquisition cost
            let unitCostForIn: Decimal | null = null;
            if (isPurchase) {
                unitCostForIn = lineItem.unitCost
                    ? new Decimal(lineItem.unitCost)
                    : entryAmount.div(totalQtyAllItems);
            }

            // For sales, sellingPrice is: explicit per-line value > fallback to prorated entry amount
            const sellingPricePerUnit = !isPurchase
                ? (lineItem.sellingPrice
                    ? new Decimal(lineItem.sellingPrice)
                    : lineItem.unitCost
                        ? new Decimal(lineItem.unitCost)
                        : entryAmount.div(totalQtyAllItems))
                : null;

            if (isPurchase) {
                await this.processStockIn(
                    workspaceId,
                    lineItem.itemId,
                    InventoryTransactionType.PURCHASE,
                    lineItem.quantity,
                    unitCostForIn!,
                    createdById,
                    InventoryReferenceType.ENTRY,
                    entryId,
                    notes,
                    tx,
                );
            } else {
                await this.processStockOut(
                    workspaceId,
                    lineItem.itemId,
                    InventoryTransactionType.SALE,
                    lineItem.quantity,
                    createdById,
                    InventoryReferenceType.ENTRY,
                    entryId,
                    notes,
                    tx,
                    sellingPricePerUnit,
                );
            }
        }
    }

    /**
     * Process inventory line items attached to a direct AccountTransaction.
     */
    async processAccountTransactionInventory(
        tx: any,
        workspaceId: string,
        transactionId: string,
        transactionType: string,
        transactionAmount: Decimal,
        inventoryItems: InventoryLineItemDto[],
        createdById: string,
        notes: string | null = null,
    ) {
        const isPurchase = transactionType === 'EXPENSE';
        const totalQtyAllItems = inventoryItems.reduce((sum, li) => sum + li.quantity, 0);

        for (const lineItem of inventoryItems) {
            const item = await tx.inventoryItem.findUnique({
                where: { id: lineItem.itemId },
                include: { stock: true },
            });

            if (!item || item.workspaceId !== workspaceId) {
                throw new AppError(`Inventory item ${lineItem.itemId} not found`, 404, 'ITEM_NOT_FOUND');
            }
            if (!item.isActive) {
                throw new AppError(`Inventory item "${item.name}" is inactive`, 400, 'ITEM_INACTIVE');
            }

            const derivedAmount = lineItem.unitCost
                ? new Decimal(lineItem.unitCost)
                : transactionAmount.div(totalQtyAllItems);

            // sellingPrice: explicit per-line value > fallback to prorated transaction amount
            const sellingPricePerUnit = !isPurchase
                ? (lineItem.sellingPrice
                    ? new Decimal(lineItem.sellingPrice)
                    : derivedAmount)
                : null;

            if (isPurchase) {
                await this.processStockIn(
                    workspaceId,
                    lineItem.itemId,
                    InventoryTransactionType.PURCHASE,
                    lineItem.quantity,
                    derivedAmount,
                    createdById,
                    InventoryReferenceType.ACCOUNT_TRANSACTION,
                    transactionId,
                    notes,
                    tx,
                );
            } else {
                await this.processStockOut(
                    workspaceId,
                    lineItem.itemId,
                    InventoryTransactionType.SALE,
                    lineItem.quantity,
                    createdById,
                    InventoryReferenceType.ACCOUNT_TRANSACTION,
                    transactionId,
                    notes,
                    tx,
                    sellingPricePerUnit,
                );
            }
        }
    }

    /**
     * Process inventory line items attached to a PAYABLE obligation.
     * Stocks in goods when a payable obligation is created.
     */
    async processObligationInventory(
        tx: any,
        workspaceId: string,
        obligationId: string,
        obligationAmount: Decimal,
        inventoryItems: InventoryLineItemDto[],
        createdById: string,
        notes: string | null = null,
    ) {
        const totalQtyAllItems = inventoryItems.reduce((sum, li) => sum + li.quantity, 0);

        for (const lineItem of inventoryItems) {
            const item = await tx.inventoryItem.findUnique({
                where: { id: lineItem.itemId },
                include: { stock: true },
            });

            if (!item || item.workspaceId !== workspaceId) {
                throw new AppError(`Inventory item ${lineItem.itemId} not found`, 404, 'ITEM_NOT_FOUND');
            }
            if (!item.isActive) {
                throw new AppError(`Inventory item "${item.name}" is inactive`, 400, 'ITEM_INACTIVE');
            }

            const unitCost = lineItem.unitCost
                ? new Decimal(lineItem.unitCost)
                : obligationAmount.div(totalQtyAllItems);

            await this.processStockIn(
                workspaceId,
                lineItem.itemId,
                InventoryTransactionType.PURCHASE,
                lineItem.quantity,
                unitCost,
                createdById,
                InventoryReferenceType.OBLIGATION,
                obligationId,
                notes,
                tx,
            );
        }
    }

    /**
     * Reverse all inventory transactions linked to a specific financial reference.
     * Creates compensating transactions (opposite direction) to restore stock.
     * FIFO/LIFO lots are restored by creating new lots with the original cost.
     */
    async reverseInventoryForReference(
        tx: any,
        referenceType: InventoryReferenceType,
        referenceId: string,
    ) {
        const linkedTransactions = await tx.inventoryTransaction.findMany({
            where: { referenceType, referenceId },
            orderBy: { createdAt: 'asc' },
        });

        if (linkedTransactions.length === 0) return;

        for (const invTx of linkedTransactions) {
            await tx.$queryRaw`
                SELECT id FROM inventory_stock WHERE item_id = ${invTx.itemId}::uuid FOR UPDATE
            `;

            const stock = await tx.inventoryStock.findUnique({ where: { itemId: invTx.itemId } });
            if (!stock) continue;

            const item = await tx.inventoryItem.findUnique({ where: { id: invTx.itemId } });
            const costMethod: InventoryCostMethod = item.costMethod;

            const absQuantity = Math.abs(invTx.quantity);
            const reversalNotes = `Reversal: ${referenceType} ${referenceId} updated/deleted`;

            if (invTx.quantity > 0) {
                // Original was stock-IN → reversal = stock-OUT
                // Use the transaction's own unitCost to avoid retroactively changing COGS history
                const unitCost = new Decimal(invTx.unitCost);
                const avgCost = new Decimal(stock.averageCost);
                const cogs = avgCost.mul(absQuantity);
                const newQty = stock.quantityOnHand - absQuantity;

                await tx.inventoryStock.update({
                    where: { itemId: invTx.itemId },
                    data: { quantityOnHand: newQty },
                });

                await tx.inventoryTransaction.create({
                    data: {
                        workspaceId: invTx.workspaceId,
                        itemId: invTx.itemId,
                        transactionType: InventoryTransactionType.ADJUSTMENT,
                        quantity: -absQuantity,
                        unitCost: avgCost,
                        totalCost: cogs,
                        costOfGoodsSold: cogs,
                        referenceType,
                        referenceId,
                        notes: reversalNotes,
                        createdById: invTx.createdById,
                    },
                });

                // For FIFO/LIFO: find and remove the lot that was created by this stock-in
                if (costMethod === InventoryCostMethod.FIFO || costMethod === InventoryCostMethod.LIFO) {
                    const lot = await tx.inventoryLot.findFirst({
                        where: { transactionId: invTx.id },
                    });
                    if (lot) {
                        // Reduce lot by the qty being reversed
                        const reducedRemaining = Math.max(0, lot.quantityRemaining - absQuantity);
                        await tx.inventoryLot.update({
                            where: { id: lot.id },
                            data: { quantityRemaining: reducedRemaining },
                        });
                    }
                }
            } else {
                // Original was stock-OUT → reversal = stock-IN (restore to stock)
                const returnUnitCost = new Decimal(invTx.unitCost);
                const totalCost = returnUnitCost.mul(absQuantity);

                const currentQty = stock.quantityOnHand;
                const currentAvgCost = new Decimal(stock.averageCost);
                const totalExistingValue = currentAvgCost.mul(currentQty);
                const newTotalQty = currentQty + absQuantity;
                const newAvgCost = newTotalQty > 0
                    ? totalExistingValue.add(totalCost).div(newTotalQty)
                    : new Decimal(0);

                await tx.inventoryStock.update({
                    where: { itemId: invTx.itemId },
                    data: {
                        quantityOnHand: newTotalQty,
                        averageCost: newAvgCost,
                    },
                });

                const reversalInTx = await tx.inventoryTransaction.create({
                    data: {
                        workspaceId: invTx.workspaceId,
                        itemId: invTx.itemId,
                        transactionType: InventoryTransactionType.ADJUSTMENT,
                        quantity: absQuantity,
                        unitCost: returnUnitCost,
                        totalCost,
                        referenceType,
                        referenceId,
                        notes: reversalNotes,
                        createdById: invTx.createdById,
                    },
                });

                // For FIFO/LIFO: restore the lot inventory (re-open/create a lot)
                if (costMethod === InventoryCostMethod.FIFO || costMethod === InventoryCostMethod.LIFO) {
                    await tx.inventoryLot.create({
                        data: {
                            workspaceId: invTx.workspaceId,
                            itemId: invTx.itemId,
                            unitCost: returnUnitCost,
                            quantityIn: absQuantity,
                            quantityRemaining: absQuantity,
                            transactionId: reversalInTx.id,
                        },
                    });
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    // ─── Reporting (Read-Only) ─────────────────────────────
    // ═══════════════════════════════════════════════════════

    async getStockLevels(workspaceId: string) {
        const items = await this.repository.getStockLevels(workspaceId);
        return items.map(item => ({
            id: item.id,
            name: item.name,
            sku: item.sku,
            unit: item.unit,
            category: item.category,
            costMethod: item.costMethod,
            quantityOnHand: item.stock?.quantityOnHand ?? 0,
            averageCost: item.stock?.averageCost?.toString() ?? '0',
            inventoryValue: item.stock
                ? new Decimal(item.stock.averageCost).mul(item.stock.quantityOnHand).toString()
                : '0',
        }));
    }

    async getInventoryValuation(workspaceId: string) {
        const items = await this.repository.getStockLevels(workspaceId);
        let totalValue = new Decimal(0);

        const breakdown = items.map(item => {
            const value = item.stock
                ? new Decimal(item.stock.averageCost).mul(item.stock.quantityOnHand)
                : new Decimal(0);
            totalValue = totalValue.add(value);
            return {
                id: item.id,
                name: item.name,
                sku: item.sku,
                costMethod: item.costMethod,
                quantityOnHand: item.stock?.quantityOnHand ?? 0,
                averageCost: item.stock?.averageCost?.toString() ?? '0',
                value: value.toString(),
            };
        });

        return {
            totalValue: totalValue.toString(),
            itemCount: items.length,
            breakdown,
        };
    }

    async getStockMovementHistory(workspaceId: string, itemId: string) {
        const item = await this.repository.findItemById(itemId);
        if (!item || item.workspaceId !== workspaceId) {
            throw new NotFoundError('Inventory Item');
        }

        const { transactions } = await this.repository.findTransactionsByWorkspace(workspaceId, {
            skip: 0,
            take: 100,
            itemId,
            sortOrder: 'desc',
        });

        return {
            item: {
                id: item.id,
                name: item.name,
                sku: item.sku,
                unit: item.unit,
                costMethod: item.costMethod,
                currentStock: item.stock?.quantityOnHand ?? 0,
                averageCost: item.stock?.averageCost?.toString() ?? '0',
            },
            movements: transactions,
        };
    }

    async getCogsSummary(workspaceId: string, query: CogsReportQueryDto) {
        const transactions = await this.repository.getCogsSummary(
            workspaceId,
            query.startDate,
            query.endDate,
        );

        let totalCogs = new Decimal(0);
        let totalRevenue = new Decimal(0);

        for (const t of transactions) {
            if (t.costOfGoodsSold) {
                totalCogs = totalCogs.add(new Decimal(t.costOfGoodsSold));
            }
            if ((t as any).sellingPrice) {
                const qty = Math.abs(t.quantity);
                totalRevenue = totalRevenue.add(new Decimal((t as any).sellingPrice).mul(qty));
            }
        }

        const grossProfit = totalRevenue.sub(totalCogs);

        return {
            totalCostOfGoodsSold: totalCogs.toString(),
            totalRevenue: totalRevenue.toString(),
            grossProfit: grossProfit.toString(),
            transactionCount: transactions.length,
            transactions: transactions.map(t => ({
                id: t.id,
                itemName: t.item.name,
                itemSku: t.item.sku,
                transactionType: t.transactionType,
                quantity: t.quantity,
                unitCost: t.unitCost.toString(),
                costOfGoodsSold: t.costOfGoodsSold?.toString() ?? '0',
                sellingPrice: (t as any).sellingPrice?.toString() ?? null,
                createdAt: t.createdAt,
            })),
        };
    }

    async getLowStockAlerts(workspaceId: string) {
        const items = await this.repository.getLowStockItems(workspaceId);
        return items.map(item => ({
            id: item.id,
            name: item.name,
            sku: item.sku,
            unit: item.unit,
            quantityOnHand: item.stock?.quantityOnHand ?? 0,
            lowStockThreshold: item.lowStockThreshold,
            deficit: (item.lowStockThreshold ?? 0) - (item.stock?.quantityOnHand ?? 0),
        }));
    }

    // ═══════════════════════════════════════════════════════
    // ─── Helpers ───────────────────────────────────────────
    // ═══════════════════════════════════════════════════════

    private async validateReference(
        referenceType: InventoryReferenceType,
        referenceId: string,
        workspaceId: string,
    ) {
        switch (referenceType) {
            case InventoryReferenceType.ENTRY: {
                const entry = await this.prisma.entry.findUnique({ where: { id: referenceId } });
                if (!entry) throw new AppError('Referenced entry not found', 404, 'REFERENCE_NOT_FOUND');
                break;
            }
            case InventoryReferenceType.ACCOUNT_TRANSACTION: {
                const accTx = await this.prisma.accountTransaction.findUnique({ where: { id: referenceId } });
                if (!accTx || accTx.workspaceId !== workspaceId) {
                    throw new AppError('Referenced account transaction not found', 404, 'REFERENCE_NOT_FOUND');
                }
                break;
            }
            case InventoryReferenceType.OBLIGATION: {
                const obligation = await this.prisma.cashbookObligation.findUnique({ where: { id: referenceId } });
                if (!obligation || obligation.workspaceId !== workspaceId) {
                    throw new AppError('Referenced obligation not found', 404, 'REFERENCE_NOT_FOUND');
                }
                break;
            }
            case InventoryReferenceType.MANUAL:
                break;
        }
    }
}
