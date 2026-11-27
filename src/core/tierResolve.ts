/**
 * What a rung starts, decided from the answers of the framework's `resolve-tier` (#230).
 *
 * Pure: the caller runs the script and hands the outcomes in, so every branch is testable without
 * a shell. There is no rung list and no model id here; both belong to that script alone.
 *
 * The script's plain form answers `judgment` with EMPTY at exit 0, meaning "pass no --model".
 * That equals the rung only where the `spawn` wrapper then fills the gap with its pinned id. A
 * surface that starts `claude` itself has no wrapper in the path, so the same request started the
 * operator's saved model here and the pinned one in a terminal. So an empty answer is followed by
 * a second question, `resolve-tier --launch-model <rung>`, which names what the launcher starts:
 *
 *  · plain: exit 0 + text            → that model
 *  · plain: exit 0 + empty, then
 *      --launch-model: exit 0 + id   → that id, as the launcher's default: $CLAUDE_MODEL wins
 *      --launch-model: non-zero      → a framework that predates the question. No model, as before
 *      --launch-model: not an id     → refuse: never type an unchecked string into a shell
 *  · plain: non-zero                 → refuse, quoting the script (it lists the valid rungs)
 *
 * Glass makes the same decision; this moves into the shared package with #229.
 */
import { MODEL_SHAPE } from './commandBus';

export interface HookRun { status: number; stdout: string; stderr: string }

export type TierAnswer =
  | { model?: string; launcherDefault?: boolean; note?: string }
  | { error: string };

export function resolveTierWith(tier: string, run: (args: string[]) => HookRun): TierAnswer {
  const plain = run([tier]);
  if (plain.status !== 0) {
    const why = plain.stderr.trim() || 'resolve-tier failed';
    return { error: `tier '${tier}' rejected (exit ${plain.status}): ${why.split('\n').join(' · ')}` };
  }
  const model = plain.stdout.trim();
  if (model) {
    return MODEL_SHAPE.test(model) ? { model }
      : { error: `tier '${tier}': resolve-tier answered something that is not a model id — not started` };
  }
  const launch = run(['--launch-model', tier]);
  if (launch.status !== 0) {
    return { note: `tier '${tier}' names the launcher's default and this framework cannot say which model that is (resolve-tier has no --launch-model: run /aios:update); started with no --model, on the saved model` };
  }
  const id = launch.stdout.trim();
  if (!MODEL_SHAPE.test(id)) {
    return { error: `tier '${tier}': resolve-tier --launch-model answered something that is not a model id — not started` };
  }
  return { model: id, launcherDefault: true };
}
