/**
 * The tty line-length rule, kept where it can be tested.
 *
 * A pty in canonical mode has a fixed input line buffer — MAX_CANON, 1024 bytes on macOS and
 * Linux. Writing a longer single line does not error, block, or truncate loudly: the line
 * discipline drops the tail and hands the shell a partial command. If the cut lands inside a
 * quoted string (it usually does, since the tail of a generated command is quoted text) the
 * shell waits for the quote to close and nothing ever runs — indistinguishable from a hang.
 *
 * Measured, not assumed: a 1,100-byte wiring command arrived as exactly 1024 bytes ending
 * mid-string.
 */
export const MAX_CANON = 1024;

/**
 * Leave real headroom rather than sitting one byte from the cliff. The shell echoes what it
 * receives, prompts and bracketed-paste markers share the same buffer, and a command that
 * squeezes in today grows the next time a path gets longer.
 */
export const SAFE_LINE = MAX_CANON - 124;

/** Does this command have to be written to a file instead of typed into the tty? */
export function needsSpill(cmd: string): boolean {
  return Buffer.byteLength(cmd + '\r', 'utf8') >= SAFE_LINE;
}
