import bs58 from "bs58";

/** A well-formed signature that no transaction has. */
export const neverSentSignature = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
