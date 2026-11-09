import { GrammyError, InlineKeyboard, InputFile, type Api } from 'grammy';
import type { Chat, User } from 'grammy/types';
import QRCode from 'qrcode';
import type { AppConfig } from './config.ts';
import { errorMessage, log } from './log.ts';
import type { Invoice, Member, Store } from './store.ts';
import {
  MUTED,
  UNRESTRICTED,
  chatTitle,
  deepLink,
  displayName,
  escapeHtml,
  formatSats,
  mention,
} from './telegram.ts';
import type { ReceivedPayment, Wallet } from './wallet.ts';

export interface GateDeps {
  api: Api;
  store: Store;
  wallet: Wallet;
  cfg: AppConfig;
  botUsername: string;
}

export type SendInvoiceResult = 'sent' | 'dm_failed' | 'already_paid' | 'no_entry';

const JOIN_DEDUPE_MS = 30_000;
const ADMIN_NAG_INTERVAL_MS = 10 * 60_000;

/**
 * The paywall. New members get muted and invoiced; a matching payment unmutes them.
 * Every step is idempotent, so a join or payment reported twice is harmless.
 */
export class Gate {
  readonly #api: Api;
  readonly #store: Store;
  readonly #wallet: Wallet;
  readonly #cfg: AppConfig;
  readonly #botUsername: string;
  readonly #recentJoins = new Map<string, number>();
  readonly #lastAdminNag = new Map<number, number>();
  #reconciling = false;

  constructor(deps: GateDeps) {
    this.#api = deps.api;
    this.#store = deps.store;
    this.#wallet = deps.wallet;
    this.#cfg = deps.cfg;
    this.#botUsername = deps.botUsername;
  }

  /** A user has just become a member of `chat`. Mute them and hand them an invoice. */
  async handleJoin(chat: Chat, user: User): Promise<void> {
    if (user.is_bot) return;
    if (!this.#firstSighting(chat.id, user.id)) return;

    const title = chatTitle(chat);
    const name = displayName(user);
    const who = { chatId: chat.id, userId: user.id, name, chat: title };

    const existing = this.#store.getMember(chat.id, user.id);
    if (existing?.status === 'paid') {
      log('info', 'member rejoined and has already paid; leaving them alone', who);
      return;
    }
    this.#store.ensurePending(chat.id, user.id, name, title, nowSec());
    log('info', 'new member, muting until paid', who);

    try {
      await this.#api.restrictChatMember(chat.id, user.id, MUTED);
    } catch (err) {
      await this.#reportRestrictFailure(chat.id, user.id, name, err);
      return;
    }

    let invoice: Invoice;
    try {
      invoice = await this.#getOrCreateInvoice(chat.id, user.id, title);
    } catch (err) {
      log('error', `could not create invoice: ${errorMessage(err)}`, who);
      await this.#say(
        chat.id,
        `⚠️ ${mention(user.id, name)} needs to pay the entry fee, but I could not create a Lightning invoice. ` +
          `An admin should check the bot logs.`,
      );
      return;
    }

    const dmSent = await this.#sendInvoiceDm(user.id, title, invoice);
    const fee = formatSats(invoice.amountSats);
    const intro =
      `👋 Welcome, ${mention(user.id, name)}! This group charges a one-time entry fee of <b>${fee} sats</b> ` +
      `before you can post.`;
    const next = dmSent
      ? `I've sent you a Lightning invoice in a private message. You'll be unmuted automatically once it's paid.`
      : `Tap the button below to get your Lightning invoice from me. You'll be unmuted automatically once it's paid.`;

    await this.#say(chat.id, `${intro}\n\n${next}`, {
      reply_markup: new InlineKeyboard().url(`⚡ Pay ${fee} sats`, deepLink(this.#botUsername, chat.id)),
    });
  }

  /** The user asked (via /start) for their invoice for `chatId`. */
  async sendInvoice(userId: number, chatId: number): Promise<SendInvoiceResult> {
    const member = this.#store.getMember(chatId, userId);
    if (!member) return 'no_entry';
    if (member.status === 'paid') return 'already_paid';

    const invoice = await this.#getOrCreateInvoice(chatId, userId, member.chatTitle);
    const sent = await this.#sendInvoiceDm(userId, member.chatTitle, invoice);
    return sent ? 'sent' : 'dm_failed';
  }

  pendingEntriesFor(userId: number): Member[] {
    return this.#store.listPendingForUser(userId);
  }

  /** An incoming Lightning payment completed. If it matches one of our invoices, unlock the member. */
  async handlePayment(payment: ReceivedPayment): Promise<void> {
    const invoice =
      (payment.paymentHash ? this.#store.getInvoice(payment.paymentHash) : undefined) ??
      this.#store.getInvoiceByBolt11(payment.bolt11);
    if (!invoice) {
      log('debug', 'incoming payment does not match any entry-fee invoice', {
        paymentHash: payment.paymentHash,
        amountSats: payment.amountSats,
      });
      return;
    }
    if (!this.#store.claimInvoicePaid(invoice.paymentHash, nowSec())) return; // already handled

    const member = this.#store.getMember(invoice.chatId, invoice.userId);
    const name = member?.displayName || `user ${invoice.userId}`;
    const title = member?.chatTitle || 'the group';
    const who = { chatId: invoice.chatId, userId: invoice.userId, name, amountSats: payment.amountSats };

    this.#store.markMemberPaid(invoice.chatId, invoice.userId, nowSec());
    log('info', 'entry fee paid', who);

    const unlocked = await this.#unlock(invoice.chatId, invoice.userId);
    const fee = formatSats(invoice.amountSats);
    if (unlocked) {
      await this.#say(invoice.chatId, `⚡ ${mention(invoice.userId, name)} paid ${fee} sats and can now post. Welcome aboard!`);
      await this.#dm(invoice.userId, `✅ Payment received. You can now post in <b>${escapeHtml(title)}</b>.`);
    } else {
      await this.#say(
        invoice.chatId,
        `⚠️ ${mention(invoice.userId, name)} paid ${fee} sats, but I could not lift their restriction. ` +
          `An admin should unmute them manually and check that I still have the "Ban users" permission.`,
      );
      await this.#dm(
        invoice.userId,
        `✅ Payment received for <b>${escapeHtml(title)}</b>, but I could not unmute you automatically. ` +
          `The group admins have been notified.`,
      );
    }
  }

