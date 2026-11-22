import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/lib/api";

/** Loads data, exposes loading/error/reload. Ignores results of stale requests. */
/**
 * `loading` is true only until the first result arrives; a reload keeps the
 * current data on screen (`refreshing`), so confirmations and form state in
 * the view are not unmounted.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; loading: boolean; refreshing: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    fn().then((d) => { if (n === seq.current) setData(d); })
      .catch((e) => { if (n === seq.current) setError(describeError(e)); })
      .finally(() => { if (n === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, loading: loading && data === null, refreshing: loading && data !== null, error, reload: run };
}

/** Wraps an action with busy/error/message state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true); setError(null); setMessage(null);
    try { await fn(); if (success) setMessage(success); return true; }
    catch (e) { setError(describeError(e)); return false; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, message, run, clear: () => { setError(null); setMessage(null); } };
}
