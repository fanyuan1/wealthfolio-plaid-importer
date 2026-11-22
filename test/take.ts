type Tuple<T, N extends number, R extends T[] = []> = R["length"] extends N ? R : Tuple<T, N, [...R, T]>;

function isTuple<T, N extends number>(items: T[], n: N): items is Tuple<T, N> {
  return items.length === n;
}

export function take<T, N extends number>(items: readonly T[], n: N): Tuple<T, N> {
  const head = items.slice(0, n);
  if (!isTuple(head, n)) throw new RangeError(`expected at least ${n} items, got ${items.length}`);
  return head;
}
