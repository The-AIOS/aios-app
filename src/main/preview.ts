/* The viewer's read gate (#39) moved to the shared package, unchanged, because the bus's `open`
   verb decides with the same rule the viewer reads with (see @the-aios/core/readClass). */
export { ASSET_EXT, TEXT_LIMIT, classifyForRead, type ReadClass } from '@the-aios/core/readClass';
