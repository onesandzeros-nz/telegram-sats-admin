import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Bot } from 'grammy';
import { registerHandlers } from './bot.ts';
import { ConfigError, loadConfig, type AppConfig } from './config.ts';
import { Gate } from './gate.ts';
import { errorMessage, log } from './log.ts';
import { Store } from './store.ts';
import { Wallet } from './wallet.ts';

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(78); // EX_CONFIG: lets systemd stop instead of crash-looping on a bad .env
  }
  throw err;
}

mkdirSync(cfg.dataDir, { recursive: true });
const store = new Store(path.join(cfg.dataDir, 'gate.sqlite'));

log('info', `connecting Breez Spark wallet (${cfg.network})`);
const wallet = await Wallet.connect({
  apiKey: cfg.breezApiKey,
  mnemonic: cfg.mnemonic,
  network: cfg.network,
  storageDir: path.join(cfg.dataDir, 'wallet'),
  logFilter: cfg.breezLogFilter,
});
log('info', `wallet connected, balance: ${await wallet.balanceSats()} sats`);

const bot = new Bot(cfg.botToken);
await bot.init();

const gate = new Gate({ api: bot.api, store, wallet, cfg, botUsername: bot.botInfo.username });
registerHandlers(bot, gate, cfg);

wallet.onPaymentReceived((payment) => {
  gate.handlePayment(payment).catch((err) => log('error', `payment handling failed: ${errorMessage(err)}`, { paymentHash: payment.paymentHash }));
});
wallet.onSynced(() => void gate.reconcile());

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `${signal} received, shutting down`);
  try {
    await bot.stop();
  } catch (err) {
    log('warn', `error stopping bot: ${errorMessage(err)}`);
  }
  try {
    await wallet.disconnect();
  } catch (err) {
    log('warn', `error disconnecting wallet: ${errorMessage(err)}`);
  }
  store.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await bot.start({
  allowed_updates: ['message', 'chat_member', 'my_chat_member'],
  onStart: (me) => {
    log('info', `@${me.username} is running; entry fee ${cfg.entryFeeSats} sats`);
    void gate.reconcile();
  },
});
