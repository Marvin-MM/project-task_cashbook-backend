/**
 * Export every workspace's data to Excel, for archiving before a reset.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
 *
 * The obvious alternative — an admin route that streams a workbook — is a
 * single HTTP surface that returns every tenant's finances in one response. It
 * would be the highest-value target in the system, it has to hold the result in
 * a 512Mi pod, and "we will remove it after the export" is how such routes come
 * to live in a codebase for years. None of that buys anything: a script reading
 * a restored `pg_dump` produces the identical spreadsheet with no auth surface,
 * no production memory pressure, and nothing left behind.
 *
 * Point DATABASE_URL at a **restored copy** of the dump, not at production.
 * The dump is the authoritative archive; this is the human-readable rendering
 * of it, and it is re-runnable whenever someone asks for the data again.
 *
 *   pg_dump ──▶ scratch database ──▶ this script ──▶ one .xlsx per workspace
 *
 * Usage:
 *   npx tsx scripts/export-data.ts [--out ./exports] [--workspace <id>]
 *
 * Reads only. It opens no transaction and writes nothing.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
};
const OUT_DIR = path.resolve(argValue('--out') ?? './exports');
const ONLY_WORKSPACE = argValue('--workspace');

/** Rows are pulled in pages so a large tenant cannot exhaust memory. */
const PAGE = 1000;

/**
 * Excel has no Decimal. Sending a string would make every amount text — right
 * in the cell, useless in a SUM. Numbers are what an accountant will actually
 * do arithmetic on, and at these magnitudes a double is exact.
 */
const num = (value: Prisma.Decimal | number | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value.toString());

const plain = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'object' && 'toFixed' in (value as object)) return num(value as Prisma.Decimal);
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
};

interface SheetSpec {
    name: string;
    columns: Array<{ header: string; key: string; width?: number }>;
    /** Paged fetch. Returns [] to stop. */
    fetch: (skip: number) => Promise<Array<Record<string, unknown>>>;
}

async function addSheet(workbook: ExcelJS.Workbook, spec: SheetSpec): Promise<number> {
    const sheet = workbook.addWorksheet(spec.name);
    sheet.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20 }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    let skip = 0;
    let total = 0;
    for (;;) {
        const rows = await spec.fetch(skip);
        if (rows.length === 0) break;
        for (const row of rows) {
            const mapped: Record<string, unknown> = {};
            for (const col of spec.columns) mapped[col.key] = plain(row[col.key]);
            sheet.addRow(mapped);
        }
        total += rows.length;
        skip += rows.length;
        if (rows.length < PAGE) break;
    }
    return total;
}

/** Filesystem-safe, still recognisable. */
const slug = (name: string) =>
    name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'workspace';

