let mutationQueue: Promise<void> = Promise.resolve();

const settle = async (operation: Promise<unknown>): Promise<void> => {
  await Promise.allSettled([operation]);
};

/** Run `operation` after every earlier locked operation settles, so Music gets one write at a time. */
export const withMutationLock = async <T>(
  operation: () => Promise<T>
): Promise<T> => {
  const previous = mutationQueue;
  const run = async (): Promise<T> => {
    await previous;
    return await operation();
  };
  const result = run();
  mutationQueue = settle(result);
  return await result;
};
