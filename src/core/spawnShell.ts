/**
 * The syntax of the shell a Glass terminal runs, for the command lines Glass TYPES into it. Pure:
 * no vscode, no fs.
 *
 * Glass types `spawn …` and `claude …` into a fresh integrated terminal. On macOS and Linux that is
 * zsh or bash, and the `spawn` there is the function install-wrappers.sh writes, which takes GNU
 * flags (`--model x`). On Windows it is PowerShell, and the `spawn` there is the function
 * install-wrappers.ps1 writes, an advanced function whose parameters are `-Model`, `-Effort`,
 * `-Advisor`, `-AddDir` and `-InheritModel`. PowerShell does not read `--model` as a parameter: in
 * command mode a word that starts with two dashes is a plain string, so `spawn --model x worker
 * 'task'` binds `--model` to -Name, `x` to -Task, and refuses the rest ("A positional parameter
 * cannot be found that accepts argument …"): the worker is never started. Quoting differs too: POSIX
 * escapes a quote inside single quotes as '\'' and PowerShell as '', and PowerShell also ends a
 * single-quoted string at a typographic quote (U+2018 to U+201B), so a task holding "don't" or
 * "don’t" was split into several arguments.
 *
 * The App never meets this: it starts `claude` directly, with flags the binary takes on every
 * platform. Glass goes through the operator's `spawn` wrapper, so it must speak the wrapper's
 * dialect. The Windows answer is PowerShell, the same assumption bus/wrapperCaps makes when it reads
 * the PowerShell profiles for the wrapper.
 */

export type TypedShell = 'posix' | 'powershell';

/** Which dialect a Glass terminal on this platform speaks. */
export function typedShellFor(platform: NodeJS.Platform): TypedShell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** The `spawn` wrapper options Glass may type, and their PowerShell parameter names. */
const PS_PARAM = {
  model: 'Model',
  effort: 'Effort',
  advisor: 'Advisor',
  'add-dir': 'AddDir',
  'inherit-model': 'InheritModel',
} as const;

export type SpawnOption = keyof typeof PS_PARAM;

/** The options a typed `spawn` may carry, for the tests that hold them to the real installers. */
export const SPAWN_OPTIONS = Object.keys(PS_PARAM) as SpawnOption[];

/** An option of the `spawn` wrapper as the shell's wrapper declares it: `--model` or `-Model`. */
export function spawnOption(opt: SpawnOption, shell: TypedShell): string {
  return shell === 'powershell' ? `-${PS_PARAM[opt]}` : `--${opt}`;
}

/** PowerShell ends a single-quoted string at any of these, and reads two in a row as one. */
const PS_SINGLE_QUOTES = /['‘’‚‛]/g;

/** One word in single quotes, safe to type into that shell whatever it holds (no newlines). */
export function quoteFor(s: string, shell: TypedShell): string {
  return shell === 'powershell'
    ? `'${s.replace(PS_SINGLE_QUOTES, (q) => q + q)}'`
    : `'${s.replace(/'/g, `'\\''`)}'`;
}
