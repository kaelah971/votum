import { init } from "@nimiq/mini-app-sdk";
import type { NimiqProvider, ErrorResponse } from "@nimiq/mini-app-sdk";

export type RuntimeStatus =
  | "idle"
  | "initializing"
  | "available"
  | "unavailable"
  | "error";

export type WalletStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "permission_denied"
  | "no_accounts"
  | "error";

export interface NimiqClientState {
  runtimeStatus: RuntimeStatus;
  walletStatus: WalletStatus;
  provider: NimiqProvider | null;
  accounts: string[];
  activeAccount: string | null;
  error: string | null;
  consensusEstablished: boolean | null;
  blockNumber: number | null;
}

export type NimiqClientAction =
  | { type: "INIT_START" }
  | { type: "INIT_SUCCESS"; provider: NimiqProvider }
  | { type: "INIT_TIMEOUT" }
  | { type: "INIT_ERROR"; error: string }
  | { type: "CONNECT_START" }
  | { type: "CONNECT_SUCCESS"; accounts: string[] }
  | { type: "CONNECT_PERMISSION_DENIED" }
  | { type: "CONNECT_NO_ACCOUNTS" }
  | { type: "CONNECT_ERROR"; error: string }
  | { type: "DISCONNECT" }
  | { type: "SET_ACTIVE_ACCOUNT"; account: string }
  | { type: "SET_CONSENSUS"; established: boolean }
  | { type: "SET_BLOCK_NUMBER"; block: number };

export const initialClientState: NimiqClientState = {
  runtimeStatus: "idle",
  walletStatus: "disconnected",
  provider: null,
  accounts: [],
  activeAccount: null,
  error: null,
  consensusEstablished: null,
  blockNumber: null,
};

export function nimiqClientReducer(
  state: NimiqClientState,
  action: NimiqClientAction,
): NimiqClientState {
  switch (action.type) {
    case "INIT_START":
      return { ...state, runtimeStatus: "initializing", error: null };
    case "INIT_SUCCESS":
      return {
        ...state,
        runtimeStatus: "available",
        provider: action.provider,
        error: null,
      };
    case "INIT_TIMEOUT":
      return {
        ...state,
        runtimeStatus: "unavailable",
        error: null,
      };
    case "INIT_ERROR":
      return {
        ...state,
        runtimeStatus: "error",
        error: action.error,
      };
    case "CONNECT_START":
      return { ...state, walletStatus: "connecting", error: null };
    case "CONNECT_SUCCESS":
      return {
        ...state,
        walletStatus: "connected",
        accounts: action.accounts,
        activeAccount: action.accounts[0] ?? null,
        error: null,
      };
    case "CONNECT_PERMISSION_DENIED":
      return {
        ...state,
        walletStatus: "permission_denied",
        error: null,
      };
    case "CONNECT_NO_ACCOUNTS":
      return {
        ...state,
        walletStatus: "no_accounts",
        error: null,
      };
    case "CONNECT_ERROR":
      return {
        ...state,
        walletStatus: "error",
        error: action.error,
      };
    case "DISCONNECT":
      return {
        ...state,
        walletStatus: "disconnected",
        accounts: [],
        activeAccount: null,
        error: null,
      };
    case "SET_ACTIVE_ACCOUNT":
      if (!state.accounts.includes(action.account)) return state;
      return { ...state, activeAccount: action.account };
    case "SET_CONSENSUS":
      return { ...state, consensusEstablished: action.established };
    case "SET_BLOCK_NUMBER":
      return { ...state, blockNumber: action.block };
    default:
      return state;
  }
}

function isErrorResponse(
  result: string[] | ErrorResponse,
): result is ErrorResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as ErrorResponse).error === "object"
  );
}

/**
 * Detect permission denial from a structured ErrorResponse or thrown Error.
 *
 * The {@link https://nimiq.com/developers/mini-apps | official docs} identify
 * listAccounts() rejection as PermissionDeniedError, but v0.1.0 of
 * `@nimiq/mini-app-sdk` does not export that class.  Instead the provider
 * returns an `ErrorResponse` object with a typed `error.type` field.
 *
 * Detection priority:
 * 1. Structured `error.type` matching (primary — SDK field, not user text)
 * 2. `error.message` substring matching (fallback for older / future
 *    provider versions)
 *
 * @internal Only expose clean `{ denied: true }` to callers.
 */
function isPermissionDenial(type: string, message: string): boolean {
  const lowerType = type.toLowerCase();
  if (
    lowerType === "denied" ||
    lowerType === "permission_denied" ||
    lowerType === "permissiondenied" ||
    lowerType.includes("denied")
  ) {
    return true;
  }

  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("denied") ||
    lowerMessage.includes("reject") ||
    lowerMessage.includes("user cancelled")
  );
}

/**
 * Safely extract denial indicators from an arbitrary thrown/rejected value
 * (Error, DOMException, plain object, SDK error object) without stringifying
 * secrets. Only reads `name`, `code`, `type`, and `message` fields; never
 * returns or logs the raw payload.
 */
