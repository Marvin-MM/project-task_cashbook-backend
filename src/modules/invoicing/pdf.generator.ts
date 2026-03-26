import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';
import https from 'https';
import http from 'http';

// ─── Constants ─────────────────────────────────────────────────────────────────
const FALLBACK_LOGO_URL = 'https://inchange.odixtec.net/reportlogo.svg';
const PAGE_WIDTH = 595.28;   // A4 pt
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// ─── Types ──────────────────────────────────────────────────────────────────────
interface PdfInvoice {
    invoiceNumber: string;
    status: string;
    issueDate: Date | string;
    dueDate: Date | string;
    currency: string;
    subtotal: any;
    discountAmount: any;
    taxAmount: any;
    totalAmount: any;
    amountPaid: any;
    amountDue: any;
    notes?: string | null;
    footer?: string | null;
    customer: {
        name: string;
        email?: string | null;
        phone?: string | null;
        company?: string | null;
        customerProfile?: {
            billingAddress?: any;
            taxId?: string | null;
            currency?: string | null;
        } | null;
    };
    items: Array<{
        name: string;
        description?: string | null;
        quantity: any;
        unitPrice: any;
        taxAmount: any;
        taxRate?: any;
        total: any;
        inventoryItem?: { name: string; sku?: string | null; unit: string } | null;
    }>;
}

