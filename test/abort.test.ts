import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { abortable } from "../src/abort.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test("abortable settles on cancellation, consumes late rejection and removes its listener", async () => {
	const controller = new AbortController();
	const work = deferred<number>();
	const waiting = abortable(work.promise, controller.signal);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	const reason = new Error("canceled");
	controller.abort(reason);
	await assert.rejects(waiting, (error) => error === reason);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	work.reject(new Error("late failure"));
	await new Promise((resolve) => setImmediate(resolve));
});

test("abortable handles an already-aborted signal without leaking the pending promise", async () => {
	const controller = new AbortController();
	controller.abort();
	const work = deferred<number>();
	await assert.rejects(abortable(work.promise, controller.signal), { name: "AbortError" });
	work.reject(new Error("late"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abortable preserves success and failure and cleans up listeners", async () => {
	const controller = new AbortController();
	assert.equal(await abortable(Promise.resolve(4), controller.signal), 4);
	await assert.rejects(abortable(Promise.reject(new Error("failed")), controller.signal), /failed/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