  /** Catch payments that arrived while the bot was down (or whose event we missed). */
  async reconcile(): Promise<void> {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      const { count, oldestCreatedAt } = this.#store.openInvoiceWindow();
      if (count === 0) return;
      const from = oldestCreatedAt === undefined ? undefined : oldestCreatedAt - 60;
      const payments = await this.#wallet.listCompletedReceives(from);
      log('debug', 'reconciling open invoices against wallet history', { openInvoices: count, payments: payments.length });
      for (const payment of payments) {
        await this.handlePayment(payment);
      }
    } catch (err) {
      log('error', `reconciliation failed: ${errorMessage(err)}`);
    } finally {
      this.#reconciling = false;
    }
  }

  async #getOrCreateInvoice(chatId: number, userId: number, title: string): Promise<Invoice> {
    const now = nowSec();
    const open = this.#store.latestOpenInvoice(chatId, userId, now + 120);
    if (open) return open;

    const description = `Entry fee for ${title}`.slice(0, 120);
    const created = await this.#wallet.createInvoice(this.#cfg.entryFeeSats, description, this.#cfg.invoiceExpirySecs);
    const invoice: Invoice = { ...created, chatId, userId, createdAt: now, paidAt: null };
    this.#store.insertInvoice(invoice);
    log('info', 'issued entry-fee invoice', { chatId, userId, paymentHash: invoice.paymentHash, amountSats: invoice.amountSats });
    return invoice;
  }

  async #sendInvoiceDm(userId: number, title: string, invoice: Invoice): Promise<boolean> {
    const hoursLeft = Math.max(1, Math.round((invoice.expiresAt - nowSec()) / 3600));
    const caption =
      `⚡ <b>Entry fee for ${escapeHtml(title)}</b>\n` +
      `Pay this <b>${formatSats(invoice.amountSats)} sat</b> Lightning invoice from any wallet to unlock posting. ` +
      `It expires in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.\n\n` +
      `<code>${invoice.bolt11}</code>\n\n` +
      `I'll unmute you automatically as soon as it's paid.`;

    try {
      const png = await QRCode.toBuffer(invoice.bolt11.toUpperCase(), {
        type: 'png',
        width: 512,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      await this.#api.sendPhoto(userId, new InputFile(png, 'invoice.png'), { caption, parse_mode: 'HTML' });
      return true;
    } catch (err) {
      if (err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400)) {
        // The user has never opened a chat with the bot (or blocked it). They can use the deep link instead.
        log('info', 'could not DM invoice; user must start the bot first', { userId, reason: err.description });
      } else {
        log('warn', `could not DM invoice: ${errorMessage(err)}`, { userId });
      }
      return false;
    }
  }

  async #unlock(chatId: number, userId: number): Promise<boolean> {
    const delaysMs = [0, 2_000, 5_000];
    for (const [attempt, delay] of delaysMs.entries()) {
      if (delay) await sleep(delay);
      try {
        await this.#api.restrictChatMember(chatId, userId, UNRESTRICTED);
        return true;
      } catch (err) {
        const permanent = err instanceof GrammyError && (err.error_code === 400 || err.error_code === 403);
        log(permanent || attempt === delaysMs.length - 1 ? 'error' : 'warn', `unmute failed: ${errorMessage(err)}`, {
          chatId,
          userId,
          attempt: attempt + 1,
        });
        if (permanent) return false;
      }
    }
    return false;
  }

  async #reportRestrictFailure(chatId: number, userId: number, name: string, err: unknown): Promise<void> {
    const reason = err instanceof GrammyError ? err.description : errorMessage(err);
    log('error', `could not restrict new member: ${reason}`, { chatId, userId });

    const last = this.#lastAdminNag.get(chatId) ?? 0;
    if (Date.now() - last < ADMIN_NAG_INTERVAL_MS) return;
    this.#lastAdminNag.set(chatId, Date.now());

    await this.#say(
      chatId,
      `⚠️ I could not restrict ${mention(userId, name)}: <i>${escapeHtml(reason)}</i>\n\n` +
        `To gate new members I need to be an admin with the <b>Ban users</b> permission, and this chat must be a supergroup.`,
    );
  }

  /** True the first time a (chat, user) join is seen within the dedupe window. */
  #firstSighting(chatId: number, userId: number): boolean {
    const now = Date.now();
    for (const [key, seenAt] of this.#recentJoins) {
      if (now - seenAt > JOIN_DEDUPE_MS) this.#recentJoins.delete(key);
    }
    const key = `${chatId}:${userId}`;
    if (this.#recentJoins.has(key)) return false;
    this.#recentJoins.set(key, now);
    return true;
  }

  async #say(chatId: number, html: string, extra: { reply_markup?: InlineKeyboard } = {}): Promise<void> {
    try {
      await this.#api.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
    } catch (err) {
      log('warn', `could not post to group: ${errorMessage(err)}`, { chatId });
    }
  }

  async #dm(userId: number, html: string): Promise<void> {
    try {
      await this.#api.sendMessage(userId, html, { parse_mode: 'HTML' });
    } catch {
      // The user may never have opened a chat with the bot. The group message covers it.
    }
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
