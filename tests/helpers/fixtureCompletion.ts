type Outcome = { ok: true } | { ok: false; error: unknown };
type Operation = { done: Promise<Outcome>; outcome?: Outcome };

function throwFailures(errors: unknown[]) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Fixture lifecycle failed');
}

export function createFixtureCompletion() {
  const operations: Operation[] = [];
  const violations: Error[] = [];
  let closing = false;
  const failures = () => [
    ...operations.flatMap(operation =>
      operation.outcome && !operation.outcome.ok ? [operation.outcome.error] : []),
    ...violations,
  ];
  const checkCount = (expected: number) => {
    if (operations.length !== expected) {
      throw new Error(`Expected ${expected} sends, received ${operations.length}`);
    }
  };
  return {
    get count() { return operations.length; },
    get completedCount() {
      return operations.filter(operation => operation.outcome?.ok).length;
    },
    assertHealthy() { throwFailures(failures()); },
    run(work: () => Promise<void>): Promise<void> {
      if (closing) {
        const error = new Error('Send arrived during fixture teardown');
        violations.push(error);
        throw error;
      }
      const running = Promise.resolve().then(work);
      const operation: Operation = {
        done: running.then(
          (): Outcome => ({ ok: true }),
          (error: unknown): Outcome => ({ ok: false, error }),
        ),
      };
      operation.done = operation.done.then(outcome => {
        operation.outcome = outcome;
        return outcome;
      });
      operations.push(operation);
      return running;
    },
    async waitForCount(expected: number) {
      checkCount(expected);
      await Promise.all(operations.map(operation => operation.done));
      throwFailures(failures());
      checkCount(expected);
    },
    async close(stopTraffic: () => Promise<unknown>, removeChat: () => Promise<unknown>) {
      closing = true;
      const errors: unknown[] = [];
      try { await stopTraffic(); } catch (error) { errors.push(error); }
      await Promise.all(operations.map(operation => operation.done));
      try { await removeChat(); } catch (error) { errors.push(error); }
      errors.push(...failures());
      throwFailures(errors);
    },
  };
}
