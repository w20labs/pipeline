import type { ChildOutcome } from './child.js';

/**
 * Whether a helper run through `runChild` terminated successfully, as problems: empty only when it
 * closed with exit 0, no signal, was never signalled to stop, stayed within its output bound, and
 * wrote nothing to stderr. `stdout` is whatever was captured, or empty if the helper never ran;
 * callers may still validate it, but must not trust it unless `problems` is empty.
 */
export const helperTermination = (
  outcome: ChildOutcome,
): { readonly problems: readonly string[]; readonly stdout: string } => {
  const problems: string[] = [];
  if (outcome.kind === 'not_started' || outcome.kind === 'spawn_failed') {
    problems.push(`the helper did not run: ${outcome.detail}`);
    return { problems, stdout: '' };
  }
  const { evidence } = outcome;
  if (outcome.kind !== 'closed') problems.push(`the helper ended ${outcome.kind}`);
  else {
    if (outcome.signal !== null) problems.push(`the helper was killed by ${outcome.signal}`);
    if (outcome.exitCode !== 0) problems.push(`the helper exited ${String(outcome.exitCode)}`);
  }
  if (evidence.signalled.length > 0) problems.push('the helper was signalled to stop');
  if (evidence.outputExceeded === true) problems.push('the helper exceeded maxOutputBytes');
  if (evidence.inputUnconfirmed === true)
    problems.push('the helper input delivery was not confirmed');
  if (evidence.stderr !== '') problems.push('the helper wrote to stderr');
  return { problems, stdout: evidence.stdout };
};
