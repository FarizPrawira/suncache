/** Discriminator of stored entries: scalar values or sorted sets. */
export type EntryKind = "value" | "zset";

export class WrongTypeError extends Error {
  readonly key: string;
  readonly has: EntryKind;
  readonly wanted: EntryKind;

  constructor(key: string, has: EntryKind, wanted: EntryKind) {
    super(`'${key}' holds a ${has}, not a ${wanted}`);
    this.name = "WrongTypeError";
    this.key = key;
    this.has = has;
    this.wanted = wanted;
  }
}
