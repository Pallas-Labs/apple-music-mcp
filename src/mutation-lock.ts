let mutationQueue: Promise<void> = Promise.resolve();

/** Run `operation` after every earlier locked operation settles, so Music gets one write at a time. */
export function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
