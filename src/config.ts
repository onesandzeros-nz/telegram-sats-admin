import type { Network } from '@breeztech/breez-sdk-spark';

export interface AppConfig {
  botToken: string;
  breezApiKey: string;
  mnemonic: string;
  network: Network;
  entryFeeSats: number;
  invoiceExpirySecs: number;
  dataDir: string;
  breezLogFilter: string | undefined;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mnemonic = required(env, 'BREEZ_MNEMONIC').toLowerCase().replace(/\s+/g, ' ');
  const wordCount = mnemonic.split(' ').length;
  if (wordCount !== 12 && wordCount !== 24) {
    throw new ConfigError(`BREEZ_MNEMONIC must have 12 or 24 words, got ${wordCount}`);
  }

  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    breezApiKey: required(env, 'BREEZ_API_KEY'),
    mnemonic,
    network: parseNetwork(env.BREEZ_NETWORK),
    entryFeeSats: positiveInt(env, 'ENTRY_FEE_SATS', 1000),
    invoiceExpirySecs: positiveInt(env, 'INVOICE_EXPIRY_SECS', 24 * 60 * 60),
    dataDir: env.DATA_DIR?.trim() || './data',
    breezLogFilter: env.BREEZ_LOG_FILTER?.trim() || undefined,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required (set it in .env or the environment)`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function parseNetwork(raw: string | undefined): Network {
  const value = (raw?.trim() || 'mainnet').toLowerCase();
  if (value === 'mainnet' || value === 'regtest' || value === 'signet') return value;
  throw new ConfigError(`BREEZ_NETWORK must be mainnet, regtest or signet, got "${raw}"`);
}
