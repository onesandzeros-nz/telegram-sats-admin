// Prints a fresh 12-word BIP39 mnemonic for the bot's wallet.
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

console.log(generateMnemonic(wordlist, 128));
