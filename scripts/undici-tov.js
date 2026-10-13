// The binary's undici (scripts/build.mjs, DSH_BINARY=1): Tov implements fetch natively, TLS included,
// but not Node's tls module that undici's own client needs. The keep-alive Agent becomes a no-op.
export const fetch = (url, init) => globalThis.fetch(url, init);
export class Agent {}
