// Operate the bot's wallet from the command line. Stop the bot before running this:
// two processes must not use the same wallet storage at once.
//
//   npm run wallet -- balance
//   npm run wallet -- payments [limit]
//   npm run wallet -- send <bolt11|spark address|bitcoin address> [amountSats]
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Wallet } from '../src/wallet.ts';

const [command, arg1, arg2] = process.argv.slice(2);
if (!command || !['balance', 'payments', 'send'].includes(command)) {
  console.error('usage: npm run wallet -- balance | payments [limit] | send <destination> [amountSats]');
  process.exit(2);
}

const cfg = loadConfig();
const wallet = await Wallet.connect({
  apiKey: cfg.breezApiKey,
  mnemonic: cfg.mnemonic,
  network: cfg.network,
  storageDir: path.join(cfg.dataDir, 'wallet'),
  logFilter: cfg.breezLogFilter,
});

try {
  switch (command) {
    case 'balance':
      console.log(`${await wallet.balanceSats()} sats`);
      break;
    case 'payments': {
      const payments = await wallet.listRecentPayments(arg1 ? Number(arg1) : 20);
      for (const p of payments) {
        const when = new Date(p.timestamp * 1000).toISOString();
        const sign = p.paymentType === 'receive' ? '+' : '-';
        console.log(`${when}  ${sign}${p.amount} sats  fee ${p.fees}  ${p.method}  ${p.status}  ${p.id}`);
      }
      break;
    }
    case 'send': {
      if (!arg1) throw new Error('send requires a destination');
      const payment = await wallet.send(arg1, arg2 ? BigInt(arg2) : undefined);
      console.log(`sent ${payment.amount} sats (fee ${payment.fees}), status ${payment.status}, id ${payment.id}`);
      break;
    }
  }
} finally {
  await wallet.disconnect();
}
