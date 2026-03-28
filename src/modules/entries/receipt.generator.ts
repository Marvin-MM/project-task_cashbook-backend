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
export interface PdfReceipt {
    receiptNumber: string;
    paymentDate: Date | string;
    amountPaid: any;
    currency: string;
    paymentMode?: { name: string } | null;
    reference?: string | null;
    obligation: {
        title: string;
        totalAmount: any;
        outstandingAmount: any;
    };
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
}

export interface PdfSettings {
    logoUrl?: string | null;
    accentColor?: string | null;
    template?: string | null;
    defaultFooter?: string | null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function generateReceiptPdf(
    receipt: PdfReceipt,
    businessName: string,
    settings: PdfSettings | null,
): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: MARGIN,
                autoFirstPage: false,
            });

            const buffers: Buffer[] = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));

            // Fetch Logo
            let logoBuffer: Buffer | null = null;
            const targetLogo = settings?.logoUrl || FALLBACK_LOGO_URL;
            try {
                logoBuffer = await fetchUrlBuffer(targetLogo);
            } catch (err) {
                // If custom logo fails, try fallback
                if (targetLogo !== FALLBACK_LOGO_URL) {
                    try { logoBuffer = await fetchUrlBuffer(FALLBACK_LOGO_URL); } catch { /* ignore */ }
                }
            }

            // Setup
            doc.addPage();
            const accent = settings?.accentColor || '#4F46E5';
            const template = settings?.template || 'classic';

            // Route to correct template
            if (template === 'modern') {
                renderModern(doc, receipt, settings, businessName, accent, logoBuffer);
            } else if (template === 'contemporary') {
                renderContemporary(doc, receipt, settings, businessName, accent, logoBuffer);
            } else {
                renderClassic(doc, receipt, settings, businessName, accent, logoBuffer);
            }

            // Footer (Powered by + Custom Footer)
            const rootFooterY = doc.page.height - 80;
            if (settings?.defaultFooter) {
                doc.fontSize(8).fillColor('#6B7280').text(settings.defaultFooter, MARGIN, rootFooterY - 15, { align: 'center', width: CONTENT_WIDTH });
            }
            try {
                // Try rendering the platform logo in the footer (requires the fallback buffer)
                let platformLogo = targetLogo === FALLBACK_LOGO_URL ? logoBuffer : null;
                if (!platformLogo) { platformLogo = await fetchUrlBuffer(FALLBACK_LOGO_URL).catch(() => null); }
                if (platformLogo) {
                    doc.image(platformLogo, (PAGE_WIDTH - 60) / 2, rootFooterY + 5, { width: 60 });
                }
            } catch { /* ignore */ }
            doc.fontSize(8).fillColor('#9CA3AF')
                .text('Powered by ODIN Cashbook', MARGIN, rootFooterY + 25, { align: 'center', width: CONTENT_WIDTH });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: CLASSIC ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function renderClassic(
    doc: InstanceType<typeof PDFDocument>,
    receipt: PdfReceipt,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const lightGrey = '#F8F9FB';
    const dark = '#111827';

    // Header band
    doc.rect(0, 0, PAGE_WIDTH, 110).fill(dark);

    if (logo) {
        try { doc.image(logo, MARGIN, 18, { height: 45, fit: [140, 45] }); } catch { }
    }

    doc.fontSize(18).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(businessName, MARGIN, 22, { width: 250 });

    doc.fontSize(9).fillColor(accent).font('Helvetica-Bold')
        .text('PAYMENT RECEIPT', 0, 28, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.fontSize(20).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(`RC-${receipt.receiptNumber.substring(0, 8)}`, 0, 40, { align: 'right', width: PAGE_WIDTH - MARGIN });

    // Customer & Business Info
    doc.fontSize(10).fillColor('#6B7280').font('Helvetica-Bold').text('RECEIVED FROM:', MARGIN, 140);
    doc.fillColor('#111827').text(receipt.customer.name, MARGIN, 155);
    if (receipt.customer.company) doc.font('Helvetica').text(receipt.customer.company, MARGIN, 170);
    
    doc.fillColor('#6B7280').font('Helvetica-Bold').text('PAYMENT DATE:', 350, 140);
    doc.fillColor('#111827').font('Helvetica').text(fmtDate(receipt.paymentDate), 350, 155);

    if (receipt.paymentMode?.name) {
        doc.fillColor('#6B7280').font('Helvetica-Bold').text('PAYMENT METHOD:', 350, 180);
        doc.fillColor('#111827').font('Helvetica').text(receipt.paymentMode.name, 350, 195);
    }

    // Payment Details Box
    doc.rect(MARGIN, 240, CONTENT_WIDTH, 140).fill(lightGrey);
    doc.fontSize(14).fillColor(dark).font('Helvetica-Bold')
        .text('Payment Summary', MARGIN + 20, 260);

    doc.fontSize(11).fillColor('#6B7280').font('Helvetica')
        .text('Applied To:', MARGIN + 20, 290)
        .fillColor(dark).font('Helvetica-Bold')
        .text(receipt.obligation.title, MARGIN + 120, 290);
    
    doc.fillColor('#6B7280').font('Helvetica')
        .text('Original Amount:', MARGIN + 20, 315)
        .fillColor(dark)
        .text(`${receipt.currency} ${formatDecimal(receipt.obligation.totalAmount)}`, MARGIN + 120, 315);

    doc.fillColor('#6B7280').font('Helvetica')
        .text('Amount Paid:', MARGIN + 20, 340)
        .fillColor('#16A34A').font('Helvetica-Bold')
        .text(`${receipt.currency} ${formatDecimal(receipt.amountPaid)}`, MARGIN + 120, 340);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: MODERN ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function renderModern(
    doc: InstanceType<typeof PDFDocument>,
    receipt: PdfReceipt,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const dark = '#1F2937';

    doc.rect(0, 0, PAGE_WIDTH, 120).fill(accent);
    
    if (logo) {
        try { doc.image(logo, MARGIN, 30, { height: 50, fit: [150, 50] }); } catch { }
    }
    doc.fontSize(22).fillColor('#FFFFFF').font('Helvetica-Bold').text(businessName, MARGIN, 35);
    
    doc.fontSize(28).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text('RECEIPT', 0, 30, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.fontSize(12).fillColor('rgba(255,255,255,0.8)').font('Helvetica')
        .text(`# RC-${receipt.receiptNumber.substring(0, 8)}`, 0, 65, { align: 'right', width: PAGE_WIDTH - MARGIN });

    // Details Flow
    let y = 160;
    doc.fontSize(12).fillColor(accent).font('Helvetica-Bold').text('PAYMENT DETAILS', MARGIN, y);
    doc.moveTo(MARGIN, y + 20).lineTo(PAGE_WIDTH - MARGIN, y + 20).strokeColor('#E5E7EB').stroke();
    
    y += 40;
    doc.fontSize(10).fillColor('#6B7280').font('Helvetica-Bold').text('PAID BY', MARGIN, y);
    doc.fillColor(dark).font('Helvetica-Bold').text(receipt.customer.name, MARGIN, y + 15);
    
    doc.fillColor('#6B7280').font('Helvetica-Bold').text('DATE', 250, y);
    doc.fillColor(dark).font('Helvetica').text(fmtDate(receipt.paymentDate), 250, y + 15);

    if (receipt.paymentMode?.name) {
        doc.fillColor('#6B7280').font('Helvetica-Bold').text('METHOD', 400, y);
        doc.fillColor(dark).font('Helvetica').text(receipt.paymentMode.name, 400, y + 15);
    }

    // Amount Box
    y += 80;
    doc.rect(MARGIN, y, CONTENT_WIDTH, 100).fill('#F9FAFB');
    doc.fontSize(12).fillColor(dark).font('Helvetica-Bold').text('Applied To:', MARGIN + 20, y + 25);
    doc.font('Helvetica').text(receipt.obligation.title, MARGIN + 120, y + 25);
    
    doc.fontSize(16).fillColor('#16A34A').font('Helvetica-Bold').text('Amount Received:', MARGIN + 20, y + 60);
    doc.fontSize(20).text(`${receipt.currency} ${formatDecimal(receipt.amountPaid)}`, MARGIN + 180, y + 56);
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── TEMPLATE: CONTEMPORARY ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function renderContemporary(
    doc: InstanceType<typeof PDFDocument>,
    receipt: PdfReceipt,
    settings: PdfSettings | null,
    businessName: string,
    accent: string,
    logo: Buffer | null,
) {
    const dark = '#111827';
    doc.rect(0, 0, PAGE_WIDTH, 8).fill(accent);

    if (logo) {
        try { doc.image(logo, MARGIN, 40, { height: 40, fit: [140, 40] }); } catch { }
    }
    doc.fontSize(20).fillColor(dark).font('Times-Bold').text(businessName, MARGIN, 45);

    doc.fontSize(24).fillColor(accent).font('Times-Roman')
        .text('R E C E I P T', 0, 40, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.fontSize(11).fillColor('#6B7280').font('Times-Roman')
        .text(`No. RC-${receipt.receiptNumber.substring(0, 8)}`, 0, 70, { align: 'right', width: PAGE_WIDTH - MARGIN });
    doc.text(`Date. ${fmtDate(receipt.paymentDate)}`, 0, 85, { align: 'right', width: PAGE_WIDTH - MARGIN });

    doc.moveTo(MARGIN, 130).lineTo(PAGE_WIDTH - MARGIN, 130).lineWidth(0.5).strokeColor('#E5E7EB').stroke();

    doc.fontSize(10).fillColor('#9CA3AF').font('Times-Roman').text('Payment From', MARGIN, 150);
    doc.fontSize(14).fillColor(dark).font('Times-Bold').text(receipt.customer.name, MARGIN, 170);

    // Summary
    doc.fontSize(14).fillColor(dark).font('Times-Bold').text('Payment Applied To:', MARGIN, 240);
    doc.fontSize(12).font('Times-Roman').text(receipt.obligation.title, MARGIN, 260);

    const boxY = 300;
    doc.moveTo(MARGIN, boxY).lineTo(PAGE_WIDTH - MARGIN, boxY).lineWidth(0.5).strokeColor('#E5E7EB').stroke();
    doc.fontSize(12).fillColor('#6B7280').font('Times-Bold').text('Total Obligation Amount', MARGIN, boxY + 20);
    doc.fillColor(dark).text(`${receipt.currency} ${formatDecimal(receipt.obligation.totalAmount)}`, 0, boxY + 20, { align: 'right', width: PAGE_WIDTH - MARGIN });

    doc.moveTo(MARGIN, boxY + 50).lineTo(PAGE_WIDTH - MARGIN, boxY + 50).lineWidth(0.5).strokeColor('#E5E7EB').stroke();
    doc.fontSize(14).fillColor(accent).font('Times-Bold').text('AMOUNT PAID', MARGIN, boxY + 70);
    doc.fillColor('#16A34A').text(`${receipt.currency} ${formatDecimal(receipt.amountPaid)}`, 0, boxY + 70, { align: 'right', width: PAGE_WIDTH - MARGIN });

    doc.moveTo(MARGIN, boxY + 100).lineTo(PAGE_WIDTH - MARGIN, boxY + 100).lineWidth(0.5).strokeColor('#E5E7EB').stroke();
    doc.fontSize(11).fillColor('#6B7280').font('Times-Roman').text('Remaining Balance', MARGIN, boxY + 120);
    doc.fillColor(dark).text(`${receipt.currency} ${formatDecimal(receipt.obligation.outstandingAmount)}`, 0, boxY + 120, { align: 'right', width: PAGE_WIDTH - MARGIN });
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
