export type Guard<T> = (v: unknown) => v is T;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export const nullable = <T>(guard: Guard<T>): Guard<T | null | undefined> => (v): v is T | null | undefined => v === null || v === undefined || guard(v);
export const arrayOf = <T>(guard: Guard<T>): Guard<T[]> => (v): v is T[] => Array.isArray(v) && v.every(guard);

type Fields<T> = { [K in keyof T]-?: Guard<T[K]> } & Record<string, Guard<unknown>>;

export const shape = <T extends object>(fields: Fields<T>): Guard<T> => (v): v is T =>
  isRecord(v) && Object.entries(fields).every(([k, guard]) => guard(v[k]));
export const optional = <T>(guard: Guard<T>): Guard<T | undefined> => (v): v is T | undefined => v === undefined || guard(v);
export const recordOf = <T>(guard: Guard<T>): Guard<Record<string, T>> => (v): v is Record<string, T> =>
  isRecord(v) && Object.values(v).every(guard);
export const orNull = <T>(guard: Guard<T>): Guard<T | null> => (v): v is T | null => v === null || guard(v);
