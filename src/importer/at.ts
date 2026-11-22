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
