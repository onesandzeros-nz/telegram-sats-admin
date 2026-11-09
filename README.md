# telegram-sats-admin

A Telegram bot that guards a group with a Lightning paywall. Every new member
is muted the moment they join and stays muted until they pay a one-time entry
fee (default **1,000 sats**). The fee is invoiced from, and paid into, a
self-custodial Spark wallet run by the bot through the
[Breez SDK - Nodeless (Spark)](https://sdk-doc-spark.breez.technology/).

No channels, no Lightning node, no inbound ports. One Node.js process, one
SQLite file, one mnemonic.

## How it works

```
 member joins                bot                              Spark wallet
 ───────────►  chat_member update
               restrictChatMember(all permissions off)
               receivePayment(bolt11, 1000 sats)  ──────────►  invoice
               DM: QR + invoice  (or "Pay" button in group)
                                                               payment arrives
               paymentSucceeded event  ◄──────────────────────
               match payment hash → invoice → member
               restrictChatMember(all permissions on)
               "Alice paid 1,000 sats and can now post"
```

### 1. Detecting the join

Telegram sends admins a `chat_member` update whenever someone's status in the
group changes. The bot treats a transition from *not a member* to *member* as
a join. It also listens to the "X joined the group" service message as a
fallback and dedupes the two within a 30 second window, so a join that is
reported twice is handled once. Bots and admins are never gated. People who
were already in the group before the bot arrived are untouched.

### 2. Muting

The bot calls `restrictChatMember` with every permission switched off and no
expiry. The member can read the group but cannot send text, media, stickers,
polls, reactions or anything else. Telegram only supports per-member
restrictions in **supergroups** (see below), and only for admins holding the
**Ban users** permission. If either is missing the bot posts a one-line warning
in the group explaining what it needs, at most once every ten minutes.

### 3. Invoicing

The bot asks the Spark wallet for a bolt11 invoice with a fixed amount, a
description naming the group, and a 24 hour expiry. It parses the invoice to
extract the payment hash and stores `payment hash → (chat, user)` in SQLite.

The invoice is sent to the member as a private message: a QR code image with
the invoice text in the caption, in monospace so it can be tap-copied.
Telegram does not let a bot message someone who has never opened a chat with
it, so the welcome message posted in the group carries a **⚡ Pay 1,000 sats**
button. It deep-links to the bot with the group ID in the `/start` payload,
and the bot replies with the invoice. If the member asks again, the same
unexpired invoice is reused; once it has under two minutes left, a new one is
issued.

### 4. Detecting payment

The Breez SDK emits a `paymentSucceeded` event when an incoming payment
settles. The bot reads the HTLC payment hash from the payment, looks up the
invoice, and marks it paid with a single atomic SQL update. If that update
reports no change, the payment was already handled and nothing more happens,
which makes it safe for the same payment to be reported more than once.

Matching on payment hash alone is enough because the invoice carries a fixed
amount: Lightning does not allow underpaying a fixed-amount invoice. Any
payment that does not match one of the bot's invoices is logged and ignored.

### 5. Unlocking

The bot calls `restrictChatMember` again with every permission switched on,
which Telegram treats as lifting the restriction. The member then has whatever
the group's default permissions allow. The bot announces the payment in the
group and confirms by DM. Transient Telegram errors are retried three times;
a permanent one (for example the bot lost its admin role) produces a warning
in the group so an admin can unmute by hand.

### 6. Catching up after downtime

Payment events only arrive while the bot is running. On startup, and after
every wallet sync (roughly once a minute), the bot checks whether any invoices
are still open and, if so, lists completed incoming payments from the wallet
since the oldest open invoice was created and runs each through the same
matching code. A fee paid while the bot was offline unlocks the member as soon
as it comes back.

### What is stored

Two tables in `data/gate.sqlite`:

| Table      | Contents                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `members`  | `(chat, user)` → status `pending` or `paid`, display name, group title     |
| `invoices` | payment hash → `(chat, user)`, bolt11, amount, created/expires/paid times  |

Paid members are remembered, so leaving and rejoining does not cost a second
fee. The Spark SDK keeps its own state under `data/wallet/`. Both directories
should persist across restarts; the mnemonic alone recovers the funds, but not
the record of who has paid.

### Design decisions worth knowing

- **Single instance.** Telegram long polling and the wallet storage both assume
  exactly one running copy. Run it under a supervisor, not a scaler.
- **`preferSparkOverLightning` is pinned off.** With it on, the SDK embeds a
  Spark fallback address in each invoice, and a payment sent to that address
  cannot be linked back to the invoice. Breez advise against enabling it.
- **Config errors exit with code 78.** The systemd unit treats that exit as
  "do not restart", so a bad `.env` fails loudly instead of crash-looping.
- **No kicking.** Unpaid members simply stay muted until they pay or an admin
  removes them.

## Requirements

- Node.js 22.18 or newer (24+ recommended). The bot runs TypeScript directly
  with Node's built-in type stripping and uses the built-in `node:sqlite`.
  Linux x64 and arm64 with glibc are covered by the SDK's prebuilt native
  module; use a Debian-based image rather than Alpine in Docker.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A Breez SDK API key. Request one at
  <https://breez.technology/request-api-key/>.
- A **supergroup**, with the bot as an **admin** holding the **Ban users**
  permission.

### Making sure the group is a supergroup

Basic groups cannot restrict individual members, and the bot will say
`method is available only in supergroups` if it is added to one. Most Telegram
clients no longer have a "convert" button; the group upgrades automatically
when you enable a supergroup-only setting. Open the group, tap its name, then
**Edit**, and either set **Group Type** to Public (you can switch back to
Private afterwards) or set **Chat History for New Members** to Visible.
Telegram will confirm the upgrade. The group gets a new ID, which the bot picks
up automatically, and admin roles carry over. Members already in the group at
that point are not charged.

## Setup

```bash
npm install
cp .env.example .env
npm run mnemonic      # prints a fresh 12-word seed for the bot's wallet
```

Fill in `.env`:

| Variable              | Required | Meaning                                                                    |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | yes      | Token from BotFather.                                                      |
| `BREEZ_API_KEY`       | yes      | Breez SDK API key.                                                         |
| `BREEZ_MNEMONIC`      | yes      | 12 or 24 word seed for the wallet. **Back it up.** It is the only key to the sats the bot collects. |
| `BREEZ_NETWORK`       | no       | `mainnet` (default), `regtest` or `signet`.                                |
| `ENTRY_FEE_SATS`      | no       | Fee per new member. Default `1000`.                                        |
| `INVOICE_EXPIRY_SECS` | no       | Invoice lifetime. Default `86400` (24 h).                                  |
| `DATA_DIR`            | no       | Where the SQLite database and wallet state live. Default `./data`.         |
| `BREEZ_LOG_FILTER`    | no       | Breez SDK log filter such as `info`. Off when unset.                       |
| `LOG_LEVEL`           | no       | Bot log level: `debug`, `info` (default), `warn`, `error`.                 |

Then add the bot to your supergroup and promote it to admin with **Ban users**.
Without admin rights Telegram does not deliver join updates to the bot at all.

## Run

```bash
npm start
```

The bot uses long polling, so it needs no public URL. Logs go to stdout. Keep
`data/` on persistent storage.

## Deploying on a server (systemd)

`deploy/` holds a systemd unit, an idempotent installer and a wallet helper.
From this directory:

```bash
rsync -a --delete --exclude node_modules --exclude data --exclude .env \
  --rsync-path="sudo rsync" ./ <host>:/opt/telegram-sats-admin/
ssh <host> sudo bash /opt/telegram-sats-admin/deploy/install.sh
```

The first run adds a 1 GB swapfile on hosts with under 1.5 GB RAM, installs
Node 26 into `/usr/local`, creates the `satsadmin` system user, writes
`/etc/telegram-sats-admin.env` with a freshly generated wallet mnemonic, and
starts the service. Fill in `TELEGRAM_BOT_TOKEN` and `BREEZ_API_KEY` in that
file and run `sudo systemctl restart telegram-sats-admin`. While the env file
is incomplete the service exits with code 78 and stays stopped.

Re-running the same two commands redeploys code changes. The env file and the
data directory `/var/lib/telegram-sats-admin` are never touched.

```bash
journalctl -u telegram-sats-admin -f      # logs
sats-wallet balance                       # wallet CLI; stops the bot while it runs, restarts after
```

The bot idles at around 150 MB of RAM. The smallest VPS or cloud instance is
enough; add swap on anything under 1 GB.

## Operating the wallet

Collected fees sit in the bot's Spark wallet. The wallet script shares the
bot's `.env` and `DATA_DIR`. **Stop the bot before using it locally**; on a
server use `sats-wallet`, which does that for you.

```bash
npm run wallet -- balance
npm run wallet -- payments 20
npm run wallet -- send <bolt11 | spark address | bitcoin address> [amountSats]
```

`send` pays a fixed-amount invoice as-is; supply `amountSats` for an
amountless invoice or an address. Spark and Lightning routing fees may be
deducted from what lands in the wallet, so the balance can grow by slightly
less than the fee per member.

## Commands the bot understands

In a private chat:

- `/start` — sends your pending invoice if you have exactly one, otherwise help.
- `/start c<chatId>` — what the group button sends; delivers the invoice for that group.
- `/help` — explains what the bot does.

The bot ignores all other messages and never posts in the group except for the
welcome, the paid confirmation, and admin-permission warnings.

## Project layout

```
src/index.ts       wiring, startup, graceful shutdown
src/config.ts      environment parsing and validation
src/store.ts       SQLite (node:sqlite) records of members and invoices
src/wallet.ts      Breez Spark SDK wrapper: connect, create invoice, payment events
src/gate.ts        the paywall: mute on join, invoice, unlock on payment, reconcile
src/bot.ts         grammY update handlers (chat_member, new_chat_members, /start)
src/telegram.ts    permission sets, mention/escape helpers, deep-link encoding
scripts/           new-mnemonic.mjs, wallet.ts
deploy/            systemd unit, install.sh, sats-wallet helper
test/              store unit tests, gate integration test
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # store unit tests + gate integration test
```

The gate test drives the full paywall with a fake Telegram API and a
throwaway **regtest** Spark wallet. It needs network access but no API key,
and leaves nothing behind.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Group message: `method is available only in supergroups`       | The chat is a basic group. Convert it (see above).                                              |
| Group message: `not enough rights to restrict/unrestrict`      | Promote the bot to admin with **Ban users**.                                                    |
| Nothing happens when someone joins                             | The bot is not an admin, so Telegram sends it no join updates. Check `my_chat_member` lines in the log. |
| Service exits with status 78                                   | `.env` is incomplete or invalid. The log line starting `Configuration error:` says which key.   |
| Members get the group button but no DM                         | Expected for anyone who never opened a chat with the bot. The button fixes it.                  |
| Member paid but is still muted                                 | Check the log for `unmute failed`. Usually the bot lost its admin role; unmute by hand.          |

## Limits

- Only payments to the bot's own invoices unlock anyone.
- The mute lands when the join update is processed, normally well under a
  second. A message fired in that instant can get through, as can anything
  posted while the bot is offline.
- Admins can lift restrictions manually; the bot does not fight that.
- If a group converts to a supergroup while invoices are outstanding, those
  records stay under the old chat ID.
