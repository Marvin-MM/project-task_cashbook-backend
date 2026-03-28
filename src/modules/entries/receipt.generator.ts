import PDFDocument from 'pdfkit';
import https from 'https';
import http from 'http';

// ─── Constants ──────────────────────────────────────────────────────────────
const FALLBACK_LOGO_URL = 'https://inchange.odixtec.net/logo.png';
const PAGE_WIDTH        = 595.28;   // A4 points
const PAGE_HEIGHT       = 841.89;
const MARGIN            = 48;
const CONTENT_WIDTH     = PAGE_WIDTH - MARGIN * 2;
const FOOTER_Y          = PAGE_HEIGHT - 52;

// ─── Shared palette ─────────────────────────────────────────────────────────
const P = {
    white:     '#FFFFFF',
    dark:      '#111827',
    midGrey:   '#6B7280',
    lightGrey: '#F8F9FB',
    lineGrey:  '#E5E7EB',
    green:     '#16A34A',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────
export interface PdfReceipt {
    receiptNumber:  string;
    paymentDate:    Date | string;
    amountPaid:     any;
    currency:       string;
    paymentMode?:   { name: string } | null;
    reference?:     string | null;
    obligation: {
        title:             string;
        totalAmount:       any;
        outstandingAmount: any;
    };
    customer: {
        name:     string;
        email?:   string | null;
        phone?:   string | null;
        company?: string | null;
        customerProfile?: {
            billingAddress?: any;
            taxId?:          string | null;
            currency?:       string | null;
        } | null;
    };
}

export interface PdfSettings {
    logoUrl?:       string | null;
    accentColor?:   string | null;
    template?:      string | null;
    defaultFooter?: string | null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a receipt PDF in-memory (ephemeral — never stored on disk).
 *
 * Templates:
 *   'classic'       → dark header band, centered summary card, stamp badge
 *   'modern'        → bold accent header, flowing detail rows, large amount hero
 *   'contemporary'  → thin accent bar, centered card layout, editorial typography
 */
export async function generateReceiptPdf(
    receipt:      PdfReceipt,
    businessName: string,
    settings:     PdfSettings | null,
): Promise<Buffer> {
    // FIX: async work happens OUTSIDE the Promise constructor to avoid
    //      the "async Promise executor" antipattern and silent error swallowing.
    const accent   = settings?.accentColor ?? '#4F46E5';
    const template = settings?.template    ?? 'classic';
    const logoUrl  = settings?.logoUrl     ?? FALLBACK_LOGO_URL;

    const logoBuffer = await fetchUrlBuffer(logoUrl)
        .catch(() => fetchUrlBuffer(FALLBACK_LOGO_URL).catch(() => null));

    // FIX: bufferPages:true required for page number rendering via switchToPage()
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size:          'A4',
                margin:        MARGIN,
                compress:      true,
                bufferPages:   true,
                autoFirstPage: true,
                info: {
                    Title:   `Receipt ${receipt.receiptNumber}`,
                    Author:  businessName,
                    Creator: 'InChange PDF Engine',
                },
            });

            const chunks: Buffer[] = [];
            doc.on('data',  (c: Buffer) => chunks.push(c));
            doc.on('end',   () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            switch (template) {
                case 'modern':
                    renderModern(doc, receipt, settings, businessName, accent, logoBuffer);
                    break;
                case 'contemporary':
                    renderContemporary(doc, receipt, settings, businessName, accent, logoBuffer);
                    break;
                default:
                    renderClassic(doc, receipt, settings, businessName, accent, logoBuffer);
            }

            renderSharedFooter(doc, settings, logoBuffer);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: CLASSIC
// Dark header band · two-column info row · centered summary card · stamp badge
// ══════════════════════════════════════════════════════════════════════════════

function renderClassic(
    doc:          InstanceType<typeof PDFDocument>,
    receipt:      PdfReceipt,
    settings:     PdfSettings | null,
    businessName: string,
    accent:       string,
    logo:         Buffer | null,
) {
    // ── Header band ─────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_WIDTH, 115).fill(P.dark);

    let logoRendered = false;
    if (logo) {
        try {
            doc.image(logo, MARGIN, 20, { height: 48, fit: [150, 48] });
            logoRendered = true;
        } catch { }
    }
    if (!logoRendered) {
        doc.fontSize(19).fillColor(P.white).font('Helvetica-Bold')
            .text(businessName, MARGIN, 26, { width: 260 });
    }

    doc.fontSize(8).fillColor(accent).font('Helvetica-Bold')
        .text('PAYMENT RECEIPT', MARGIN, 30, { align: 'right', width: CONTENT_WIDTH });
    doc.fontSize(18).fillColor(P.white).font('Helvetica-Bold')
        .text(safeReceiptNumber(receipt.receiptNumber), MARGIN, 44, { align: 'right', width: CONTENT_WIDTH });

    // ── Two-column info row ──────────────────────────────────────────────────
    let y = 135;

    // Left — customer
    doc.fontSize(7).fillColor(P.midGrey).font('Helvetica-Bold')
        .text('RECEIVED FROM', MARGIN, y);
    doc.fontSize(11).fillColor(P.dark).font('Helvetica-Bold')
        .text(receipt.customer.name, MARGIN, y + 13);

    let leftY = y + 28;
    for (const line of customerLines(receipt)) {
        doc.fontSize(8.5).fillColor(P.midGrey).font('Helvetica')
            .text(line, MARGIN, leftY, { width: 220 });
        leftY += doc.heightOfString(line, { width: 220 }) + 3;
    }

    // Right — payment meta
    const metaX = PAGE_WIDTH - MARGIN - 185;
    renderLabelValue(doc, 'Payment Date',   fmtDate(receipt.paymentDate),     metaX, y,      accent);
    renderLabelValue(doc, 'Payment Method', receipt.paymentMode?.name ?? '—', metaX, y + 26, accent);
    if (receipt.reference) {
        renderLabelValue(doc, 'Reference', receipt.reference, metaX, y + 52, accent);
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    y = Math.max(leftY, y + 80) + 16;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .strokeColor(P.lineGrey).lineWidth(0.5).stroke();

    // ── Summary card ─────────────────────────────────────────────────────────
    y += 18;
    const cardH    = 158;
    const isPaidOff = toNumber(receipt.obligation.outstandingAmount) <= 0;

    doc.rect(MARGIN, y, CONTENT_WIDTH, cardH).fill(P.lightGrey);

    // Card title + badge
    doc.fontSize(11).fillColor(P.dark).font('Helvetica-Bold')
        .text('Payment Summary', MARGIN + 20, y + 18);
    if (isPaidOff) renderPaidBadge(doc, PAGE_WIDTH - MARGIN - 125, y + 10);

    // Applied to
    renderSummaryRow(doc, 'Applied To',       receipt.obligation.title,                                             MARGIN + 20, y + 46, P.midGrey, P.dark,  260);
    renderSummaryRow(doc, 'Original Amount',  `${receipt.currency} ${formatDecimal(receipt.obligation.totalAmount)}`, MARGIN + 20, y + 72, P.midGrey, P.dark);
    renderSummaryRow(doc, 'Amount Paid',      `${receipt.currency} ${formatDecimal(receipt.amountPaid)}`,              MARGIN + 20, y + 98, P.midGrey, P.green, undefined, true);

    // Remaining balance highlight
    const remColor = isPaidOff ? P.green : P.dark;
    renderSummaryRow(doc, 'Remaining Balance', `${receipt.currency} ${formatDecimal(receipt.obligation.outstandingAmount)}`, MARGIN + 20, y + 124, P.midGrey, remColor);

    y += cardH + 20;

    // ── Amount hero ───────────────────────────────────────────────────────────
    renderAmountHero(doc, receipt, y, accent);
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: MODERN
// Full-width accent header · flowing detail row · large amount hero card
// ══════════════════════════════════════════════════════════════════════════════

function renderModern(
    doc:          InstanceType<typeof PDFDocument>,
    receipt:      PdfReceipt,
    settings:     PdfSettings | null,
    businessName: string,
    accent:       string,
    logo:         Buffer | null,
) {
    // ── Header ───────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_WIDTH, 130).fill(accent);

    let logoRendered = false;
    if (logo) {
        try {
            doc.image(logo, MARGIN, 26, { height: 46, fit: [150, 46] });
            logoRendered = true;
        } catch { }
    }
    if (!logoRendered) {
        doc.fontSize(21).fillColor(P.white).font('Helvetica-Bold')
            .text(businessName, MARGIN, 32, { width: 270 });
    }

    // Ghost watermark + number
    doc.fontSize(30).fillColor('rgba(255,255,255,0.15)').font('Helvetica-Bold')
        .text('RECEIPT', MARGIN, 70, { align: 'right', width: CONTENT_WIDTH });
    doc.fontSize(13).fillColor(P.white).font('Helvetica-Bold')
        .text(safeReceiptNumber(receipt.receiptNumber), MARGIN, 78, { align: 'right', width: CONTENT_WIDTH });

    // ── Payment detail pills row ─────────────────────────────────────────────
    let y      = 150;
    const metaX = PAGE_WIDTH - MARGIN - 205;
    renderMetaPill(doc, 'DATE',   fmtDate(receipt.paymentDate),     metaX, y,      accent, P.dark);
    renderMetaPill(doc, 'METHOD', receipt.paymentMode?.name ?? '—', metaX, y + 36, accent, P.dark);
    if (receipt.reference) {
        renderMetaPill(doc, 'REF', receipt.reference, metaX, y + 72, accent, P.dark);
    }

    // Customer block
    doc.fontSize(7).fillColor(accent).font('Helvetica-Bold').text('PAID BY', MARGIN, y);
    doc.fontSize(11).fillColor(P.dark).font('Helvetica-Bold')
        .text(receipt.customer.name, MARGIN, y + 13);

    let leftY = y + 29;
    for (const line of customerLines(receipt)) {
        doc.fontSize(8.5).fillColor(P.midGrey).font('Helvetica')
            .text(line, MARGIN, leftY, { width: 220 });
        leftY += doc.heightOfString(line, { width: 220 }) + 3;
    }

    // ── Summary card ─────────────────────────────────────────────────────────
    y = Math.max(leftY, y + 120) + 18;
    const isPaidOff = toNumber(receipt.obligation.outstandingAmount) <= 0;
    const cardH     = 156;

    doc.rect(MARGIN, y, CONTENT_WIDTH, cardH).fill('#F9FAFB');
    // Left accent bar on card
    doc.rect(MARGIN, y, 4, cardH).fill(accent);

    doc.fontSize(10).fillColor(P.dark).font('Helvetica-Bold')
        .text('Applied to:', MARGIN + 18, y + 16);
    doc.fontSize(10).fillColor(P.midGrey).font('Helvetica')
        .text(receipt.obligation.title, MARGIN + 100, y + 16, { width: CONTENT_WIDTH - 120 });

    if (isPaidOff) renderPaidBadge(doc, PAGE_WIDTH - MARGIN - 125, y + 10);

    renderSummaryRow(doc, 'Original Amount',  `${receipt.currency} ${formatDecimal(receipt.obligation.totalAmount)}`,       MARGIN + 18, y + 46,  P.midGrey, P.dark);
    renderSummaryRow(doc, 'Amount Received',  `${receipt.currency} ${formatDecimal(receipt.amountPaid)}`,                   MARGIN + 18, y + 76,  P.midGrey, P.green, undefined, true);

    const remColor = isPaidOff ? P.green : P.dark;
    renderSummaryRow(doc, 'Remaining Balance', `${receipt.currency} ${formatDecimal(receipt.obligation.outstandingAmount)}`, MARGIN + 18, y + 106, P.midGrey, remColor);

    y += cardH + 22;

    // ── Amount hero ───────────────────────────────────────────────────────────
    renderAmountHero(doc, receipt, y, accent);
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: CONTEMPORARY
// Thin accent top bar · centered card layout · line-separated rows
// ══════════════════════════════════════════════════════════════════════════════

function renderContemporary(
    doc:          InstanceType<typeof PDFDocument>,
    receipt:      PdfReceipt,
    settings:     PdfSettings | null,
    businessName: string,
    accent:       string,
    logo:         Buffer | null,
) {
    const ink      = '#1C1C1E';
    const muted    = '#8E8E93';
    const hairline = '#E5E5EA';

    // ── Thin top accent bar ──────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_WIDTH, 5).fill(accent);

    // Logo OR business name
    let logoRendered = false;
    if (logo) {
        try {
            doc.image(logo, MARGIN, 26, { height: 38, fit: [120, 38] });
            logoRendered = true;
        } catch { }
    }
    if (!logoRendered) {
        doc.fontSize(17).fillColor(ink).font('Helvetica-Bold')
            .text(businessName, MARGIN, 30, { width: 260 });
    }

    // Right: label + number
    doc.fontSize(8.5).fillColor(muted).font('Helvetica')
        .text('Receipt', MARGIN, 30, { align: 'right', width: CONTENT_WIDTH });
    doc.fontSize(14).fillColor(ink).font('Helvetica-Bold')
        .text(safeReceiptNumber(receipt.receiptNumber), MARGIN, 43, { align: 'right', width: CONTENT_WIDTH });

    // Hairline
    doc.moveTo(MARGIN, 80).lineTo(PAGE_WIDTH - MARGIN, 80)
        .lineWidth(0.5).strokeColor(hairline).stroke();

    // ── Customer + meta row ──────────────────────────────────────────────────
    let y = 96;

    doc.fontSize(7).fillColor(muted).font('Helvetica-Bold').text('RECEIVED FROM', MARGIN, y);
    doc.fontSize(11).fillColor(ink).font('Helvetica-Bold')
        .text(receipt.customer.name, MARGIN, y + 14);

    let leftY = y + 30;
    for (const line of customerLines(receipt)) {
        doc.fontSize(8.5).fillColor(muted).font('Helvetica')
            .text(line, MARGIN, leftY, { width: 220 });
        leftY += doc.heightOfString(line, { width: 220 }) + 3;
    }

    const dX      = PAGE_WIDTH - MARGIN - 185;
    const fldGap  = 28;
    renderContemporaryField(doc, 'Date',   fmtDate(receipt.paymentDate),     dX, y,              muted, ink);
    renderContemporaryField(doc, 'Method', receipt.paymentMode?.name ?? '—', dX, y + fldGap,     muted, ink);
    if (receipt.reference) {
        renderContemporaryField(doc, 'Reference', receipt.reference, dX, y + fldGap * 2, muted, ink);
    }

    // ── Summary rows ─────────────────────────────────────────────────────────
    y = Math.max(leftY, y + 90) + 16;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .lineWidth(0.5).strokeColor(hairline).stroke();

    const isPaidOff = toNumber(receipt.obligation.outstandingAmount) <= 0;

    // Applied to
    y += 14;
    doc.fontSize(8).fillColor(muted).font('Helvetica-Bold').text('APPLIED TO', MARGIN, y);
    doc.fontSize(10).fillColor(ink).font('Helvetica-Bold')
        .text(receipt.obligation.title, MARGIN, y + 12, { width: CONTENT_WIDTH });
    y += 30;

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .lineWidth(0.5).strokeColor(hairline).stroke();
    y += 14;

    // Original
    doc.fontSize(9).fillColor(muted).font('Helvetica').text('Total Obligation', MARGIN, y);
    doc.fontSize(9).fillColor(ink).font('Helvetica-Bold')
        .text(`${receipt.currency} ${formatDecimal(receipt.obligation.totalAmount)}`, MARGIN, y, { align: 'right', width: CONTENT_WIDTH });
    y += 24;

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .lineWidth(0.5).strokeColor(hairline).stroke();
    y += 14;

    // Amount paid — hero row
    doc.fontSize(11).fillColor(accent).font('Helvetica-Bold').text('AMOUNT PAID', MARGIN, y);
    doc.fontSize(13).fillColor(P.green).font('Helvetica-Bold')
        .text(`${receipt.currency} ${formatDecimal(receipt.amountPaid)}`, MARGIN, y, { align: 'right', width: CONTENT_WIDTH });
    y += 30;

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .lineWidth(0.5).strokeColor(hairline).stroke();
    y += 14;

    // Remaining
    const remColor = isPaidOff ? P.green : ink;
    doc.fontSize(9).fillColor(muted).font('Helvetica').text('Remaining Balance', MARGIN, y);
    doc.fontSize(9).fillColor(remColor).font('Helvetica-Bold')
        .text(`${receipt.currency} ${formatDecimal(receipt.obligation.outstandingAmount)}`, MARGIN, y, { align: 'right', width: CONTENT_WIDTH });
    y += 28;

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
        .lineWidth(0.5).strokeColor(hairline).stroke();
    y += 24;

    // PAID badge (if fully settled)
    if (isPaidOff) {
        renderPaidBadge(doc, (PAGE_WIDTH - 120) / 2, y);
        y += 60;
    }

    // ── Amount hero ───────────────────────────────────────────────────────────
    renderAmountHero(doc, receipt, y, accent);
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED SECTION RENDERERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Large centred amount display block — the visual hero of every receipt.
 * Shows the payment amount prominently with accent underline.
 */
function renderAmountHero(
    doc:     any,
    receipt: PdfReceipt,
    y:       number,
    accent:  string,
) {
    const boxH   = 68;
    const label  = `${receipt.currency} ${formatDecimal(receipt.amountPaid)}`;

    doc.rect(MARGIN, y, CONTENT_WIDTH, boxH).fill(accent);

    doc.fontSize(10).fillColor('rgba(255,255,255,0.65)').font('Helvetica-Bold')
        .text('TOTAL AMOUNT PAID', MARGIN, y + 12, { align: 'center', width: CONTENT_WIDTH });
    doc.fontSize(22).fillColor(P.white).font('Helvetica-Bold')
        .text(label, MARGIN, y + 28, { align: 'center', width: CONTENT_WIDTH });
}

/**
 * FIX: renderPaidBadge now correctly uses doc.save()/restore() with
 * translate-then-rotate so the internal coordinates are local (0,0-based),
 * eliminating the broken absolute-position text inside a rotated CTM.
 */
function renderPaidBadge(doc: any, x: number, y: number) {
    doc.save();
    // Move origin to badge centre, rotate, then draw around (0,0)
    doc.translate(x + 55, y + 18).rotate(-14);

    const w = 110, h = 36, r = 6;
    doc.roundedRect(-w / 2, -h / 2, w, h, r)
        .lineWidth(2.5)
        .strokeColor(P.green)
        .stroke();

    doc.fontSize(13).fillColor(P.green).font('Helvetica-Bold')
        .text('PAID IN FULL', -w / 2, -8, { align: 'center', width: w });

    doc.restore();
}

/**
 * Shared footer: custom footer text + "Powered by" branding line.
 * Pinned to FOOTER_Y so it never overlaps content regardless of page length.
 */
function renderSharedFooter(
    doc:      any,
    settings: PdfSettings | null,
    logo:     Buffer | null,
) {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);

        // Thin top rule above footer zone
        doc.moveTo(MARGIN, FOOTER_Y - 14)
            .lineTo(PAGE_WIDTH - MARGIN, FOOTER_Y - 14)
            .strokeColor(P.lineGrey).lineWidth(0.5).stroke();

        // Custom footer text
        if (settings?.defaultFooter) {
            doc.fontSize(8).fillColor(P.midGrey).font('Helvetica')
                .text(settings.defaultFooter, MARGIN, FOOTER_Y, {
                    align: 'center', width: CONTENT_WIDTH,
                });
        }

        // "Powered by" line
        const appName  = process.env.APP_NAME ?? 'ODIN Cashbook';
        const pwrText  = `Powered by ${appName}`;
        const pwrY     = FOOTER_Y + (settings?.defaultFooter ? 16 : 2);

        doc.fontSize(7.5).fillColor('#9CA3AF').font('Helvetica')
            .text(pwrText, MARGIN, pwrY, { align: 'center', width: CONTENT_WIDTH });

        // Page number (right-aligned)
        doc.fontSize(7).fillColor('#9CA3AF')
            .text(`Page ${i + 1} of ${range.count}`, MARGIN, pwrY, {
                align: 'right', width: CONTENT_WIDTH,
            });
    }
}

// ── Minor field / row renderers ──────────────────────────────────────────────

function renderLabelValue(doc: any, label: string, value: string, x: number, y: number, accent: string) {
    doc.fontSize(7).fillColor(accent).font('Helvetica-Bold').text(label, x, y);
    doc.fontSize(9.5).fillColor(P.dark).font('Helvetica').text(value, x, y + 11);
}

function renderMetaPill(
    doc:    any,
    label:  string,
    value:  string,
    x:      number,
    y:      number,
    accent: string,
    dark:   string,
) {
    doc.rect(x, y, 205, 30).fill('#F8FAFC');
    doc.rect(x, y, 4,   30).fill(accent);
    doc.fontSize(6.5).fillColor(accent).font('Helvetica-Bold').text(label, x + 10, y + 6);
    doc.fontSize(9.5).fillColor(dark).font('Helvetica-Bold')  .text(value, x + 10, y + 17);
}

function renderContemporaryField(
    doc:        any,
    label:      string,
    value:      string,
    x:          number,
    y:          number,
    labelColor: string,
    dark:       string,
) {
    doc.fontSize(7).fillColor(labelColor).font('Helvetica').text(label, x, y);
    doc.fontSize(10).fillColor(dark).font('Helvetica-Bold')  .text(value, x, y + 11);
}

/**
 * Two-column label: value row used inside summary cards.
 * `bold` makes the value larger — used for Amount Paid row.
 */
function renderSummaryRow(
    doc:        any,
    label:      string,
    value:      string,
    x:          number,
    y:          number,
    labelColor: string,
    valueColor: string,
    labelWidth?: number,
    bold        = false,
) {
    const valX  = x + (labelWidth ?? 160);
    const fSize = bold ? 10 : 9;

    doc.fontSize(9).fillColor(labelColor).font('Helvetica').text(`${label}:`, x, y);
    doc.fontSize(fSize).fillColor(valueColor)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(value, valX, bold ? y - 0.5 : y);
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

/** Build ordered list of non-null customer detail lines */
function customerLines(receipt: PdfReceipt): string[] {
    const profile = receipt.customer.customerProfile;
    return [
        receipt.customer.company,
        receipt.customer.email,
        receipt.customer.phone,
        profile?.billingAddress ? formatAddress(profile.billingAddress) : null,
        profile?.taxId          ? `Tax ID: ${profile.taxId}`            : null,
    ].filter((l): l is string => !!l);
}

/**
 * FIX: receipt number is no longer silently truncated.
 * Prefix is always shown; if the number is a long UUID we show the
 * first segment only, clearly marked with an ellipsis.
 */
function safeReceiptNumber(n: string): string {
    const safe = n.length > 12 ? `${n.substring(0, 12)}…` : n;
    return `RC-${safe}`;
}

/** FIX: explicit 'en-US' locale so server locale doesn't affect output */
function formatDecimal(value: any): string {
    if (value === null || value === undefined) return '0.00';
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num)
        ? '0.00'
        : num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toNumber(value: any): number {
    const n = Number(value ?? 0);
    return isNaN(n) ? 0 : n;
}

function fmtDate(d: Date | string): string {
    return new Date(d).toLocaleDateString('en-GB', {
        day:   '2-digit',
        month: 'short',
        year:  'numeric',
    });
}

function formatAddress(addr: Record<string, any> | string): string {
    if (typeof addr === 'string') return addr;
    return [addr.line1, addr.line2, addr.city, addr.state, addr.zip, addr.country]
        .filter(Boolean).join(', ');
}

/**
 * FIX: added req.on('error') so TCP-level failures reject cleanly
 * instead of hanging the promise indefinitely.
 */
function fetchUrlBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req    = client.get(url, (res) => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            }
            const chunks: Buffer[] = [];
            res.on('data',  (c: Buffer) => chunks.push(c));
            res.on('end',   () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}