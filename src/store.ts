import { DatabaseSync } from 'node:sqlite';

export type MemberStatus = 'pending' | 'paid';

export interface Member {
  chatId: number;
  userId: number;
  displayName: string;
  chatTitle: string;
  status: MemberStatus;
  createdAt: number;
  paidAt: number | null;
}

export interface Invoice {
  paymentHash: string;
  chatId: number;
  userId: number;
  bolt11: string;
  amountSats: number;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
}

type Row = Record<string, unknown>;

/** SQLite-backed record of who owes what. All timestamps are unix seconds. */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS members (
        chat_id      INTEGER NOT NULL,
        user_id      INTEGER NOT NULL,
        display_name TEXT    NOT NULL DEFAULT '',
        chat_title   TEXT    NOT NULL DEFAULT '',
        status       TEXT    NOT NULL CHECK (status IN ('pending', 'paid')),
        created_at   INTEGER NOT NULL,
        paid_at      INTEGER,
        PRIMARY KEY (chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS invoices (
        payment_hash TEXT    PRIMARY KEY,
        chat_id      INTEGER NOT NULL,
        user_id      INTEGER NOT NULL,
        bolt11       TEXT    NOT NULL,
        amount_sats  INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        paid_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS invoices_by_member ON invoices (chat_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS invoices_by_bolt11 ON invoices (bolt11);
    `);
  }

  getMember(chatId: number, userId: number): Member | undefined {
    const row = this.#db
      .prepare('SELECT * FROM members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as Row | undefined;
    return row ? toMember(row) : undefined;
  }

  /** Create a pending entry if none exists, refresh the cached names, and return the current row. */
  ensurePending(chatId: number, userId: number, displayName: string, chatTitle: string, now: number): Member {
    this.#db
      .prepare(
        `INSERT INTO members (chat_id, user_id, display_name, chat_title, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET display_name = excluded.display_name, chat_title = excluded.chat_title`,
      )
      .run(chatId, userId, displayName, chatTitle, now);
    return this.getMember(chatId, userId)!;
  }

  markMemberPaid(chatId: number, userId: number, paidAt: number): void {
    this.#db
      .prepare(`UPDATE members SET status = 'paid', paid_at = ? WHERE chat_id = ? AND user_id = ?`)
      .run(paidAt, chatId, userId);
  }

  listPendingForUser(userId: number): Member[] {
    const rows = this.#db
      .prepare(`SELECT * FROM members WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC`)
      .all(userId) as Row[];
    return rows.map(toMember);
  }

  insertInvoice(inv: Invoice): void {
    this.#db
      .prepare(
        `INSERT INTO invoices (payment_hash, chat_id, user_id, bolt11, amount_sats, created_at, expires_at, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(inv.paymentHash, inv.chatId, inv.userId, inv.bolt11, inv.amountSats, inv.createdAt, inv.expiresAt, inv.paidAt);
  }

  getInvoice(paymentHash: string): Invoice | undefined {
    const row = this.#db.prepare('SELECT * FROM invoices WHERE payment_hash = ?').get(paymentHash) as Row | undefined;
    return row ? toInvoice(row) : undefined;
  }

  getInvoiceByBolt11(bolt11: string): Invoice | undefined {
    const row = this.#db
      .prepare('SELECT * FROM invoices WHERE lower(bolt11) = lower(?)')
      .get(bolt11) as Row | undefined;
    return row ? toInvoice(row) : undefined;
  }

  /** The newest unpaid invoice for this member that is still valid past `minExpiresAt`. */
  latestOpenInvoice(chatId: number, userId: number, minExpiresAt: number): Invoice | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM invoices
         WHERE chat_id = ? AND user_id = ? AND paid_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId, userId, minExpiresAt) as Row | undefined;
    return row ? toInvoice(row) : undefined;
  }

  /** Atomically flip an invoice to paid. Returns false if it was already paid (or unknown). */
  claimInvoicePaid(paymentHash: string, paidAt: number): boolean {
    const result = this.#db
      .prepare('UPDATE invoices SET paid_at = ? WHERE payment_hash = ? AND paid_at IS NULL')
      .run(paidAt, paymentHash);
    return Number(result.changes) > 0;
  }

  /** Unpaid invoices belonging to members who still owe. Used to decide whether reconciliation is needed. */
  openInvoiceWindow(): { count: number; oldestCreatedAt: number | undefined } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(i.created_at) AS oldest
         FROM invoices i JOIN members m ON m.chat_id = i.chat_id AND m.user_id = i.user_id
         WHERE i.paid_at IS NULL AND m.status = 'pending'`,
      )
      .get() as Row;
    const oldest = row.oldest;
    return {
      count: Number(row.n ?? 0),
      oldestCreatedAt: typeof oldest === 'number' ? oldest : undefined,
    };
  }

  close(): void {
    this.#db.close();
  }
}

function toMember(r: Row): Member {
  return {
    chatId: Number(r.chat_id),
    userId: Number(r.user_id),
    displayName: String(r.display_name ?? ''),
    chatTitle: String(r.chat_title ?? ''),
    status: r.status as MemberStatus,
    createdAt: Number(r.created_at),
    paidAt: r.paid_at == null ? null : Number(r.paid_at),
  };
}

function toInvoice(r: Row): Invoice {
  return {
    paymentHash: String(r.payment_hash),
    chatId: Number(r.chat_id),
    userId: Number(r.user_id),
    bolt11: String(r.bolt11),
    amountSats: Number(r.amount_sats),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    paidAt: r.paid_at == null ? null : Number(r.paid_at),
  };
}
