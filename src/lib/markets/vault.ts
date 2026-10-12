/**
 * The only module that talks to MetaDAO's conditional vault (program VLTX1…, the build devnet runs
 * matches the SDK's v0.4 IDL). That SDK runs on Anchor 0.29 while the Meteora SDKs run on 0.31, so
 * nothing Anchor-typed leaves this file: callers get plain web3.js instructions and addresses.
 *
 * Collateral is wrapped SOL. Splitting 1 wSOL mints 1 YES + 1 NO; after resolution each token
 * redeems for its payout share of 1 wSOL.
 */
import {
  ConditionalVaultClient,
  getConditionalTokenMintAddr,
  getQuestionAddr,
  getVaultAddr,
} from "@metadaoproject/futarchy/v0.4";
import { NATIVE_MINT } from "@solana/spl-token";
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type BN from "bn.js";
import { NUM_OUTCOMES, OUTCOME_INDEX, type Side } from "./math";

export type VaultKeys = {
  question: PublicKey;
  vault: PublicKey;
  /** Conditional token mints, by side. */
  mints: Record<Side, PublicKey>;
};

type Client = ConditionalVaultClient;
type Provider = ConstructorParameters<typeof ConditionalVaultClient>[0];

/**
 * A read-and-build client. Anchor 0.29 only needs the connection from its provider to build and
 * fetch; nothing here signs or sends, so no wallet is attached.
 */
function client(connection: Connection): Client {
  return ConditionalVaultClient.createClient({ provider: { connection } as unknown as Provider });
}

/** Program id is fixed by the SDK (same on devnet and mainnet). */
const programId = (vc: Client) => vc.vaultProgram.programId;

export function vaultKeys(connection: Connection, questionId: Uint8Array, oracle: PublicKey): VaultKeys {
  const id = programId(client(connection));
  const [question] = getQuestionAddr(id, questionId, oracle, NUM_OUTCOMES);
  const [vault] = getVaultAddr(id, question, NATIVE_MINT);
  const mint = (side: Side) => getConditionalTokenMintAddr(id, vault, OUTCOME_INDEX[side])[0];
  return { question, vault, mints: { yes: mint("yes"), no: mint("no") } };
}

const allInstructions = async (builder: { transaction(): Promise<{ instructions: TransactionInstruction[] }> }) =>
  (await builder.transaction()).instructions;

/** Creates the question (oracle = who may resolve) and its wSOL vault with YES/NO mints. */
export async function initializeMarketIxs(connection: Connection, questionId: Uint8Array, oracle: PublicKey, payer: PublicKey): Promise<TransactionInstruction[]> {
  const vc = client(connection);
  const { question } = vaultKeys(connection, questionId, oracle);
  return [
    await vc.initializeQuestionIx(questionId, oracle, NUM_OUTCOMES).accounts({ payer }).instruction(),
    ...(await allInstructions(vc.initializeVaultIx(question, NATIVE_MINT, NUM_OUTCOMES, payer).accounts({ payer }))),
  ];
}

/**
 * Names for the YES/NO mints, so wallets show what they are. Optional: on mainnet MetaDAO lets only
 * its deployer pay for this, so the market never depends on it.
 */
export async function metadataIxs(connection: Connection, keys: VaultKeys, payer: PublicKey, names: Record<Side, { name: string; symbol: string; uri: string }>): Promise<TransactionInstruction[]> {
  const vc = client(connection);
  const metadata = (side: Side) =>
    vc.addMetadataToConditionalTokensIx(keys.vault, OUTCOME_INDEX[side], names[side].name, names[side].symbol, names[side].uri, payer).instruction();
  return [await metadata("yes"), await metadata("no")];
}

/** wSOL in `user`'s wrapped-SOL account → `amount` YES + `amount` NO (token accounts created if missing). */
export async function splitIxs(connection: Connection, keys: VaultKeys, user: PublicKey, amount: BN): Promise<TransactionInstruction[]> {
  return allInstructions(client(connection).splitTokensIx(keys.question, keys.vault, NATIVE_MINT, amount, NUM_OUTCOMES, user, user));
}

/** `amount` YES + `amount` NO → `amount` wSOL, before resolution. */
export async function mergeIxs(connection: Connection, keys: VaultKeys, user: PublicKey, amount: BN): Promise<TransactionInstruction[]> {
  return allInstructions(client(connection).mergeTokensIx(keys.question, keys.vault, NATIVE_MINT, amount, NUM_OUTCOMES, user, user));
}

/** Burns all of `user`'s YES and NO and pays their share of wSOL to the user's wrapped-SOL account. */
export async function redeemIxs(connection: Connection, keys: VaultKeys, user: PublicKey): Promise<TransactionInstruction[]> {
  return allInstructions(client(connection).redeemTokensIx(keys.question, keys.vault, NATIVE_MINT, NUM_OUTCOMES, user, user));
}

/** Only the question's oracle can sign this, once. */
export async function resolveIx(connection: Connection, question: PublicKey, oracle: PublicKey, numerators: number[]): Promise<TransactionInstruction> {
  return client(connection).vaultProgram.methods.resolveQuestion({ payoutNumerators: numerators }).accounts({ question, oracle }).instruction();
}

export type QuestionState = { questionId: Uint8Array; oracle: PublicKey; resolved: boolean; numerators: number[] };

/** null if the question doesn't exist. Resolved once the denominator (sum of numerators) is set. */
export async function fetchQuestion(connection: Connection, question: PublicKey): Promise<QuestionState | null> {
  const state = await client(connection).fetchQuestion(question);
  if (!state) return null;
  return {
    questionId: Uint8Array.from(state.questionId),
    oracle: state.oracle,
    resolved: state.payoutDenominator !== 0,
    numerators: state.payoutNumerators,
  };
}
