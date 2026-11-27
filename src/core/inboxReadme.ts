/**
 * The spawn-inbox README, as the App writes it.
 *
 * The text and the rule for who writes are the shared ones (@the-aios/core/inboxReadme): one
 * body, whichever surface writes it. This file only says which surface this is.
 */
import { buildInboxReadme as build, shouldWrite as should, readmeStamp as stamp, INBOX_CONTRACT, type ReadmeWriter } from '@the-aios/core/inboxReadme';

export { INBOX_CONTRACT };

const writer = (appVersion: string): ReadmeWriter => ({ surface: 'app', version: appVersion });

export function buildInboxReadme(appVersion: string): string {
  return build(writer(appVersion));
}

/** Should the App write `ours` over what is on disk? */
export function shouldWrite(existing: string | undefined, ours: string): boolean {
  return should(existing, ours, writer(''));
}

export function readmeStamp(appVersion: string, contract: number = INBOX_CONTRACT): string {
  return stamp(writer(appVersion), contract);
}
