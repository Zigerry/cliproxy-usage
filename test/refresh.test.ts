import assert from "node:assert/strict";
import test from "node:test";
import { CoalescingAsyncQueue } from "../src/refresh.js";

type Request = { notify: boolean; force: boolean };

test("refresh queue reruns with stronger pending semantics", async () => {
	let releaseFirst: (() => void) | undefined;
	const firstRun = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const calls: Request[] = [];
	const queue = new CoalescingAsyncQueue<Request>(
		(current, next) => ({
			notify: current.notify || next.notify,
			force: current.force || next.force,
		}),
		async (request) => {
			calls.push(request);
			if (calls.length === 1) await firstRun;
		},
	);

	const background = queue.request({ notify: false, force: false });
	await Promise.resolve();
	assert.deepEqual(calls, [{ notify: false, force: false }]);

	const manual = queue.request({ notify: true, force: false });
	const settings = queue.request({ notify: false, force: true });
	releaseFirst?.();
	await Promise.all([background, manual, settings]);

	assert.deepEqual(calls, [
		{ notify: false, force: false },
		{ notify: true, force: true },
	]);
});

test("refresh queue continues after a failed run", async () => {
	let attempts = 0;
	const queue = new CoalescingAsyncQueue<number>(
		(_current, next) => next,
		async () => {
			attempts++;
			if (attempts === 1) throw new Error("failed");
		},
	);

	await assert.rejects(queue.request(1), /failed/);
	await queue.request(2);
	assert.equal(attempts, 2);
});