interface PdfSettings {
    logoUrl?: string | null;
    accentColor?: string | null;
    template?: string | null;
    defaultTerms?: string | null;
    defaultFooter?: string | null;
    defaultNotes?: string | null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an invoice PDF in-memory (ephemeral — never stored on disk).
 * Selects the correct template from settings.template:
 *   'classic'       → clean blue/white, top logo, ruled table
 *   'modern'        → dark header band, accent sidebar totals
 *   'contemporary'  → minimal, serif-style, muted grey palette
 * Falls back to 'classic' if unrecognised.
 */
export async function generateInvoicePdf(
    invoice: PdfInvoice,
    settings: PdfSettings | null,
    businessName: string,
): Promise<Buffer> {
    const accentColor = settings?.accentColor || '#4F46E5';
    const template = settings?.template || 'classic';
    const logoUrl = settings?.logoUrl || FALLBACK_LOGO_URL;

    // Fetch logo bytes (best-effort — never throw)
    const logoBuffer = await fetchUrlBuffer(logoUrl).catch(() =>
        fetchUrlBuffer(FALLBACK_LOGO_URL).catch(() => null)
    );

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: MARGIN, size: 'A4', compress: true });
            const chunks: Buffer[] = [];
            doc.on('data', (c: Buffer) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            switch (template) {
                case 'modern':
                    renderModern(doc, invoice, settings, businessName, accentColor, logoBuffer);
                    break;
                case 'contemporary':
                    renderContemporary(doc, invoice, settings, businessName, accentColor, logoBuffer);
                    break;
                default:
                    renderClassic(doc, invoice, settings, businessName, accentColor, logoBuffer);
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: CLASSIC ────────────────────────────────────────────────────────
// Clean, corporate. Logo top-left, invoice details top-right, ruled table.
// ══════════════════════════════════════════════════════════════════════════════

function renderClassic(
    doc: InstanceType<typeof PDFDocument>,
    invoice: PdfInvoice,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const lightGrey = '#F8F9FB';
    const midGrey = '#6B7280';
    const dark = '#111827';

    // ── Header band ──────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_WIDTH, 110).fill(dark);

    if (logo) {
        try {
            doc.image(logo, MARGIN, 18, { height: 45, fit: [140, 45] });
        } catch { /* SVG unsupported in pdfkit — show text fallback */ }
    }

    // Business name as text fallback (always render so it's readable)
    doc.fontSize(18).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(businessName, MARGIN, 22, { width: 250 });

    // Invoice badge top-right
    doc.fontSize(9).fillColor(accent).font('Helvetica-Bold')
        .text('INVOICE', 0, 28, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.fontSize(20).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(invoice.invoiceNumber, 0, 40, { align: 'right', width: PAGE_WIDTH - MARGIN });

    // Status pill
    const statusColor = statusToColor(invoice.status);
    doc.fontSize(8).fillColor(statusColor).font('Helvetica-Bold')
        .text(invoice.status.toUpperCase(), 0, 65, { align: 'right', width: PAGE_WIDTH - MARGIN });

    // ── Bill-from / Bill-to / Dates row ──────────────────────────────────────
    const rowY = 130;
    doc.fontSize(7).fillColor(midGrey).font('Helvetica-Bold')
        .text('BILL TO', MARGIN, rowY);
    doc.fontSize(10).fillColor(dark).font('Helvetica-Bold')
        .text(invoice.customer.name, MARGIN, rowY + 11);
    if (invoice.customer.company) {
        doc.fontSize(8.5).fillColor(midGrey).font('Helvetica')
            .text(invoice.customer.company, MARGIN, rowY + 23);
    }
    if (invoice.customer.email) {
        doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.email, MARGIN, rowY + 35);
    }
    if (invoice.customer.phone) {
        doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.phone, MARGIN, rowY + 47);
    }
    const profile = invoice.customer.customerProfile;
    if (profile?.billingAddress) {
        const addr = formatAddress(profile.billingAddress);
        if (addr) doc.fontSize(8).fillColor(midGrey).text(addr, MARGIN, rowY + 59, { width: 200 });
    }
    if (profile?.taxId) {
        doc.fontSize(8).fillColor(midGrey).text(`Tax ID: ${profile.taxId}`, MARGIN, rowY + 71);
    }

    // Dates right column
    const dateColX = PAGE_WIDTH - MARGIN - 180;
    renderLabelValue(doc, 'Issue Date', fmtDate(invoice.issueDate), dateColX, rowY, accent);
    renderLabelValue(doc, 'Due Date', fmtDate(invoice.dueDate), dateColX, rowY + 22, accent);
    renderLabelValue(doc, 'Currency', invoice.currency, dateColX, rowY + 44, accent);

    // ── Line separator ────────────────────────────────────────────────────────
    const tableTop = rowY + 90;
    doc.moveTo(MARGIN, tableTop - 12).lineTo(PAGE_WIDTH - MARGIN, tableTop - 12)
        .strokeColor('#E5E7EB').lineWidth(0.5).stroke();

    // ── Items table ───────────────────────────────────────────────────────────
    const colX = classicColX();
    renderClassicTableHeader(doc, tableTop, colX, accent);
    let y = renderClassicTableRows(doc, invoice.items, tableTop + 22, colX, lightGrey);

    // ── Totals ────────────────────────────────────────────────────────────────
    y += 16;
    y = renderTotals(doc, invoice, y, accent, dark, midGrey, 340);

    // ── Terms / Notes / Footer ────────────────────────────────────────────────
    y = renderNotesTermsFooter(doc, invoice, settings, y + 20, midGrey, dark);

    renderPageNumbers(doc);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: MODERN ─────────────────────────────────────────────────────────
// Dark full-width header. Accent colour sidebar on totals. Bold typographic.
// ══════════════════════════════════════════════════════════════════════════════

function renderModern(
    doc: InstanceType<typeof PDFDocument>,
    invoice: PdfInvoice,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const dark = '#0F172A';
    const midGrey = '#64748B';
    const lightGrey = '#F1F5F9';

    // Full-width header band
    doc.rect(0, 0, PAGE_WIDTH, 130).fill(accent);

    // Logo / business name
    if (logo) {
        try { doc.image(logo, MARGIN, 22, { height: 40, fit: [130, 40] }); } catch { }
    }
    doc.fontSize(20).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(businessName, MARGIN, 25, { width: 260 });

    // Invoice label right
    doc.fontSize(30).fillColor('rgba(255,255,255,0.25)').font('Helvetica-Bold')
        .text('INVOICE', MARGIN, 72, { align: 'right', width: CONTENT_WIDTH });
    doc.fontSize(13).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(invoice.invoiceNumber, MARGIN, 78, { align: 'right', width: CONTENT_WIDTH });

    // ── Bill to / metadata below band ────────────────────────────────────────
    const rowY = 150;
    doc.fontSize(7).fillColor(accent).font('Helvetica-Bold')
        .text('BILLED TO', MARGIN, rowY);
    doc.fontSize(11).fillColor(dark).font('Helvetica-Bold')
        .text(invoice.customer.name, MARGIN, rowY + 11);
    if (invoice.customer.company) doc.fontSize(8.5).fillColor(midGrey).font('Helvetica').text(invoice.customer.company, MARGIN, rowY + 24);
    if (invoice.customer.email) doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.email, MARGIN, rowY + 36);
    if (invoice.customer.phone) doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.phone, MARGIN, rowY + 48);

    const profile = invoice.customer.customerProfile;
    if (profile?.billingAddress) {
        const addr = formatAddress(profile.billingAddress);
        if (addr) doc.fontSize(8).fillColor(midGrey).text(addr, MARGIN, rowY + 60, { width: 200 });
    }

    // Right meta column
    const metaX = PAGE_WIDTH - MARGIN - 200;
    renderMetaPill(doc, 'ISSUE DATE', fmtDate(invoice.issueDate), metaX, rowY, accent, dark);
    renderMetaPill(doc, 'DUE DATE', fmtDate(invoice.dueDate), metaX, rowY + 34, accent, dark);
    renderMetaPill(doc, 'CURRENCY', invoice.currency, metaX, rowY + 68, accent, dark);
    renderMetaPill(doc, 'STATUS', invoice.status, metaX, rowY + 102, statusToColor(invoice.status), dark);

    // ── Table ─────────────────────────────────────────────────────────────────
    const tableTop = rowY + 140;
    const colX = classicColX();
    doc.rect(MARGIN, tableTop, CONTENT_WIDTH, 20).fill(dark);
    doc.fontSize(8).fillColor('#FFFFFF').font('Helvetica-Bold');
    doc.text('ITEM', colX.name + 4, tableTop + 6);
    doc.text('QTY', colX.qty, tableTop + 6, { align: 'center', width: 50 });
    doc.text('UNIT PRICE', colX.price, tableTop + 6);
    doc.text('TAX', colX.tax, tableTop + 6);
    doc.text('TOTAL', colX.total, tableTop + 6, { align: 'right', width: 75 });

    let y = tableTop + 24;
    for (let i = 0; i < invoice.items.length; i++) {
        const item = invoice.items[i];
        const bg = i % 2 === 0 ? lightGrey : '#FFFFFF';
        const rowH = item.description || item.inventoryItem ? 30 : 18;
        doc.rect(MARGIN, y - 2, CONTENT_WIDTH, rowH).fill(bg);
        doc.fontSize(8.5).fillColor(dark).font('Helvetica-Bold')
            .text(truncate(item.name, 38), colX.name + 4, y);
        if (item.description) {
            doc.fontSize(7.5).fillColor(midGrey).font('Helvetica')
                .text(truncate(item.description, 50), colX.name + 4, y + 11);
        }
        if (item.inventoryItem) {
            const invLabel = `SKU: ${item.inventoryItem.sku || '—'} · Unit: ${item.inventoryItem.unit}`;
            doc.fontSize(7).fillColor(accent).text(invLabel, colX.name + 4, y + (item.description ? 20 : 11));
        }
        doc.fontSize(8.5).fillColor(dark).font('Helvetica')
            .text(String(item.quantity), colX.qty, y, { align: 'center', width: 50 })
            .text(formatDecimal(item.unitPrice), colX.price, y)
            .text(formatDecimal(item.taxAmount), colX.tax, y)
            .text(formatDecimal(item.total), colX.total, y, { align: 'right', width: 75 });
        y += rowH + 2;
        if (y > 720) { doc.addPage(); y = 50; }
    }

    y += 12;
    y = renderTotals(doc, invoice, y, accent, dark, midGrey, 340);
    renderNotesTermsFooter(doc, invoice, settings, y + 20, midGrey, dark);
    renderPageNumbers(doc);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: CONTEMPORARY ───────────────────────────────────────────────────
// Minimal, whitespace-heavy. Thin accent line. Understated typography.
// ══════════════════════════════════════════════════════════════════════════════

function renderContemporary(
    doc: InstanceType<typeof PDFDocument>,
    invoice: PdfInvoice,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const dark = '#1C1C1E';
    const midGrey = '#8E8E93';
    const lightLine = '#E5E5EA';

    // Thin top accent bar
    doc.rect(0, 0, PAGE_WIDTH, 4).fill(accent);

    // Logo
    if (logo) {
        try { doc.image(logo, MARGIN, 24, { height: 36, fit: [120, 36] }); } catch { }
    }
    doc.fontSize(16).fillColor(dark).font('Helvetica-Bold')
        .text(businessName, MARGIN, 28, { width: 250 });

    // Invoice label — minimalist right alignment
    doc.fontSize(9).fillColor(midGrey).font('Helvetica')
        .text('Invoice', 0, 28, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.fontSize(14).fillColor(dark).font('Helvetica-Bold')
        .text(invoice.invoiceNumber, 0, 40, { align: 'right', width: PAGE_WIDTH - MARGIN });

    // Thin separator
    doc.moveTo(MARGIN, 78).lineTo(PAGE_WIDTH - MARGIN, 78)
        .lineWidth(0.5).strokeColor(lightLine).stroke();

    // ── Billing row ───────────────────────────────────────────────────────────
    const rowY = 90;
    doc.fontSize(7.5).fillColor(midGrey).font('Helvetica-Bold')
        .text('BILL TO', MARGIN, rowY);
    doc.fontSize(10.5).fillColor(dark).font('Helvetica-Bold')
        .text(invoice.customer.name, MARGIN, rowY + 12);
    if (invoice.customer.company) doc.fontSize(8.5).fillColor(midGrey).font('Helvetica').text(invoice.customer.company, MARGIN, rowY + 25);
    if (invoice.customer.email) doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.email, MARGIN, rowY + 37);
    if (invoice.customer.phone) doc.fontSize(8.5).fillColor(midGrey).text(invoice.customer.phone, MARGIN, rowY + 49);

    const profile = invoice.customer.customerProfile;
    if (profile?.billingAddress) {
        const addr = formatAddress(profile.billingAddress);
        if (addr) doc.fontSize(8).fillColor(midGrey).text(addr, MARGIN, rowY + 61, { width: 200 });
    }

    // Right dates — minimal
    const dX = PAGE_WIDTH - MARGIN - 180;
    renderContemporaryField(doc, 'Issued', fmtDate(invoice.issueDate), dX, rowY, midGrey, dark);
    renderContemporaryField(doc, 'Due', fmtDate(invoice.dueDate), dX, rowY + 26, midGrey, dark);
    renderContemporaryField(doc, 'Currency', invoice.currency, dX, rowY + 52, midGrey, dark);
    renderContemporaryField(doc, 'Status', invoice.status, dX, rowY + 78, statusToColor(invoice.status), dark);

    // ── Items table ───────────────────────────────────────────────────────────
    const tableTop = rowY + 120;
    doc.moveTo(MARGIN, tableTop).lineTo(PAGE_WIDTH - MARGIN, tableTop)
        .lineWidth(0.5).strokeColor(lightLine).stroke();
    const colX = classicColX();

    // Header row text only (no fill)
    doc.fontSize(7.5).fillColor(midGrey).font('Helvetica-Bold')
        .text('DESCRIPTION', colX.name + 2, tableTop + 6)
        .text('QTY', colX.qty, tableTop + 6, { width: 50, align: 'center' })
        .text('PRICE', colX.price, tableTop + 6)
        .text('TAX', colX.tax, tableTop + 6)
        .text('TOTAL', colX.total, tableTop + 6, { align: 'right', width: 75 });

    doc.moveTo(MARGIN, tableTop + 18).lineTo(PAGE_WIDTH - MARGIN, tableTop + 18)
        .lineWidth(0.5).strokeColor(lightLine).stroke();

    let y = tableTop + 24;
    for (let i = 0; i < invoice.items.length; i++) {
        const item = invoice.items[i];
        const rowH = item.description || item.inventoryItem ? 29 : 18;
        doc.fontSize(8.5).fillColor(dark).font('Helvetica-Bold')
            .text(truncate(item.name, 38), colX.name + 2, y);
        if (item.description) {
            doc.fontSize(7.5).fillColor(midGrey).font('Helvetica')
                .text(truncate(item.description, 52), colX.name + 2, y + 11);
        }
        if (item.inventoryItem) {
            const invLabel = `SKU: ${item.inventoryItem.sku || '—'} · Unit: ${item.inventoryItem.unit}`;
            doc.fontSize(7).fillColor(accent).text(invLabel, colX.name + 2, y + (item.description ? 20 : 11));
        }
        doc.fontSize(8.5).fillColor(dark).font('Helvetica')
            .text(String(item.quantity), colX.qty, y, { width: 50, align: 'center' })
            .text(formatDecimal(item.unitPrice), colX.price, y)
            .text(formatDecimal(item.taxAmount), colX.tax, y)
            .text(formatDecimal(item.total), colX.total, y, { align: 'right', width: 75 });

        doc.moveTo(MARGIN, y + rowH).lineTo(PAGE_WIDTH - MARGIN, y + rowH)
            .lineWidth(0.3).strokeColor(lightLine).stroke();
        y += rowH + 2;
        if (y > 720) { doc.addPage(); y = 50; }
    }

    y += 12;
    y = renderTotals(doc, invoice, y, accent, dark, midGrey, 340);
    renderNotesTermsFooter(doc, invoice, settings, y + 20, midGrey, dark);
    renderPageNumbers(doc);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── SHARED RENDERING HELPERS ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function classicColX() {
    return { name: MARGIN, qty: 285, price: 340, tax: 420, total: 480 };
}

function renderClassicTableHeader(doc: any, y: number, colX: ReturnType<typeof classicColX>, accent: string) {
    doc.rect(MARGIN, y, CONTENT_WIDTH, 20).fill(accent);
    doc.fontSize(8).fillColor('#FFFFFF').font('Helvetica-Bold');
    doc.text('ITEM / DESCRIPTION', colX.name + 4, y + 6);
    doc.text('QTY', colX.qty, y + 6, { width: 50, align: 'center' });
    doc.text('UNIT PRICE', colX.price, y + 6);
    doc.text('TAX', colX.tax, y + 6);
    doc.text('TOTAL', colX.total, y + 6, { align: 'right', width: 75 });
}

function renderClassicTableRows(doc: any, items: PdfInvoice['items'], startY: number, colX: ReturnType<typeof classicColX>, lightGrey: string): number {
    let y = startY;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const rowH = item.description || item.inventoryItem ? 30 : 18;
        const bg = i % 2 === 0 ? lightGrey : '#FFFFFF';
        doc.rect(MARGIN, y - 2, CONTENT_WIDTH, rowH).fill(bg);
        doc.fontSize(8.5).fillColor('#111827').font('Helvetica-Bold')
            .text(truncate(item.name, 36), colX.name + 4, y);
        if (item.description) {
            doc.fontSize(7.5).fillColor('#6B7280').font('Helvetica')
                .text(truncate(item.description, 50), colX.name + 4, y + 11);
        }
        if (item.inventoryItem) {
            const invLabel = `SKU: ${item.inventoryItem.sku || '—'} · Unit: ${item.inventoryItem.unit}`;
            doc.fontSize(7).fillColor('#4B5563').text(invLabel, colX.name + 4, y + (item.description ? 20 : 11));
        }
        doc.fontSize(8.5).fillColor('#111827').font('Helvetica')
            .text(String(item.quantity), colX.qty, y, { width: 50, align: 'center' })
            .text(formatDecimal(item.unitPrice), colX.price, y)
            .text(formatDecimal(item.taxAmount), colX.tax, y)
            .text(formatDecimal(item.total), colX.total, y, { align: 'right', width: 75 });
        y += rowH + 2;
        if (y > 720) { doc.addPage(); y = 50; }
    }
    return y;
}

function renderTotals(
    doc: any, invoice: PdfInvoice, y: number,
    accent: string, dark: string, grey: string, startX: number
): number {
    const rightW = PAGE_WIDTH - MARGIN - startX;

    doc.fontSize(9).font('Helvetica');
    renderTotalRow(doc, 'Subtotal', formatDecimal(invoice.subtotal), startX, y, grey, dark, rightW);
    y += 18;

    if (new Decimal(invoice.discountAmount || 0).greaterThan(0)) {
        renderTotalRow(doc, 'Discount', `− ${formatDecimal(invoice.discountAmount)}`, startX, y, grey, '#DC2626', rightW);
        y += 18;
    }

    if (new Decimal(invoice.taxAmount || 0).greaterThan(0)) {
        renderTotalRow(doc, 'Tax', formatDecimal(invoice.taxAmount), startX, y, grey, dark, rightW);
        y += 18;
    }

    // Total highlight
    const totalBoxH = 24;
    doc.rect(startX - 4, y - 1, rightW + 4 + MARGIN, totalBoxH).fill(accent);
    doc.fontSize(11).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text('TOTAL', startX, y + 5)
        .text(`${invoice.currency} ${formatDecimal(invoice.totalAmount)}`, startX, y + 5, { align: 'right', width: rightW + MARGIN - 4 });
    y += totalBoxH + 8;

    if (new Decimal(invoice.amountPaid || 0).greaterThan(0)) {
        renderTotalRow(doc, 'Amount Paid', formatDecimal(invoice.amountPaid), startX, y, grey, '#16A34A', rightW);
        y += 18;
        doc.fontSize(10).fillColor(accent).font('Helvetica-Bold');
        renderTotalRow(doc, 'Amount Due', `${invoice.currency} ${formatDecimal(invoice.amountDue)}`, startX, y, accent, accent, rightW);
        y += 20;
    }

    return y;
}

function renderTotalRow(doc: any, label: string, value: string, x: number, y: number, labelColor: string, valueColor: string, width: number) {
    doc.fontSize(9).fillColor(labelColor).font('Helvetica').text(label + ':', x, y);
    doc.fontSize(9).fillColor(valueColor).font('Helvetica-Bold').text(value, x, y, { align: 'right', width: width + MARGIN - 4 });
}

function renderNotesTermsFooter(
    doc: any, invoice: PdfInvoice, settings: PdfSettings | null,
    y: number, grey: string, dark: string
): number {
    const notes = invoice.notes || settings?.defaultNotes;
    if (notes) {
        doc.fontSize(8).fillColor(grey).font('Helvetica-Bold').text('Notes', MARGIN, y);
        doc.fontSize(8).fillColor(dark).font('Helvetica').text(notes, MARGIN, y + 12, { width: CONTENT_WIDTH });
        y += 30 + Math.ceil(notes.length / 90) * 10;
    }

    const terms = settings?.defaultTerms;
    if (terms) {
        doc.fontSize(8).fillColor(grey).font('Helvetica-Bold').text('Terms & Conditions', MARGIN, y);
        doc.fontSize(8).fillColor(dark).font('Helvetica').text(terms, MARGIN, y + 12, { width: CONTENT_WIDTH });
        y += 30 + Math.ceil(terms.length / 90) * 10;
    }

    // Footer — always at bottom of page
    const footer = invoice.footer || settings?.defaultFooter;
    if (footer) {
        doc.fontSize(7.5).fillColor(grey).font('Helvetica')
            .text(footer, MARGIN, 800, { width: CONTENT_WIDTH, align: 'center' });
    }

    return y;
}

function renderPageNumbers(doc: any) {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fontSize(7).fillColor('#9CA3AF')
            .text(`Page ${i + 1} of ${range.count}`, MARGIN, 825, { align: 'right', width: CONTENT_WIDTH });
    }
}

