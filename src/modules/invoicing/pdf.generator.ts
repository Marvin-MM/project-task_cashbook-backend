import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Generate an invoice PDF document in-memory (ephemeral — never stored).
 * Returns a Buffer that can be attached to an email.
 */
export async function generateInvoicePdf(
    invoice: any,
    settings: any,
    businessName: string,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const accentColor = settings?.accentColor || '#4F46E5';

            // ─── Header ────────────────────────────────────
            doc.fontSize(24).fillColor(accentColor).text(businessName, 50, 50);
            doc.fontSize(10).fillColor('#666666').text('INVOICE', 400, 50, { align: 'right' });
            doc.fontSize(18).fillColor('#333333').text(invoice.invoiceNumber, 400, 65, { align: 'right' });

            doc.moveDown(2);

            // ─── Invoice Details ───────────────────────────
            const detailsY = 120;
            doc.fontSize(10).fillColor('#333333');
            doc.text(`Issue Date: ${new Date(invoice.issueDate).toLocaleDateString()}`, 50, detailsY);
            doc.text(`Due Date: ${new Date(invoice.dueDate).toLocaleDateString()}`, 50, detailsY + 15);
            doc.text(`Currency: ${invoice.currency}`, 50, detailsY + 30);
            doc.text(`Status: ${invoice.status}`, 50, detailsY + 45);

            // ─── Customer Info ─────────────────────────────
            doc.fontSize(10).fillColor('#888888').text('BILL TO', 350, detailsY);
            doc.fontSize(11).fillColor('#333333').text(invoice.customer?.name || 'Customer', 350, detailsY + 15);
            if (invoice.customer?.email) {
                doc.fontSize(9).fillColor('#666666').text(invoice.customer.email, 350, detailsY + 30);
            }
            if (invoice.customer?.phone) {
                doc.fontSize(9).fillColor('#666666').text(invoice.customer.phone, 350, detailsY + 43);
            }

            // ─── Items Table ───────────────────────────────
            const tableTop = 210;
            const colX = { name: 50, qty: 280, price: 340, tax: 420, total: 480 };

            // Table header
            doc.rect(50, tableTop, 510, 20).fill(accentColor);
            doc.fontSize(9).fillColor('#FFFFFF');
            doc.text('Item', colX.name + 5, tableTop + 5);
            doc.text('Qty', colX.qty, tableTop + 5);
            doc.text('Price', colX.price, tableTop + 5);
            doc.text('Tax', colX.tax, tableTop + 5);
            doc.text('Total', colX.total, tableTop + 5);

            // Table rows
            let rowY = tableTop + 25;
            doc.fillColor('#333333').fontSize(9);

            const itemsList = invoice.items || [];
            for (let i = 0; i < itemsList.length; i++) {
                const item = itemsList[i];
                const bgColor = i % 2 === 0 ? '#F9FAFB' : '#FFFFFF';
                doc.rect(50, rowY - 3, 510, 18).fill(bgColor);
                doc.fillColor('#333333');

                const name = item.name || 'Item';
                doc.text(name.length > 35 ? name.substring(0, 35) + '...' : name, colX.name + 5, rowY);
                doc.text(item.quantity?.toString() || '0', colX.qty, rowY);
                doc.text(formatDecimal(item.unitPrice), colX.price, rowY);
                doc.text(formatDecimal(item.taxAmount), colX.tax, rowY);
                doc.text(formatDecimal(item.total), colX.total, rowY);
                rowY += 18;

                if (rowY > 700) {
                    doc.addPage();
                    rowY = 50;
                }
            }

            // ─── Totals ────────────────────────────────────
            rowY += 15;
            const totalsX = 380;
            doc.fontSize(10).fillColor('#666666');
            doc.text('Subtotal:', totalsX, rowY);
            doc.text(formatDecimal(invoice.subtotal), 480, rowY, { align: 'right', width: 80 });
            rowY += 18;

            if (invoice.discountAmount && new Decimal(invoice.discountAmount).greaterThan(0)) {
                doc.text('Discount:', totalsX, rowY);
                doc.text(`-${formatDecimal(invoice.discountAmount)}`, 480, rowY, { align: 'right', width: 80 });
                rowY += 18;
            }

            doc.text('Tax:', totalsX, rowY);
            doc.text(formatDecimal(invoice.taxAmount), 480, rowY, { align: 'right', width: 80 });
            rowY += 20;

            // Total line
            doc.rect(totalsX - 10, rowY - 5, 180, 25).fill(accentColor);
            doc.fontSize(12).fillColor('#FFFFFF');
            doc.text('TOTAL:', totalsX, rowY);
            doc.text(`${invoice.currency} ${formatDecimal(invoice.totalAmount)}`, 440, rowY, { align: 'right', width: 120 });
            rowY += 30;

            // Amount paid / due
            doc.fontSize(10).fillColor('#666666');
            if (new Decimal(invoice.amountPaid || 0).greaterThan(0)) {
                doc.text('Amount Paid:', totalsX, rowY);
                doc.text(formatDecimal(invoice.amountPaid), 480, rowY, { align: 'right', width: 80 });
                rowY += 18;
                doc.fillColor(accentColor).text('Amount Due:', totalsX, rowY);
                doc.text(`${invoice.currency} ${formatDecimal(invoice.amountDue)}`, 480, rowY, { align: 'right', width: 80 });
                rowY += 18;
            }

            // ─── Notes & Footer ────────────────────────────
            if (invoice.notes) {
                rowY += 20;
                doc.fontSize(9).fillColor('#888888').text('Notes:', 50, rowY);
                doc.fontSize(9).fillColor('#333333').text(invoice.notes, 50, rowY + 12, { width: 300 });
            }

            if (invoice.footer || settings?.defaultFooter) {
                const footerText = invoice.footer || settings.defaultFooter;
                doc.fontSize(8).fillColor('#888888').text(footerText, 50, 750, { width: 510, align: 'center' });
            }

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

function formatDecimal(value: any): string {
    if (!value) return '0.00';
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? '0.00' : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
