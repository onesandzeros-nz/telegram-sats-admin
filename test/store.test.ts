// Unit tests for the SQLite store and Telegram helpers. Run: npm test
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { UNRESTRICTED, deepLinkPayload, displayName, parseDeepLinkPayload } from '../src/telegram.ts';

const s = new Store(':memory:');
const now = 1_700_000_000;

assert.equal(s.getMember(-100123, 42), undefined);
const m = s.ensurePending(-100123, 42, 'Alice', 'Test Group', now);
assert.equal(m.status, 'pending');
assert.equal(m.chatTitle, 'Test Group');
const m2 = s.ensurePending(-100123, 42, 'Alice B', 'Test Group', now + 5);
assert.equal(m2.displayName, 'Alice B', 'name refreshed');
assert.equal(m2.createdAt, now, 'created_at kept');

assert.equal(s.openInvoiceWindow().count, 0);
s.insertInvoice({ paymentHash: 'h1', chatId: -100123, userId: 42, bolt11: 'LNBC10U1ABC', amountSats: 1000, createdAt: now, expiresAt: now + 3600, paidAt: null });
assert.deepEqual(s.openInvoiceWindow(), { count: 1, oldestCreatedAt: now });
assert.equal(s.latestOpenInvoice(-100123, 42, now + 120)?.paymentHash, 'h1');
assert.equal(s.latestOpenInvoice(-100123, 42, now + 4000), undefined, 'expired invoice is not reused');
assert.equal(s.getInvoiceByBolt11('lnbc10u1abc')?.paymentHash, 'h1', 'bolt11 lookup is case-insensitive');
assert.equal(s.claimInvoicePaid('h1', now + 10), true);
assert.equal(s.claimInvoicePaid('h1', now + 11), false, 'second claim is rejected');
assert.equal(s.claimInvoicePaid('nope', now), false);
s.markMemberPaid(-100123, 42, now + 10);
assert.equal(s.getMember(-100123, 42)?.status, 'paid');
assert.equal(s.openInvoiceWindow().count, 0);
assert.deepEqual(s.listPendingForUser(42), []);
s.ensurePending(-100999, 42, 'Alice', 'Other', now);
assert.equal(s.listPendingForUser(42).length, 1);
s.close();

assert.equal(parseDeepLinkPayload(deepLinkPayload(-1001234567890)), -1001234567890);
assert.equal(parseDeepLinkPayload('c-100'), -100);
assert.equal(parseDeepLinkPayload('garbage'), undefined);
assert.equal(parseDeepLinkPayload(''), undefined);
assert.ok(Object.values(UNRESTRICTED).every((v) => v === true) && Object.keys(UNRESTRICTED).length === 14);
assert.equal(displayName({ id: 1, is_bot: false, first_name: 'A', last_name: 'B' }), 'A B');
assert.equal(displayName({ id: 1, is_bot: false, first_name: '', username: 'x' }), '@x');

console.log('store.test.ts: ok');
