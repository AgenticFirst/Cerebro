import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error — webcrypto is compatible enough for randomUUID()
  globalThis.crypto = webcrypto;
}
