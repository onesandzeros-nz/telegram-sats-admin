import {
  connect,
  defaultConfig,
  initLogging,
  type BreezSdk,
  type Network,
  type Payment,
  type SdkEvent,
} from '@breeztech/breez-sdk-spark';
import { errorMessage, log } from './log.ts';

export interface WalletOptions {
  apiKey: string;
  mnemonic: string;
  network: Network;
  storageDir: string;
  logFilter?: string | undefined;
}

export interface CreatedInvoice {
  bolt11: string;
  paymentHash: string;
  amountSats: number;
  /** Unix seconds. */
  expiresAt: number;
}

/** A completed incoming Lightning payment, reduced to what the gate needs. */
export interface ReceivedPayment {
  paymentId: string;
  paymentHash: string;
  bolt11: string;
  amountSats: bigint;
  feesSats: bigint;
  timestamp: number;
}

type PaymentHandler = (payment: ReceivedPayment) => void;
type SyncedHandler = () => void;

/** Thin wrapper around the Breez Spark SDK: one wallet, invoices in, payment events out. */
export class Wallet {
  readonly #sdk: BreezSdk;
  readonly #paymentHandlers: PaymentHandler[] = [];
  readonly #syncedHandlers: SyncedHandler[] = [];

  private constructor(sdk: BreezSdk) {
    this.#sdk = sdk;
  }

  static async connect(opts: WalletOptions): Promise<Wallet> {
    if (opts.logFilter) {
      await initLogging(
        { log: (entry) => log('debug', `[breez:${entry.level}] ${entry.line}`) },
        opts.logFilter,
      );
    }

    const config = defaultConfig(opts.network);
    config.apiKey = opts.apiKey;
    // Keep invoices settleable only in ways that preserve the payment hash. With this on, the SDK
    // embeds a Spark fallback address in each invoice, and a payment to that address cannot be
    // linked back to the invoice (so the member could never be unlocked).
    config.preferSparkOverLightning = false;

    const sdk = await connect({
      config,
      seed: { type: 'mnemonic', mnemonic: opts.mnemonic, passphrase: undefined },
      storageDir: opts.storageDir,
    });

    const wallet = new Wallet(sdk);
    await sdk.addEventListener({ onEvent: (event) => wallet.#onEvent(event) });
    return wallet;
  }

  onPaymentReceived(handler: PaymentHandler): void {
    this.#paymentHandlers.push(handler);
  }

  onSynced(handler: SyncedHandler): void {
    this.#syncedHandlers.push(handler);
  }

  async createInvoice(amountSats: number, description: string, expirySecs: number): Promise<CreatedInvoice> {
    const response = await this.#sdk.receivePayment({
      paymentMethod: { type: 'bolt11Invoice', description, amountSats, expirySecs },
    });
    const bolt11 = response.paymentRequest;

    const parsed = await this.#sdk.parse(bolt11);
    if (parsed.type !== 'bolt11Invoice') {
      throw new Error(`SDK returned a payment request that did not parse as bolt11 (type=${parsed.type})`);
    }

    log('debug', 'invoice created', { paymentHash: parsed.paymentHash, amountSats, receiveFeeSats: response.fee });
    return {
      bolt11,
      paymentHash: parsed.paymentHash,
      amountSats,
      expiresAt: parsed.timestamp + parsed.expiry,
    };
  }

  /** Completed incoming invoice payments (Lightning, or a Spark transfer that settled a bolt11), newest first. */
  async listCompletedReceives(fromTimestamp?: number): Promise<ReceivedPayment[]> {
    const response = await this.#sdk.listPayments({
      typeFilter: ['receive'],
      statusFilter: ['completed'],
      paymentDetailsFilter: [{ type: 'lightning' }, { type: 'spark' }],
      fromTimestamp,
      limit: 500,
      sortAscending: false,
    });
    return response.payments.map(toReceived).filter((p): p is ReceivedPayment => p !== undefined);
  }

  async listRecentPayments(limit = 20): Promise<Payment[]> {
    const response = await this.#sdk.listPayments({ limit, sortAscending: false });
    return response.payments;
  }

  async balanceSats(): Promise<number> {
    const info = await this.#sdk.getInfo({ ensureSynced: false });
    return info.balanceSats;
  }

  /** Pay a bolt11 invoice, Spark address or on-chain address. `amountSats` is only needed for amountless destinations. */
  async send(destination: string, amountSats?: bigint): Promise<Payment> {
    const prepared = await this.#sdk.prepareSendPayment({
      paymentRequest: { type: 'input', input: destination },
      amount: amountSats,
    });
    const response = await this.#sdk.sendPayment({ prepareResponse: prepared });
    return response.payment;
  }

  async disconnect(): Promise<void> {
    await this.#sdk.disconnect();
  }

  #onEvent(event: SdkEvent): void {
    switch (event.type) {
      case 'synced':
        for (const handler of this.#syncedHandlers) safely(handler);
        break;
      case 'paymentSucceeded': {
        const received = toReceived(event.payment);
        if (!received) {
          log('debug', 'payment succeeded (not an incoming invoice payment)', { id: event.payment.id });
          break;
        }
        log('info', 'incoming payment completed', {
          paymentHash: received.paymentHash,
          amountSats: received.amountSats,
        });
        for (const handler of this.#paymentHandlers) safely(() => handler(received));
        break;
      }
      case 'paymentPending':
        log('debug', 'payment pending', { id: event.payment.id, type: event.payment.paymentType });
        break;
      case 'paymentFailed':
        log('warn', 'payment failed', { id: event.payment.id, type: event.payment.paymentType });
        break;
      default:
        break;
    }
  }
}

/**
 * Reduce an incoming payment to the fields the gate matches on. A bolt11 invoice issued by this
 * wallet is normally settled over Lightning, but another Spark wallet may settle it with a direct
 * Spark transfer instead; in both cases the HTLC payment hash is the invoice's payment hash.
 */
function toReceived(payment: Payment): ReceivedPayment | undefined {
  if (payment.paymentType !== 'receive') return undefined;
  const details = payment.details;
  if (!details) return undefined;

  let paymentHash: string | undefined;
  let bolt11 = '';
  if (details.type === 'lightning') {
    paymentHash = details.htlcDetails?.paymentHash;
    bolt11 = details.invoice;
  } else if (details.type === 'spark') {
    paymentHash = details.htlcDetails?.paymentHash;
  } else {
    return undefined;
  }
  if (!paymentHash && !bolt11) return undefined;

  return {
    paymentId: payment.id,
    paymentHash: paymentHash ?? '',
    bolt11,
    amountSats: payment.amount,
    feesSats: payment.fees,
    timestamp: payment.timestamp,
  };
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log('error', `event handler threw: ${errorMessage(err)}`);
  }
}
