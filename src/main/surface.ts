import type { Surface } from '../core/sendQueue';

/**
 * This build's identity as a fulfiller.
 *
 * It lives HERE and not in `core/sendQueue.ts` because it is the one value in that file which
 * must differ between the two surfaces — and its presence there is what kept the file from being
 * pinned byte-identical with Glass. The protocol decisions the two fulfillers race on
 * (`decideSend`, `claimVerdict`, `verifyVerdict`, `canAdoptHold`) had no cross-repo guard for
 * exactly that reason, so they could have diverged with nothing to catch it.
 */
export const MY_SURFACE: Surface = 'app';
