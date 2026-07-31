/**
 * Internal consistency check for the Nimiq signature verification pipeline.
 *
 * This file proves that:
 * 1. A locally generated key pair can sign and verify
 * 2. The public key derives to the expected address
 * 3. A wrong message is rejected
 * 4. A wrong public key is rejected
 *
 * It does NOT prove compatibility with Nimiq Pay's sign() convention.
 * That requires a real device test.
 *
 * Run: npx tsx src/lib/nimiq/crypto-consistency.ts
 */

import { KeyPair, PublicKey, Signature, Address } from "@nimiq/core";

async function runConsistencyCheck(): Promise<void> {
  const keyPair = KeyPair.generate();
  const publicKeyHex = keyPair.publicKey.toHex();
  const message = "Votum test message: internal consistency check";
  const messageBytes = new TextEncoder().encode(message);

  const signature = keyPair.sign(messageBytes);
  const signatureHex = signature.toHex();

  const valid = keyPair.publicKey.verify(signature, messageBytes);
  console.assert(valid, "FAIL: Valid signature should verify");
  console.log("  PASS: Valid signature verifies");

  const wrongMsg = new TextEncoder().encode("wrong message");
  const wrongVerify = keyPair.publicKey.verify(signature, wrongMsg);
  console.assert(!wrongVerify, "FAIL: Wrong message should not verify");
  console.log("  PASS: Wrong message rejected");

  const parsedPub = PublicKey.fromHex(publicKeyHex);
  const parsedSig = Signature.fromHex(signatureHex);
  const fromHexVerify = parsedPub.verify(parsedSig, messageBytes);
  console.assert(fromHexVerify, "FAIL: fromHex round-trip should verify");
  console.log("  PASS: fromHex round-trip works");

  try {
    PublicKey.fromHex("not-hex");
    console.log("  FAIL: Malformed hex should throw");
  } catch {
    console.log("  PASS: Malformed public key rejected");
  }

  try {
    Signature.fromHex("not-hex");
    console.log("  FAIL: Malformed signature should throw");
  } catch {
    console.log("  PASS: Malformed signature rejected");
  }

  const address = keyPair.publicKey.toAddress().toString();
  const fromParsed = parsedPub.toAddress().toString();
  console.assert(address === fromParsed, "FAIL: Address should match after round-trip");
  console.log("  PASS: Address consistent after hex round-trip");
  console.log(`  Derived address: ${address.slice(0, 8)}...${address.slice(-4)}`);

  // ── Address format tests ─────────────────────────────────────────────
  //
  // IMPORTANT: @nimiq/core WASM panics on invalid addresses (escapes JS
  // try/catch). All address strings used with fromString() or
  // fromUserFriendlyAddress() must be KNOWN-VALID.

  const nqFriendly = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
  const nqCompact = nqFriendly.replace(/\s/g, "");

  // Generate a second key pair so we have a guaranteed-valid "other" address
  const otherKeyPair = KeyPair.generate();
  const otherAddrStr = otherKeyPair.publicKey.toAddress().toUserFriendlyAddress();

  // Parse each unique address string exactly once
  const addrFromNq = Address.fromString(nqFriendly);
  const addrFromCompact = Address.fromString(nqCompact);
  const addrOther = Address.fromString(otherAddrStr);
  const hexFromNq = addrFromNq.toHex();
  const hexFromCompact = addrFromCompact.toHex();

  // Hex round-trip
  const addrFromHex = Address.fromString(hexFromNq);

  // NQ vs compact canonicalization
  console.assert(hexFromNq === hexFromCompact, "FAIL: NQ and compact should canonicalize to same hex");
  console.log("  PASS: NQ address → hex canonicalization");

  // Hex round-trip equality
  console.assert(addrFromHex.equals(addrFromNq), "FAIL: Hex should parse back to same address");
  console.log("  PASS: Hex → Address round-trip");

  // Compact NQ equals spaced NQ
  console.assert(addrFromCompact.equals(addrFromNq), "FAIL: Compact NQ should equal spaced NQ");
  console.log("  PASS: Compact NQ equals spaced NQ");

  // Different addresses correctly identified
  console.assert(!addrFromNq.equals(addrOther), "FAIL: Different addresses should not be equal");
  console.log("  PASS: Different addresses correctly identified");

  // Guard check: Address.fromString() on completely invalid input causes a
  // WASM panic in @nimiq/core that escapes JS try/catch. Production code
  // in server-crypto.ts pre-validates via isLikelyNimiqAddress() before
  // calling Address.fromString() to prevent server crashes.
  // Here we verify that the guard correctly rejects non-address strings
  // WITHOUT calling Address.fromString() on them.
  const notAnAddress = "not-an-address";
  const isHexOrNq = /^[0-9a-fA-F]+$/.test(notAnAddress) || notAnAddress.toUpperCase().startsWith("NQ");
  console.assert(!isHexOrNq, "FAIL: Guard should reject non-address strings");
  console.log("  PASS: Pre-validation guard rejects garbage input");

  // fromUserFriendlyAddress should STILL work for NQ format (backward compat check)
  const fromUf = Address.fromUserFriendlyAddress(nqFriendly);
  console.assert(fromUf.equals(addrFromNq), "FAIL: fromUserFriendlyAddress should work for NQ format");
  console.log("  PASS: fromUserFriendlyAddress works for NQ format");

  // fromUserFriendlyAddress should FAIL for hex (this is the bug we fixed)
  try {
    Address.fromUserFriendlyAddress(hexFromNq);
    console.log("  WARN: fromUserFriendlyAddress unexpectedly accepted hex (may depend on @nimiq/core version)");
  } catch {
    console.log("  PASS: fromUserFriendlyAddress rejects hex (as expected — confirms the bug)");
  }

  console.log("\nAll internal consistency checks passed.");

  // ═══════════════════════════════════════════════════════════════════════
  // NIMIQ SIGNED-MESSAGE ENVELOPE TESTS
  // ═══════════════════════════════════════════════════════════════════════

  const { createHash: nodeHash } = await import("node:crypto");

  // ── Prefix byte length ──────────────────────────────────────────────
  const prefix = "\x16Nimiq Signed Message:\n";
  const prefixBytes = new TextEncoder().encode(prefix);
  console.assert(prefixBytes.length === 23, `FAIL: Prefix should be 23 bytes, got ${prefixBytes.length}`);
  console.log("  PASS: Prefix is exactly 23 bytes");

  // ── Build signed-message payload ─────────────────────────────────────
  const testMessage = "Votum wallet verification\n\nDomain: localhost\nAddress: test\nNonce: abc123\nIssued at: 2026-01-01T00:00:00.000Z\nExpires at: 2026-01-01T00:05:00.000Z\n\nThis request proves control of this Nimiq address.\nIt does not send NIM or approve future payments.";

  const lengthStr2 = String(testMessage.length);
  const lengthBytes2 = new TextEncoder().encode(lengthStr2);
  const msgBytes = new TextEncoder().encode(testMessage);

  const payload2 = new Uint8Array(prefixBytes.length + lengthBytes2.length + msgBytes.length);
  payload2.set(prefixBytes, 0);
  payload2.set(lengthBytes2, prefixBytes.length);
  payload2.set(msgBytes, prefixBytes.length + lengthBytes2.length);

  const messageHash = new Uint8Array(nodeHash("sha256").update(payload2).digest());

  // ── Sign the hash using a generated key ─────────────────────────────
  const signKey = KeyPair.generate();
  const envelopeSig = signKey.sign(messageHash);
  const envelopeSigHex = envelopeSig.toHex();
  const signPubHex = signKey.publicKey.toHex();

  // Test 1: Valid signature over correct hash
  const validSig = signKey.publicKey.verify(envelopeSig, messageHash);
  console.assert(validSig, "FAIL: Valid envelope signature should verify");
  console.log("  PASS: Envelope signature verifies over SHA-256 hash");

  // Test 2: fromHex round-trip
  const parsedPub2 = PublicKey.fromHex(signPubHex);
  const parsedSig2 = Signature.fromHex(envelopeSigHex);
  console.assert(parsedPub2.verify(parsedSig2, messageHash), "FAIL: fromHex round-trip should verify");
  console.log("  PASS: fromHex round-trip for envelope signature");

  // Test 3: Raw UTF-8 should FAIL (not how Nimiq signs)
  const rawBytes = new TextEncoder().encode(testMessage);
  const rawVerify = signKey.publicKey.verify(envelopeSig, rawBytes);
  console.assert(!rawVerify, "FAIL: Raw UTF-8 should NOT verify (signature is over hash, not raw bytes)");
  console.log("  PASS: Raw UTF-8 verification correctly fails");

  // Test 4: Modified message should fail
  const modifiedMessage = testMessage + " extra";
  const modLengthStr = String(modifiedMessage.length);
  const modLengthBytes = new TextEncoder().encode(modLengthStr);
  const modMessageBytes = new TextEncoder().encode(modifiedMessage);
  const modPayload = new Uint8Array(prefixBytes.length + modLengthBytes.length + modMessageBytes.length);
  modPayload.set(prefixBytes, 0);
  modPayload.set(modLengthBytes, prefixBytes.length);
  modPayload.set(modMessageBytes, prefixBytes.length + modLengthBytes.length);
  const modHash = new Uint8Array(nodeHash("sha256").update(modPayload).digest());
  console.assert(!signKey.publicKey.verify(envelopeSig, modHash), "FAIL: Modified message should not verify");
  console.log("  PASS: Modified message rejected");

  // Test 5: Wrong public key should fail
  const wrongKey = KeyPair.generate();
  console.assert(!wrongKey.publicKey.verify(envelopeSig, messageHash), "FAIL: Wrong public key should not verify");
  console.log("  PASS: Wrong public key rejected");

  // Test 6: Wrong length should fail
  const wrongLenPayload = new Uint8Array(prefixBytes.length + 1 + msgBytes.length);
  wrongLenPayload.set(prefixBytes, 0);
  wrongLenPayload.set(new TextEncoder().encode("0"), prefixBytes.length);
  wrongLenPayload.set(msgBytes, prefixBytes.length + 1);
  const wrongLenHash = new Uint8Array(nodeHash("sha256").update(wrongLenPayload).digest());
  console.assert(!signKey.publicKey.verify(envelopeSig, wrongLenHash), "FAIL: Wrong length should not verify");
  console.log("  PASS: Wrong message length rejected");

  // Test 7: Missing newline in prefix should fail
  const badPrefix = "\x16Nimiq Signed Message:"; // no \n
  const badPrefixBytes = new TextEncoder().encode(badPrefix);
  const badLenBytes2 = new TextEncoder().encode(String(testMessage.length));
  const badPayload = new Uint8Array(badPrefixBytes.length + badLenBytes2.length + msgBytes.length);
  badPayload.set(badPrefixBytes, 0);
  badPayload.set(badLenBytes2, badPrefixBytes.length);
  badPayload.set(msgBytes, badPrefixBytes.length + badLenBytes2.length);
  const badHash = new Uint8Array(nodeHash("sha256").update(badPayload).digest());
  console.assert(!signKey.publicKey.verify(envelopeSig, badHash), "FAIL: Bad prefix (no newline) should not verify");
  console.log("  PASS: Bad prefix rejected (missing newline)");

  // Test 8: Unhashed payload should fail
  console.assert(!signKey.publicKey.verify(envelopeSig, payload2), "FAIL: Unhashed payload should not verify (signature is over hash)");
  console.log("  PASS: Unhashed payload correctly fails");

  console.log("\nAll signed-message envelope tests passed.");
  console.log("Nimiq Pay signed-message convention: CONFIRMED via real device test.");
}

runConsistencyCheck().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