function isDenialFromThrown(err: unknown): boolean {
  if (err instanceof Error) {
    return isPermissionDenial(err.name ?? "", err.message ?? "");
  }
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    // Nested SDK error object: { error: { type, message } }
    const nested = record.error as Record<string, unknown> | undefined;
    const typeRaw = typeof nested?.type === "string" ? nested.type : "";
    const msgRaw =
      typeof nested?.message === "string"
        ? nested.message
        : typeof record.message === "string"
          ? (record.message as string)
          : "";
    return isPermissionDenial(typeRaw, msgRaw);
  }
  return false;
}

/**
 * Safely produce a short, non-secret error message from an arbitrary thrown
 * value. Only name/code/message are exposed; raw payloads are never surfaced.
 */
function safeErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Wallet request failed";
  }
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    const nested = record.error as Record<string, unknown> | undefined;
    const message =
      (typeof nested?.message === "string" && nested.message) ||
      (typeof record.message === "string" && record.message) ||
      (typeof record.code === "string" && record.code) ||
      (typeof record.type === "string" && record.type);
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Unknown wallet error";
}

export async function initializeNimiqProvider(
  timeout = 5000,
): Promise<{ provider: NimiqProvider } | { error: string }> {
  try {
    const provider = await init({ timeout });
    return { provider };
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message?.includes("timeout") || err.name === "TimeoutError") {
        return { error: "timeout" };
      }
      return { error: err.message };
    }
    return { error: "Unknown initialisation error" };
  }
}

/**
 * Request a cryptographic signature over a UTF-8 message string from Nimiq Pay.
 *
 * Calls `provider.sign(message)` which prompts the user in Nimiq Pay to
 * confirm the signature.  Returns the public key and signature hex strings
 * on success, or a discriminated union for denials / errors.
 *
 * The Mini App `sign(message)` API signs the UTF-8 bytes of the message
 * string directly — no hashing or prefixing is applied by the SDK.
 */
export async function signMessage(
  provider: NimiqProvider,
  message: string,
): Promise<
  | { publicKey: string; signature: string }
  | { denied: true }
  | { error: string }
> {
  try {
    // Attach a defensive rejection handler to the raw SDK promise so it can
    // never surface as an unhandled rejection (e.g. Next's dev overlay
    // `onUnhandledRejection` showing "[object Object]" for a plain-object
    // cancellation). The awaited result below is still observed normally —
    // multiple handlers on the same promise are independent.
    const signPromise = provider.sign(message);
    signPromise.catch(() => {
      /* handled defensively; the await below observes the rejection */
    });

    const result = await signPromise;

    // provider.sign() returns ErrorResponse | SignatureResult.
    // SignatureResult has "publicKey" and "signature" properties.
    if ("publicKey" in result && "signature" in result) {
      return { publicKey: result.publicKey, signature: result.signature };
    }

    const { type, message: errMsg } = result.error;

    if (isPermissionDenial(type ?? "", errMsg ?? "")) {
      return { denied: true };
    }
    return { error: errMsg || type || "Signature request failed" };
  } catch (err: unknown) {
    if (isDenialFromThrown(err)) {
      return { denied: true };
    }
    return { error: safeErrorSummary(err) };
  }
}

export async function requestAccounts(
  provider: NimiqProvider,
): Promise<
  | { accounts: string[] }
  | { denied: true }
  | { empty: true }
  | { error: string }
> {
  try {
    // Defensive handler so a plain-object SDK rejection (e.g. cancellation)
    // can never surface as an unhandled rejection.
    const accountsPromise = provider.listAccounts();
    accountsPromise.catch(() => {
      /* handled defensively; the await below observes the rejection */
    });

    const result = await accountsPromise;

    if (isErrorResponse(result)) {
      const { type, message } = result.error;

      if (isPermissionDenial(type ?? "", message ?? "")) {
        return { denied: true };
      }
      return { error: message || type || "Wallet request failed" };
    }

    if (Array.isArray(result) && result.length > 0) {
      return { accounts: result };
    }

    if (Array.isArray(result) && result.length === 0) {
      return { empty: true };
    }

    return { error: "Unexpected response from wallet" };
  } catch (err: unknown) {
    if (isDenialFromThrown(err)) {
      return { denied: true };
    }
    return { error: safeErrorSummary(err) };
  }
}

export interface BasicTransactionWithData {
  recipient: string;
  value: number;
  data: string;
}

/**
 * Send a basic Nimiq Pay transaction without allowing SDK rejection objects to
 * escape into the app. A returned hash is a broadcast callback only; callers
 * must bind it server-side and must not treat it as chain confirmation.
 */
export async function sendBasicTransactionWithData(
  provider: NimiqProvider,
  transaction: BasicTransactionWithData,
): Promise<
  | { transactionHash: string }
  | { denied: true }
  | { error: string }
> {
  try {
    const sendPromise = provider.sendBasicTransactionWithData(transaction);
    sendPromise.catch(() => {
      /* handled defensively; the await below observes the rejection */
    });

    const result = await sendPromise;
    if (typeof result === "string") {
      if (!/^[0-9a-fA-F]{64}$/.test(result)) {
        return { error: "Invalid transaction hash returned by wallet" };
      }
      return { transactionHash: result.toLowerCase() };
    }

    const { type, message } = result.error;
    if (isPermissionDenial(type ?? "", message ?? "")) {
      return { denied: true };
    }
    return { error: message || type || "Wallet transaction failed" };
  } catch (err: unknown) {
    if (isDenialFromThrown(err)) {
      return { denied: true };
    }
    return { error: safeErrorSummary(err) };
  }
}
