type Flushable = () => Promise<void>;

const flushers = new Set<Flushable>();
let saveErrorReporter: ((error: unknown) => void) | null = null;

/** Lets the app surface a single, visible warning for any failed store write. */
export function setSaveErrorReporter(reporter: ((error: unknown) => void) | null): void {
  saveErrorReporter = reporter;
}

export interface Saver<T> {
  schedule: (value: T) => void;
  flush: () => Promise<void>;
}

export function createSaver<T>(
  write: (value: T) => Promise<void>,
  delay = 400,
  onError?: (error: unknown) => void,
  maxWait = 2000,
): Saver<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: { value: T } | null = null;
  let chain: Promise<void> = Promise.resolve();
  let firstScheduledAt = 0;

  const drain = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstScheduledAt = 0;
    const job = latest;
    latest = null;
    if (job) {
      chain = chain.then(() => write(job.value)).catch((error) => {
        onError?.(error);
        saveErrorReporter?.(error);
      });
    }
    return chain;
  };

  const saver: Saver<T> = {
    schedule(value) {
      const now = Date.now();
      if (!latest) firstScheduledAt = now;
      latest = { value };
      if (timer) clearTimeout(timer);
      // Continuous activity must not postpone the write forever.
      const remaining = maxWait - (now - firstScheduledAt);
      timer = setTimeout(drain, Math.max(0, Math.min(delay, remaining)));
    },
    flush: drain,
  };
  flushers.add(saver.flush);
  return saver;
}

export function registerFlusher(flush: Flushable): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled(Array.from(flushers, (flush) => flush()));
}
