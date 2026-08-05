type PendingRequest<T> = {
	value: T;
	waiters: Array<{
		resolve: () => void;
		reject: (error: unknown) => void;
	}>;
};

/** Serializes refreshes and coalesces requests that arrive while one is running. */
export class CoalescingAsyncQueue<T> {
	private running = false;
	private pending: PendingRequest<T> | undefined;

	constructor(
		private readonly merge: (current: T, next: T) => T,
		private readonly run: (value: T) => Promise<void>,
	) {}

	request(value: T): Promise<void> {
		const promise = new Promise<void>((resolve, reject) => {
			if (this.pending) {
				this.pending.value = this.merge(this.pending.value, value);
				this.pending.waiters.push({ resolve, reject });
			} else {
				this.pending = { value, waiters: [{ resolve, reject }] };
			}
		});
		void this.drain();
		return promise;
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending) {
				const current = this.pending;
				this.pending = undefined;
				try {
					await this.run(current.value);
					for (const waiter of current.waiters) waiter.resolve();
				} catch (error) {
					for (const waiter of current.waiters) waiter.reject(error);
				}
			}
		} finally {
			this.running = false;
			if (this.pending) void this.drain();
		}
	}
}
