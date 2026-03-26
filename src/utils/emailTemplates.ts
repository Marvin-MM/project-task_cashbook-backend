import { config } from '../config';

/**
 * Branded email template for email verification OTP.
 */
export function verificationEmailTemplate(firstName: string, otp: string): string {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111827; margin-bottom: 8px;">Verify your email</h2>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            Hi ${firstName}, welcome to <strong>${config.APP_NAME}</strong>! Use the code below to verify your email address.
        </p>
        <div style="text-align: center; margin: 28px 0;">
            <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111827; background: #f3f4f6; padding: 14px 28px; border-radius: 8px;">${otp}</span>
        </div>
        <p style="color: #9ca3af; font-size: 13px;">
            This code expires in <strong>15 minutes</strong>. If you didn't create an account, you can safely ignore this email.
        </p>
    </div>`;
}

/**
 * Branded email template for password-reset OTP.
 */
export function passwordResetEmailTemplate(firstName: string, otp: string): string {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111827; margin-bottom: 8px;">Reset your password</h2>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            Hi ${firstName}, we received a request to reset your <strong>${config.APP_NAME}</strong> password. Use the code below to proceed.
        </p>
        <div style="text-align: center; margin: 28px 0;">
            <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111827; background: #f3f4f6; padding: 14px 28px; border-radius: 8px;">${otp}</span>
        </div>
        <p style="color: #9ca3af; font-size: 13px;">
            This code expires in <strong>15 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.
        </p>
    </div>`;
}

/**
 * Invitation email for users who already have an account.
 * Tells them they've been added and should log in.
 */
export function workspaceInviteEmailTemplate(
    recipientName: string,
    workspaceName: string,
    inviterName: string,
    role: string,
): string {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111827; margin-bottom: 8px;">You've been invited to a workspace</h2>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            Hi ${recipientName}, <strong>${inviterName}</strong> has invited you to join the
            <strong>${workspaceName}</strong> workspace on <strong>${config.APP_NAME}</strong>
            as a <strong>${role}</strong>.
        </p>
        <div style="text-align: center; margin: 28px 0;">
            <a href="${config.CORS_ORIGINS}" style="display: inline-block; padding: 12px 32px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Log in to review your invitations</a>
        </div>
        <p style="color: #9ca3af; font-size: 13px;">
            You can accept or decline this invitation from your pending invitations dashboard.
        </p>
    </div>`;
}

/**
 * Invitation email for users who don't have an account yet.
 * Prompts them to sign up to join the workspace.
 */
export function workspaceInviteSignupEmailTemplate(
    email: string,
    workspaceName: string,
    inviterName: string,
    role: string,
): string {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111827; margin-bottom: 8px;">You've been invited to join ${config.APP_NAME}</h2>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            Hi there! <strong>${inviterName}</strong> has invited you to join the
            <strong>${workspaceName}</strong> workspace on <strong>${config.APP_NAME}</strong>
            as a <strong>${role}</strong>.
        </p>
        <div style="text-align: center; margin: 28px 0;">
            <a href="${config.CORS_ORIGINS}" style="display: inline-block; padding: 12px 32px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Sign up to join</a>
        </div>
        <p style="color: #9ca3af; font-size: 13px;">
            Create your account using <strong>${email}</strong> and you'll automatically be added to the workspace. This invitation expires in <strong>7 days</strong>.
        </p>
    </div>`;
}

/**
 * Onboarding welcome email template for newly verified/created users.
 */