async function exportWorkspace(ws: { id: string; name: string; defaultCurrency: string }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'InChange export';
    workbook.created = new Date();

    const counts: Record<string, number> = {};
    const where = { workspaceId: ws.id };

    counts.Cashbooks = await addSheet(workbook, {
        name: 'Cashbooks',
        columns: [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Balance', key: 'balance', width: 16 },
            { header: 'Total in', key: 'totalIncome', width: 16 },
            { header: 'Total out', key: 'totalExpense', width: 16 },
            { header: 'Created', key: 'createdAt', width: 22 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: (skip) => prisma.cashbook.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: PAGE }) as never,
    });

    counts.Entries = await addSheet(workbook, {
        name: 'Entries',
        columns: [
            { header: 'Date', key: 'entryDate', width: 22 },
            { header: 'Book', key: 'bookName', width: 24 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Amount', key: 'amount', width: 16 },
            { header: 'Charge', key: 'chargeAmount', width: 12 },
            { header: 'Description', key: 'description', width: 40 },
            { header: 'Category', key: 'categoryName', width: 20 },
            { header: 'Contact', key: 'contactName', width: 22 },
            { header: 'Payment mode', key: 'paymentModeName', width: 18 },
            { header: 'Wallet', key: 'walletName', width: 20 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Entered by', key: 'createdByName', width: 24 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: async (skip) => {
            const rows = await prisma.entry.findMany({
                where: { cashbook: { workspaceId: ws.id } },
                orderBy: { entryDate: 'asc' },
                skip, take: PAGE,
                include: {
                    cashbook: { select: { name: true } },
                    category: { select: { name: true } },
                    contact: { select: { name: true } },
                    paymentMode: { select: { name: true } },
                    createdBy: { select: { firstName: true, lastName: true } },
                    // The wallet link is not a column on Entry — it is the
                    // AccountTransaction posted alongside it. Worth carrying
                    // into the export, since it is the column that says where
                    // the money actually moved.
                    accountTransactions: { select: { account: { select: { name: true } } }, take: 1 },
                },
            });
            return rows.map((r) => ({
                ...r,
                bookName: r.cashbook?.name ?? null,
                categoryName: r.category?.name ?? null,
                contactName: r.contact?.name ?? null,
                paymentModeName: r.paymentMode?.name ?? null,
                createdByName: r.createdBy ? `${r.createdBy.firstName} ${r.createdBy.lastName}` : null,
                walletName: r.accountTransactions[0]?.account?.name ?? null,
            }));
        },
    });

    counts.Wallets = await addSheet(workbook, {
        name: 'Wallets',
        columns: [
            { header: 'Name', key: 'name', width: 28 },
            { header: 'Balance', key: 'balance', width: 16 },
            { header: 'Currency', key: 'currency', width: 10 },
            { header: 'Active', key: 'isActive', width: 10 },
            { header: 'Created', key: 'createdAt', width: 22 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: (skip) => prisma.account.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: PAGE }) as never,
    });

    counts['Wallet transactions'] = await addSheet(workbook, {
        name: 'Wallet transactions',
        columns: [
            { header: 'Date', key: 'transactionDate', width: 22 },
            { header: 'Wallet', key: 'walletName', width: 24 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Amount', key: 'amount', width: 16 },
            { header: 'Description', key: 'description', width: 40 },
            { header: 'Source', key: 'sourceType', width: 16 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: async (skip) => {
            const rows = await prisma.accountTransaction.findMany({
                where, orderBy: { transactionDate: 'asc' }, skip, take: PAGE,
                include: { account: { select: { name: true } } },
            });
            return rows.map((r) => ({ ...r, walletName: r.account?.name ?? null }));
        },
    });

    counts.Contacts = await addSheet(workbook, {
        name: 'Contacts',
        columns: [
            { header: 'Name', key: 'name', width: 28 },
            { header: 'Type', key: 'type', width: 14 },
            { header: 'Phone', key: 'phone', width: 18 },
            { header: 'Email', key: 'email', width: 26 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: (skip) => prisma.contact.findMany({ where, orderBy: { name: 'asc' }, skip, take: PAGE }) as never,
    });

    counts.Categories = await addSheet(workbook, {
        name: 'Categories',
        columns: [
            { header: 'Name', key: 'name', width: 28 },
            { header: 'Type', key: 'type', width: 14 },
            { header: 'ID', key: 'id', width: 38 },
        ],
        fetch: (skip) => prisma.category.findMany({ where, orderBy: { name: 'asc' }, skip, take: PAGE }) as never,
    });

    counts.Members = await addSheet(workbook, {
        name: 'Members',
        columns: [
            { header: 'Name', key: 'userName', width: 28 },
            { header: 'Email', key: 'userEmail', width: 30 },
            { header: 'Role', key: 'role', width: 18 },
            { header: 'Joined', key: 'joinedAt', width: 22 },
        ],
        fetch: async (skip) => {
            const rows = await prisma.workspaceMember.findMany({
                where, orderBy: { joinedAt: 'asc' }, skip, take: PAGE,
                include: { user: { select: { firstName: true, lastName: true, email: true } } },
            });
            return rows.map((r) => ({
                ...r,
                userName: `${r.user.firstName} ${r.user.lastName}`,
                userEmail: r.user.email,
            }));
        },
    });

    // Summary first in the tab order, so opening the file answers "what is
    // this". exceljs orders tabs by each sheet's `orderNo`, not by position in
    // the worksheets array — reordering the array alone does nothing.
    // `orderNo` is real in the file format but absent from exceljs 3's types.
    const summary = workbook.addWorksheet('Summary');
    (summary as unknown as { orderNo: number }).orderNo = -1;
    summary.columns = [{ header: 'Item', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 44 }];
    summary.getRow(1).font = { bold: true };
    summary.addRows([
        { k: 'Workspace', v: ws.name },
        { k: 'Workspace ID', v: ws.id },
        { k: 'Default currency', v: ws.defaultCurrency },
        { k: 'Exported at', v: new Date().toISOString() },
        { k: '', v: '' },
        ...Object.entries(counts).map(([k, v]) => ({ k: `${k} (rows)`, v })),
    ]);

    const file = path.join(OUT_DIR, `${slug(ws.name)}-${ws.id.slice(0, 8)}.xlsx`);
    await workbook.xlsx.writeFile(file);
    return { file, counts };
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`\nExporting to ${OUT_DIR}\n`);

    const workspaces = await prisma.workspace.findMany({
        where: ONLY_WORKSPACE ? { id: ONLY_WORKSPACE } : {},
        select: { id: true, name: true, defaultCurrency: true },
        orderBy: { createdAt: 'asc' },
    });

    const index = new ExcelJS.Workbook();
    const indexSheet = index.addWorksheet('All workspaces');
    indexSheet.columns = [
        { header: 'Workspace', key: 'name', width: 34 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Cashbooks', key: 'cashbooks', width: 12 },
        { header: 'Entries', key: 'entries', width: 12 },
        { header: 'Wallets', key: 'wallets', width: 12 },
        { header: 'Members', key: 'members', width: 12 },
        { header: 'File', key: 'file', width: 46 },
        { header: 'ID', key: 'id', width: 38 },
    ];
    indexSheet.getRow(1).font = { bold: true };

    let n = 0;
    for (const ws of workspaces) {
        const { file, counts } = await exportWorkspace(ws);
        indexSheet.addRow({
            name: ws.name,
            currency: ws.defaultCurrency,
            cashbooks: counts.Cashbooks,
            entries: counts.Entries,
            wallets: counts.Wallets,
            members: counts.Members,
            file: path.basename(file),
            id: ws.id,
        });
        n += 1;
        process.stdout.write(`\r  ${n}/${workspaces.length} workspaces…`);
    }

    const indexFile = path.join(OUT_DIR, '_index-all-workspaces.xlsx');
    await index.xlsx.writeFile(indexFile);

    console.log(`\n\nDone. ${n} workbook(s) plus ${path.basename(indexFile)} in ${OUT_DIR}\n`);
}

main()
    .catch((error) => { console.error('\nExport failed:', error); process.exit(1); })
    .finally(() => prisma.$disconnect());
