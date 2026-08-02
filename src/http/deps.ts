import type { Env } from "../env";
import {
  createBundleDownloadSigner,
  type BundleDownloadSigner,
} from "../r2/presigner";

export interface HandlerDeps {
  readonly signer: BundleDownloadSigner;
  now(): number;
}

export function createHandlerDeps(env: Env): HandlerDeps {
  let cached: BundleDownloadSigner | undefined;
  return {
    get signer() {
      return (cached ??= createBundleDownloadSigner(env));
    },
    now: () => Date.now(),
  };
}
