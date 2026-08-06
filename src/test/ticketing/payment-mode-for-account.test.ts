/**
 * The payment method that follows a wallet.
 *
 * The desk asks for this the moment an attendant picks a wallet, so the
 * payment-mode field fills itself in rather than asking the same thing twice.
 * The property under test: exactly one PaymentMode ever exists per
 * (workspace, account-type name), no matter how many times — or how
 * concurrently — the desk asks for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { testPrisma, resetDatabase } from '../setup';
import { buildGate, ticketing } from './fixture';

/**
 * Every workspace is pre-seeded with a standard set of account types — Bank,
 * Cash, Mobile Money, Credit Card, Loan (`coa.template.ts`,
 * `DEFAULT_ACCOUNT_TYPES`) — so a wallet of type "Cash" or "Mobile Money" is
 * the ordinary case in production, not a special one. `upsert` here matches
 * the seed's own idiom rather than colliding with it.
 */
async function walletOfType(workspaceId: string, typeName: string) {
    const accountType = await testPrisma.accountType.upsert({
        where: { name_workspaceId: { name: typeName, workspaceId } },
        update: {},
        create: { workspaceId, name: typeName, classification: 'ASSET' },
    });
    return testPrisma.account.create({
        data: {
            workspaceId,
            accountTypeId: accountType.id,
            name: `${typeName} till`,
            currency: 'UGX',
            balance: 0,
        },
    });
}

describe('ensuring a payment mode for a wallet', () => {
    beforeEach(resetDatabase);

    it('creates one named after the wallet’s account type, the first time', async () => {
        const gate = await buildGate();
        const wallet = await walletOfType(gate.workspace.id, 'Mobile Money');

        const mode = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, wallet.id, gate.owner.id,
        );

        expect(mode.name).toBe('Mobile Money');
        const row = await testPrisma.paymentMode.findUniqueOrThrow({ where: { id: mode.id } });
        expect(row.workspaceId).toBe(gate.workspace.id);
        expect(row.isActive).toBe(true);
    });

    it('reuses it rather than creating a second one', async () => {
        const gate = await buildGate();
        const wallet = await walletOfType(gate.workspace.id, 'Bank');

        const first = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, wallet.id, gate.owner.id,
        );
        const second = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, wallet.id, gate.owner.id,
        );

        expect(second.id).toBe(first.id);
        expect(await testPrisma.paymentMode.count({
            where: { workspaceId: gate.workspace.id, name: 'Bank' },
        })).toBe(1);
    });

    it('reuses the same mode for a second wallet of the same account type', async () => {
        const gate = await buildGate();
        const till1 = await walletOfType(gate.workspace.id, 'Cash');
        const accountType = await testPrisma.accountType.findFirstOrThrow({
            where: { workspaceId: gate.workspace.id, name: 'Cash' },
        });
        const till2 = await testPrisma.account.create({
            data: {
                workspaceId: gate.workspace.id, accountTypeId: accountType.id,
                name: 'Second cash till', currency: 'UGX', balance: 0,
            },
        });

        const modeA = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, till1.id, gate.owner.id,
        );
        const modeB = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, till2.id, gate.owner.id,
        );

        expect(modeB.id).toBe(modeA.id);
    });

    it('reactivates a soft-deleted payment mode instead of duplicating it', async () => {
        const gate = await buildGate();
        const wallet = await walletOfType(gate.workspace.id, 'Airtel Money');

        const created = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, wallet.id, gate.owner.id,
        );
        await testPrisma.paymentMode.update({
            where: { id: created.id },
            data: { isActive: false },
        });

        const reactivated = await ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, wallet.id, gate.owner.id,
        );

        expect(reactivated.id).toBe(created.id);
        const row = await testPrisma.paymentMode.findUniqueOrThrow({ where: { id: created.id } });
        expect(row.isActive).toBe(true);
        expect(await testPrisma.paymentMode.count({
            where: { workspaceId: gate.workspace.id, name: 'Airtel Money' },
        })).toBe(1);
    });

    it('lets two attendants racing on a brand-new wallet type end up with one payment mode', async () => {
        const gate = await buildGate();
        const wallet = await walletOfType(gate.workspace.id, 'MTN MoMo');

        const [a, b] = await Promise.all([
            ticketing().ensurePaymentModeForAccount(gate.workspace.id, wallet.id, gate.attendant.id),
            ticketing().ensurePaymentModeForAccount(gate.workspace.id, wallet.id, gate.otherAttendant.id),
        ]);

        expect(a.id).toBe(b.id);
        expect(await testPrisma.paymentMode.count({
            where: { workspaceId: gate.workspace.id, name: 'MTN MoMo' },
        })).toBe(1);
    });

    it('refuses a wallet from another workspace', async () => {
        const gate = await buildGate();
        const stranger = await buildGate();
        const foreignWallet = await walletOfType(stranger.workspace.id, 'Cash');

        await expect(ticketing().ensurePaymentModeForAccount(
            gate.workspace.id, foreignWallet.id, gate.owner.id,
        )).rejects.toThrow(/wallet/i);
    });
});
