// Integration test for the paywall logic. Uses a fake Telegram API and a throwaway
// regtest Spark wallet (no API key needed), so it talks to the Spark regtest operators.
// Run: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GrammyError, type Api } from 'grammy';
import type { AppConfig } from '../src/config.ts';
import { Gate } from '../src/gate.ts';
import { Store } from '../src/store.ts';
import { MUTED, UNRESTRICTED } from '../src/telegram.ts';
import { Wallet } from '../src/wallet.ts';

const timer = setTimeout(() => {
  console.error('gate.test.ts: timed out');
  process.exit(1);
}, 90_000);

type Call = { method: string; args: unknown[] };
const calls: Call[] = [];
let dmFails = true; // the user has never opened a chat with the bot
let restrictFails = false;

function telegramError(code: number, description: string, method: string): GrammyError {
  return new GrammyError('telegram', { ok: false, error_code: code, description }, method, {});
}

const fakeApi = {
  async restrictChatMember(chatId: number, userId: number, perms: unknown) {
    calls.push({ method: 'restrictChatMember', args: [chatId, userId, perms] });
    if (restrictFails) throw telegramError(400, 'Bad Request: not enough rights to restrict/unrestrict chat member', 'restrictChatMember');
    return true;
  },
  async sendPhoto(chatId: number, _file: unknown, other: { caption: string }) {
    calls.push({ method: 'sendPhoto', args: [chatId, other.caption.length] });
    if (dmFails) throw telegramError(403, "Forbidden: bot can't initiate conversation with a user", 'sendPhoto');
    return {};
  },
  async sendMessage(chatId: number, text: string, other?: { reply_markup?: { inline_keyboard: unknown[][] } }) {
    calls.push({ method: 'sendMessage', args: [chatId, text, other?.reply_markup?.inline_keyboard] });
    return {};
  },
} as unknown as Api;

const cfg: AppConfig = {
  botToken: 'test',
  breezApiKey: 'test',
  mnemonic: '',
  network: 'regtest',
  entryFeeSats: 1000,
  invoiceExpirySecs: 3600,
  dataDir: '',
  breezLogFilter: undefined,
};

const storageDir = mkdtempSync(path.join(tmpdir(), 'sats-gate-test-'));
const store = new Store(':memory:');
const wallet = await Wallet.connect({
  apiKey: 'test',
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  network: 'regtest',
  storageDir,
});

try {
  const deps = { api: fakeApi, store, wallet, cfg, botUsername: 'sats_gate_bot' };
  const gate = new Gate(deps);
  const chat = { id: -1001234567890, type: 'supergroup', title: 'Sats & Chats' } as const;
  const alice = { id: 42, is_bot: false, first_name: 'Alice', last_name: '<Hacker>' };

  // 1. join; DM fails -> group message with deep-link button
  await gate.handleJoin(chat as never, alice);
  assert.deepEqual(calls.map((c) => c.method), ['restrictChatMember', 'sendPhoto', 'sendMessage']);
  assert.deepEqual(calls[0]!.args[2], MUTED);
  const welcome = calls[2]!;
  assert.ok(String(welcome.args[1]).includes('Tap the button below'));
  assert.ok(String(welcome.args[1]).includes('&lt;Hacker&gt;'), 'name is HTML-escaped');
  const button = (welcome.args[2] as Array<Array<{ url: string; text: string }>>)[0]![0]!;
  assert.equal(button.url, 'https://t.me/sats_gate_bot?start=c-1001234567890');
  assert.equal(button.text, '⚡ Pay 1,000 sats');
  assert.equal(store.getMember(chat.id, alice.id)!.status, 'pending');
  const invoice = store.latestOpenInvoice(chat.id, alice.id, 0)!;
  assert.equal(invoice.amountSats, 1000);

  // 2. the same join reported again is ignored
  calls.length = 0;
  await gate.handleJoin(chat as never, alice);
  assert.equal(calls.length, 0);

  // 3. /start deep link re-sends the same invoice; the DM works now
  dmFails = false;
  assert.equal(await gate.sendInvoice(alice.id, chat.id), 'sent');
  assert.equal(calls.filter((c) => c.method === 'sendPhoto').length, 1);
  assert.equal(store.latestOpenInvoice(chat.id, alice.id, 0)!.paymentHash, invoice.paymentHash, 'invoice reused');
  assert.ok((calls[0]!.args[1] as number) < 1024, 'caption fits Telegram limit');

  // 4. an unrelated payment does nothing
  calls.length = 0;
  await gate.handlePayment({ paymentId: 'x', paymentHash: 'deadbeef', bolt11: 'lnbcrt1nothing', amountSats: 1000n, feesSats: 0n, timestamp: 0 });
  assert.equal(calls.length, 0);

  // 5. the matching payment unlocks the member
  await gate.handlePayment({ paymentId: 'p1', paymentHash: invoice.paymentHash, bolt11: invoice.bolt11, amountSats: 1000n, feesSats: 0n, timestamp: 0 });
  assert.deepEqual(calls.map((c) => c.method), ['restrictChatMember', 'sendMessage', 'sendMessage']);
  assert.deepEqual(calls[0]!.args[2], UNRESTRICTED);
  assert.ok(String(calls[1]!.args[1]).includes('paid 1,000 sats and can now post'));
  assert.equal(calls[2]!.args[0], alice.id, 'confirmation DM');
  assert.equal(store.getMember(chat.id, alice.id)!.status, 'paid');

  // 6. the same payment reported twice is a no-op
  calls.length = 0;
  await gate.handlePayment({ paymentId: 'p1', paymentHash: invoice.paymentHash, bolt11: invoice.bolt11, amountSats: 1000n, feesSats: 0n, timestamp: 0 });
  assert.equal(calls.length, 0);

  // 7. a paid member who rejoins is left alone; /start states
  const gate2 = new Gate(deps); // fresh dedupe window
  await gate2.handleJoin(chat as never, alice);
  assert.equal(calls.length, 0);
  assert.equal(await gate2.sendInvoice(alice.id, chat.id), 'already_paid');
  assert.equal(await gate2.sendInvoice(999, chat.id), 'no_entry');

  // 8. when the bot lacks rights it warns the group and issues no invoice
  restrictFails = true;
  const bob = { id: 43, is_bot: false, first_name: 'Bob' };
  await gate2.handleJoin(chat as never, bob);
  assert.deepEqual(calls.map((c) => c.method), ['restrictChatMember', 'sendMessage']);
  assert.ok(String(calls[1]!.args[1]).includes('Ban users'));
  assert.equal(store.latestOpenInvoice(chat.id, bob.id, 0), undefined);

  // 9. bots are ignored
  calls.length = 0;
  await gate2.handleJoin(chat as never, { id: 7, is_bot: true, first_name: 'SomeBot' });
  assert.equal(calls.length, 0);

  // 10. reconcile runs cleanly with an open invoice outstanding
  restrictFails = false;
  await gate2.handleJoin(chat as never, { id: 44, is_bot: false, first_name: 'Carol' });
  assert.equal(store.openInvoiceWindow().count, 1);
  await gate2.reconcile();
  assert.equal(store.getMember(chat.id, 44)!.status, 'pending');

  console.log('gate.test.ts: ok');
} finally {
  await wallet.disconnect();
  store.close();
  rmSync(storageDir, { recursive: true, force: true });
  clearTimeout(timer);
}