function renderLabelValue(doc: any, label: string, value: string, x: number, y: number, accent: string) {
    doc.fontSize(7.5).fillColor(accent).font('Helvetica-Bold').text(label, x, y);
    doc.fontSize(9.5).fillColor('#111827').font('Helvetica').text(value, x, y + 10);
}

function renderMetaPill(doc: any, label: string, value: string, x: number, y: number, accent: string, dark: string) {
    doc.rect(x, y, 200, 28).fill('#F8FAFC');
    doc.rect(x, y, 4, 28).fill(accent);
    doc.fontSize(7).fillColor(accent).font('Helvetica-Bold').text(label, x + 10, y + 5);
    doc.fontSize(9.5).fillColor(dark).font('Helvetica-Bold').text(value, x + 10, y + 15);
}

function renderContemporaryField(doc: any, label: string, value: string, x: number, y: number, labelColor: string, dark: string) {
    doc.fontSize(7.5).fillColor(labelColor).font('Helvetica').text(label, x, y);
    doc.fontSize(10).fillColor(dark).font('Helvetica-Bold').text(value, x, y + 10);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── UTILITIES ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function formatDecimal(value: any): string {
    if (value === null || value === undefined) return '0.00';
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? '0.00' : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: Date | string): string {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
}

function formatAddress(addr: Record<string, any>): string {
    if (typeof addr === 'string') return addr;
    return [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country]
        .filter(Boolean).join(', ');
}

function statusToColor(status: string): string {
    switch (status?.toUpperCase()) {
        case 'PAID': return '#16A34A';
        case 'PARTIALLY_PAID': return '#D97706';
        case 'OVERDUE': return '#DC2626';
        case 'VOID': return '#6B7280';
        case 'SENT': return '#2563EB';
        default: return '#9CA3AF';
    }
}

/**
 * Fetch a URL and return its content as a Buffer.
 * Supports both http and https. Rejects on non-2xx or network error.
 */
function fetchUrlBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}
