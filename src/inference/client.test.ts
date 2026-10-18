import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InferenceClient } from './client';
import type { WorkerCommand, WorkerReply } from './protocol';

// Explicit worker double: verifies request ownership and disposal, not inference.
class ControlledWorker {
  static latest: ControlledWorker;
  onmessage?: (event: MessageEvent<WorkerReply>) => void;
  onerror?: (event: ErrorEvent) => void;
  commands: WorkerCommand[] = [];
  terminated = false;
  constructor() { ControlledWorker.latest = this; }
  postMessage(command: WorkerCommand): void { this.commands.push(command); }
  terminate(): void { this.terminated = true; }
}

beforeEach(() => vi.stubGlobal('Worker', ControlledWorker));
afterEach(() => vi.unstubAllGlobals());

test('a replaced photo rejects immediately and its late error cannot settle the current photo', async () => {
  const client = new InferenceClient();
  const worker = ControlledWorker.latest;
  const old = client.identify(new Blob(['first']));
  const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  const current = client.identify(new Blob(['second']));
  const currentRejected = expect(current).rejects.toThrow('current failure');
  const ids = worker.commands.filter(command => command.type === 'identify').map(command => command.id);
  worker.onmessage?.({ data: { type: 'error', id: ids[0], code: 'inference-failed', message: 'stale failure' } } as MessageEvent<WorkerReply>);
  worker.onmessage?.({ data: { type: 'error', id: ids[1], code: 'invalid-image', message: 'current failure' } } as MessageEvent<WorkerReply>);
  await oldRejected;
  await currentRejected;
  client.dispose();
});

test('reset rejects a pending photo; disposal terminates the worker and rejects outstanding work', async () => {
  const client = new InferenceClient();
  const reset = client.identify(new Blob(['photo']));
  const resetRejected = expect(reset).rejects.toMatchObject({ name: 'AbortError' });
  client.cancel();
  await resetRejected;
  const pending = client.identify(new Blob(['replacement']));
  const closed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  client.dispose();
  await closed;
  expect(ControlledWorker.latest.terminated).toBe(true);
});

test('a worker crash rejects outstanding work instead of leaving identification busy', async () => {
  const client = new InferenceClient();
  const pending = client.identify(new Blob(['photo']));
  const failed = expect(pending).rejects.toThrow('Identification worker failed: GPU process crashed');
  ControlledWorker.latest.onerror?.({ message: 'GPU process crashed' } as ErrorEvent);
  await failed;
  expect(ControlledWorker.latest.terminated).toBe(true);
  const sent = ControlledWorker.latest.commands.length;
  await expect(client.identify(new Blob(['retry']))).rejects.toThrow('Reload the identification model');
  client.cancel();
  expect(ControlledWorker.latest.commands).toHaveLength(sent);
  client.dispose();
});