export function welcomeEmailTemplate(firstName: string): string {
    return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb;">
        <h2 style="color: #111827; margin-bottom: 8px;">Welcome to ${config.APP_NAME}!</h2>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            Hi ${firstName}, we're absolutely thrilled to have you here! Our platform is designed to give you the best features to manage your accounts seamlessly and track your cash flows with unparalleled precision.
        </p>
        <div style="text-align: center; margin: 28px 0;">
            <a href="${config.CORS_ORIGINS}" style="display: inline-block; padding: 12px 32px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Get Started Now</a>
        </div>
        <p style="color: #6b7280; font-size: 15px; line-height: 1.6;">
            If you ever need any assistance, feel free to reach out. We are always here to help you succeed!
        </p>
        <p style="color: #9ca3af; font-size: 13px; margin-top: 32px;">
            The ${config.APP_NAME} Team
        </p>
    </div>`;
}

/**
 * Professional invoice delivery email.
 * Sent to the customer when an invoice is marked as SENT.
 *
 * @param customerName   Full name of the customer / contact
 * @param businessName   Display name of the sending workspace / business
 * @param invoiceNumber  e.g. "INV-0042"
 * @param currency       e.g. "UGX"
 * @param totalAmount    Formatted total string  e.g. "1,200,000.00"
 * @param dueDate        Formatted due-date string e.g. "30 Apr 2025"
 * @param itemsSummary   Short plaintext summary of line items (max 5)
 * @param notes          Optional notes from the invoice
 * @param logoUrl        Optional logo URL — falls back to platform logo
 */
export function invoiceEmailTemplate(params: {
    customerName: string;
    businessName: string;
    invoiceNumber: string;
    currency: string;
    totalAmount: string;
    dueDate: string;
    itemsSummary: Array<{ name: string; quantity: string; total: string }>;
    notes?: string | null;
    logoUrl?: string | null;
}): string {
    const {
        customerName,
        businessName,
        invoiceNumber,
        currency,
        totalAmount,
        dueDate,
        itemsSummary,
        notes,
        logoUrl,
    } = params;

    const FALLBACK_LOGO = 'https://inchange.odixtec.net/reportlogo.svg';
    const logo = logoUrl || FALLBACK_LOGO;

    const itemRows = itemsSummary
        .slice(0, 5)
        .map(
            (i) => `
            <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #f3f4f6; color: #374151; font-size: 14px;">${i.name}</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #f3f4f6; color: #6b7280; font-size: 14px; text-align: center;">${i.quantity}</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #f3f4f6; color: #111827; font-size: 14px; text-align: right; font-weight: 600;">${currency} ${i.total}</td>
            </tr>`
        )
        .join('');

    const moreItems = itemsSummary.length > 5
        ? `<tr><td colspan="3" style="padding: 8px 0; color: #9ca3af; font-size: 13px;">+ ${itemsSummary.length - 5} more item(s) — see attached PDF</td></tr>`
        : '';

    const notesBlock = notes
        ? `<div style="margin-top: 20px; padding: 14px 16px; background: #f9fafb; border-left: 3px solid #e5e7eb; border-radius: 4px;">
               <p style="margin: 0; color: #6b7280; font-size: 13px; line-height: 1.6;">${notes}</p>
           </div>`
        : '';

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Invoice ${invoiceNumber}</title>
    </head>
    <body style="margin: 0; padding: 0; background: #f3f4f6; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">

        <!-- Wrapper -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background: #f3f4f6; padding: 32px 0;">
        <tr><td align="center">

        <!-- Card -->
        <table width="580" cellpadding="0" cellspacing="0" style="background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; max-width: 580px;">

            <!-- Header band -->
            <tr>
                <td style="background: #111827; padding: 28px 36px 24px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                            <td>
                                <img src="${logo}" alt="${businessName}" height="36"
                                     style="display: block; height: 36px; max-width: 150px; object-fit: contain;"
                                     onerror="this.style.display='none'" />
                                <p style="margin: 8px 0 0; color: #ffffff; font-size: 16px; font-weight: 700;">${businessName}</p>
                            </td>
                            <td align="right" style="vertical-align: top;">
                                <p style="margin: 0; color: #9ca3af; font-size: 11px; font-weight: 600; letter-spacing: 1px;">INVOICE</p>
                                <p style="margin: 4px 0 0; color: #ffffff; font-size: 20px; font-weight: 700;">${invoiceNumber}</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>

            <!-- Body -->
            <tr>
                <td style="padding: 32px 36px 0;">

                    <!-- Greeting -->
                    <p style="margin: 0 0 20px; color: #374151; font-size: 15px; line-height: 1.6;">
                        Dear <strong>${customerName}</strong>,
                    </p>
                    <p style="margin: 0 0 28px; color: #6b7280; font-size: 14px; line-height: 1.7;">
                        Please find your invoice attached to this email as a PDF. A summary of your charges is below.
                    </p>

                    <!-- Amount due highlight -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                        <tr>
                            <td style="background: #f9fafb; border-radius: 8px; padding: 18px 22px;">
                                <table width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                        <td>
                                            <p style="margin: 0; color: #6b7280; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Amount Due</p>
                                            <p style="margin: 4px 0 0; color: #111827; font-size: 26px; font-weight: 700;">${currency} ${totalAmount}</p>
                                        </td>
                                        <td align="right">
                                            <p style="margin: 0; color: #6b7280; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Due Date</p>
                                            <p style="margin: 4px 0 0; color: #DC2626; font-size: 15px; font-weight: 700;">${dueDate}</p>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    </table>

                    <!-- Items summary table -->
                    <p style="margin: 0 0 10px; color: #374151; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Invoice Summary</p>
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px;">
                        <thead>
                            <tr style="background: #f9fafb;">
                                <th style="padding: 8px 0; text-align: left; color: #9ca3af; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Item</th>
                                <th style="padding: 8px 0; text-align: center; color: #9ca3af; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Qty</th>
                                <th style="padding: 8px 0; text-align: right; color: #9ca3af; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${itemRows}
                            ${moreItems}
                        </tbody>
                    </table>

                    ${notesBlock}

                    <!-- CTA note -->
                    <p style="margin: 28px 0 0; color: #6b7280; font-size: 13px; line-height: 1.6;">
                        The full invoice with a breakdown of all charges is attached as a PDF. Please arrange payment by the due date.
                    </p>

                </td>
            </tr>

            <!-- Footer -->
            <tr>
                <td style="padding: 28px 36px 32px; border-top: 1px solid #f3f4f6; margin-top: 28px;">
                    <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">
                        This invoice was generated by <strong>${config.APP_NAME}</strong>. If you have questions about this invoice, please contact <strong>${businessName}</strong> directly.
                    </p>
                    <p style="margin: 12px 0 0; color: #d1d5db; font-size: 11px;">
                        © ${new Date().getFullYear()} ${config.APP_NAME}. All rights reserved.
                    </p>
                </td>
            </tr>

        </table>
        <!-- /Card -->

        </td></tr>
        </table>
        <!-- /Wrapper -->

    </body>
    </html>`;
}

