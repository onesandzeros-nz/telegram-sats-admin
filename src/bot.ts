import { Bot, type Context } from 'grammy';
import type { AppConfig } from './config.ts';
import type { Gate } from './gate.ts';
import { errorMessage, log } from './log.ts';
import { escapeHtml, formatSats, isGroupChat, isMember, isPrivileged, parseDeepLinkPayload } from './telegram.ts';

export function registerHandlers(bot: Bot, gate: Gate, cfg: AppConfig): void {
  bot.catch((err) => {
    log('error', `unhandled error in update ${err.ctx.update.update_id}: ${errorMessage(err.error)}`);
  });

  // Log our own status changes so it is obvious when the bot is added, promoted or removed.
  bot.on('my_chat_member', (ctx) => {
    const { chat, old_chat_member, new_chat_member } = ctx.myChatMember;
    log('info', `bot status in "${'title' in chat ? chat.title : chat.id}" changed: ${old_chat_member.status} -> ${new_chat_member.status}`, {
      chatId: chat.id,
    });
  });

  // Primary join signal. Requires the bot to be an admin and `chat_member` in allowed_updates.
  bot.on('chat_member', async (ctx) => {
    const { chat, old_chat_member: before, new_chat_member: after } = ctx.chatMember;
    if (!isGroupChat(chat)) return;
    if (isMember(before) || !isMember(after)) return; // not a join
    if (isPrivileged(after)) return; // admins cannot be restricted
    await gate.handleJoin(chat, after.user);
  });

  // Fallback join signal via the service message. Gate dedupes against the chat_member update.
  bot.on('message:new_chat_members', async (ctx) => {
    if (!isGroupChat(ctx.chat)) return;
    for (const user of ctx.message.new_chat_members) {
      if (user.id === ctx.me.id) continue;
      await gate.handleJoin(ctx.chat, user);
    }
  });

  const dm = bot.chatType('private');

  dm.command('start', async (ctx) => {
    const chatId = parseDeepLinkPayload(ctx.match);
    if (chatId !== undefined) {
      await deliverInvoice(ctx, gate, chatId);
      return;
    }

    const pending = gate.pendingEntriesFor(ctx.from.id);
    if (pending.length === 1) {
      await deliverInvoice(ctx, gate, pending[0]!.chatId);
      return;
    }
    if (pending.length > 1) {
      const lines = pending.map((m) => `• <b>${escapeHtml(m.chatTitle || String(m.chatId))}</b>`).join('\n');
      await ctx.reply(
        `You have unpaid entry fees in several groups:\n${lines}\n\n` +
          `Use the "Pay" button in the group's welcome message to get the right invoice.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.reply(helpText(cfg), { parse_mode: 'HTML' });
  });

  dm.command('help', (ctx) => ctx.reply(helpText(cfg), { parse_mode: 'HTML' }));
}

async function deliverInvoice(ctx: Context, gate: Gate, chatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  try {
    const result = await gate.sendInvoice(userId, chatId);
    switch (result) {
      case 'sent':
        return; // the invoice itself is the reply
      case 'already_paid':
        await ctx.reply('✅ You have already paid the entry fee for that group. Nothing more to do.');
        return;
      case 'no_entry':
        await ctx.reply("I don't have a pending entry fee for you in that group. Join it first and I'll invoice you.");
        return;
      case 'dm_failed':
        await ctx.reply('Something went wrong sending your invoice. Please try /start again in a moment.');
        return;
    }
  } catch (err) {
    log('error', `failed to deliver invoice: ${errorMessage(err)}`, { userId, chatId });
    await ctx.reply('I could not create your invoice right now. Please try again in a few minutes.');
  }
}

function helpText(cfg: AppConfig): string {
  return (
    `I guard Telegram groups with a Lightning paywall.\n\n` +
    `When you join a group I manage, you are muted until you pay a one-time entry fee of ` +
    `<b>${formatSats(cfg.entryFeeSats)} sats</b>. I'll send the invoice here; once it's paid you are unmuted automatically.\n\n` +
    `Nothing pending for you right now.`
  );
}
