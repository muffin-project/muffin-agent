import type { OwnerIngress } from './owner-ingress.js';

/**
 * Authenticated ingress and checkpoint, supplied by the runtime, never tool
 * arguments. Alias kept so existing importers do not churn: the validation
 * lives in `owner-ingress.ts` (`authenticatedOwnerInput`), authority by
 * quotation in `verifyQuotedInstruction`. No verb lists anywhere.
 */
export type ForgetSource = OwnerIngress;
