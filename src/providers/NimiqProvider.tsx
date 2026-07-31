"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import {
  nimiqClientReducer,
  initialClientState,
  initializeNimiqProvider,
  requestAccounts,
  type NimiqClientState,
} from "@/lib/nimiq/client";

interface NimiqContextValue extends NimiqClientState {
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  setActiveAccount: (account: string) => void;
  retryInit: () => void;
  isInsideNimiqPay: boolean;
}

const NimiqContext = createContext<NimiqContextValue | null>(null);

export function NimiqProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(nimiqClientReducer, initialClientState);

  const isInsideNimiqPay = state.runtimeStatus === "available";

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      dispatch({ type: "INIT_START" });

      const result = await initializeNimiqProvider(5000);

      if (cancelled) return;

      if ("error" in result) {
        if (result.error === "timeout") {
          dispatch({ type: "INIT_TIMEOUT" });
        } else {
          dispatch({ type: "INIT_ERROR", error: result.error });
        }
        return;
      }

      const { provider } = result;
      dispatch({ type: "INIT_SUCCESS", provider });

      try {
        const consensus = await provider.isConsensusEstablished();
        dispatch({ type: "SET_CONSENSUS", established: consensus });
      } catch {
        dispatch({ type: "SET_CONSENSUS", established: false });
      }

      try {
        const block = await provider.getBlockNumber();
        dispatch({ type: "SET_BLOCK_NUMBER", block });
      } catch {
        // network readiness check failed — non-critical
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  const connectWallet = useCallback(async () => {
    if (!state.provider) return;

    dispatch({ type: "CONNECT_START" });

    const result = await requestAccounts(state.provider);

    if ("accounts" in result) {
      dispatch({ type: "CONNECT_SUCCESS", accounts: result.accounts });
    } else if ("denied" in result) {
      dispatch({ type: "CONNECT_PERMISSION_DENIED" });
    } else if ("empty" in result) {
      dispatch({ type: "CONNECT_NO_ACCOUNTS" });
    } else if ("error" in result) {
      dispatch({ type: "CONNECT_ERROR", error: result.error });
    }
  }, [state.provider]);

  const disconnectWallet = useCallback(() => {
    dispatch({ type: "DISCONNECT" });
  }, []);

  const setActiveAccount = useCallback(
    (account: string) => {
      dispatch({ type: "SET_ACTIVE_ACCOUNT", account });
    },
    [],
  );

  const retryInit = useCallback(() => {
    dispatch({ type: "INIT_START" });
    void (async () => {
      const result = await initializeNimiqProvider(5000);
      if ("error" in result) {
        if (result.error === "timeout") {
          dispatch({ type: "INIT_TIMEOUT" });
        } else {
          dispatch({ type: "INIT_ERROR", error: result.error });
        }
        return;
      }
      const { provider } = result;
      dispatch({ type: "INIT_SUCCESS", provider });
      try {
        const consensus = await provider.isConsensusEstablished();
        dispatch({ type: "SET_CONSENSUS", established: consensus });
      } catch {
        dispatch({ type: "SET_CONSENSUS", established: false });
      }
    })();
  }, []);

  const providerValue = useMemo<NimiqContextValue>(
    () => ({
      ...state,
      connectWallet,
      disconnectWallet,
      setActiveAccount,
      retryInit,
      isInsideNimiqPay,
    }),
    [state, connectWallet, disconnectWallet, setActiveAccount, retryInit, isInsideNimiqPay],
  );

  return (
    <NimiqContext.Provider value={providerValue}>
      {children}
    </NimiqContext.Provider>
  );
}

export function useNimiqContext(): NimiqContextValue {
  const ctx = useContext(NimiqContext);
  if (!ctx) {
    throw new Error("useNimiqContext must be used within NimiqProvider");
  }
  return ctx;
}
