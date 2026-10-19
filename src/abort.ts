/** Stop waiting promptly, while consuming any late resolution/rejection of work. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => { cleanup(); resolve(value); },
			(error: unknown) => { cleanup(); reject(error); },
		);
		if (signal.aborted) onAbort();
	});
}
