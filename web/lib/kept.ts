/**
 * A read kept for `ms` per key and shared by everyone who asks meanwhile, so a burst of requests
 * makes one read, not one each. The read is taken as it answers: a failure it reports as a value is
 * kept too, and tried again once `ms` is up.
 */
export function keptFor<T>(ms: number, read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const kept = new Map<string, { at: number; value: Promise<T> }>();
  return (key) => {
    const found = kept.get(key);
    if (found && Date.now() - found.at < ms) return found.value;
    const value = read(key);
    kept.set(key, { at: Date.now(), value });
    // A read that throws is not kept, so the next request reads again.
    value.catch(() => { if (kept.get(key)?.value === value) kept.delete(key); });
    return value;
  };
}
