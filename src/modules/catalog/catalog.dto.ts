import { z } from 'zod';

const decimalString = z.string().regex(
    /^\d+(\.\d{1,4})?$/,
    'Must be a valid decimal number with up to 4 decimal places'
);

// ─── Tax Schemas ───────────────────────────────────────

export const createTaxSchema = z.object({
    name: z.string().min(1, 'Tax name is required').max(100),
    rate: decimalString,
    isCompound: z.boolean().default(false),
    isRecoverable: z.boolean().default(true),
});

export const updateTaxSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    rate: decimalString.optional(),
    isCompound: z.boolean().optional(),
    isRecoverable: z.boolean().optional(),
    isActive: z.boolean().optional(),
});

// ─── Product/Service Schemas ───────────────────────────

export const createProductServiceSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: z.string().max(1000).optional(),
    price: decimalString,
    type: z.enum(['PRODUCT', 'SERVICE']),
    isSellable: z.boolean().default(true),
    isBuyable: z.boolean().default(false),
    taxId: z.string().uuid().optional(),
    // For PRODUCT type: link to an inventory item so invoicing can perform correct stock-outs
    inventoryItemId: z.string().uuid().optional(),
});

export const updateProductServiceSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    price: decimalString.optional(),
    type: z.enum(['PRODUCT', 'SERVICE']).optional(),
    isSellable: z.boolean().optional(),
    isBuyable: z.boolean().optional(),
    taxId: z.string().uuid().nullable().optional(),
    inventoryItemId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
});

export const catalogQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    type: z.enum(['PRODUCT', 'SERVICE']).optional(),
    search: z.string().optional(),
    isActive: z.enum(['true', 'false']).optional(),
});

// ─── Types ─────────────────────────────────────────────

export type CreateTaxDto = z.infer<typeof createTaxSchema>;
export type UpdateTaxDto = z.infer<typeof updateTaxSchema>;
export type CreateProductServiceDto = z.infer<typeof createProductServiceSchema>;
export type UpdateProductServiceDto = z.infer<typeof updateProductServiceSchema>;
export type CatalogQueryDto = z.infer<typeof catalogQuerySchema>;
