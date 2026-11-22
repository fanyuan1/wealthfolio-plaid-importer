export function itemAt<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`index ${index} is outside 0..${items.length - 1}`);
  return item;
}

export function valueAt<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new RangeError(`no entry for ${key}`);
  return value;
}

export function entryAt<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new RangeError(`no entry for ${String(key)}`);
  return value;
}

export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new RangeError(`${what} is missing`);
  return value;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
