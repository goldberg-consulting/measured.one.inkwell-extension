/** Serial work queue with one newest pending revision per document. */
export interface CompileRequest<T> {
  key: string;
  version: number;
  signature: string;
  value: T;
  interval?: boolean;
}
interface Pending<T, R> {
  request: CompileRequest<T>;
  promise: Promise<R | undefined>;
  resolve(value: R | undefined): void;
  reject(error: unknown): void;
}

export class CompileCoordinator<T, R> {
  private pending = new Map<string, Pending<T, R>>();
  private active?: Pending<T, R>;
  private successful = new Map<string, { signature: string; result: R }>();
  private disposed = false;

  constructor(private execute: (request: CompileRequest<T>, isCurrent: () => boolean) => Promise<R>,
    private succeeded: (result: R) => boolean,
    private outputValid: (request: CompileRequest<T>, result: R) => boolean = () => true) {}

  private canReuse(request: CompileRequest<T>): boolean {
    const previous = this.successful.get(request.key);
    return Boolean(request.interval && previous?.signature === request.signature && this.outputValid(request, previous.result));
  }

  request(request: CompileRequest<T>): Promise<R | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const pending = this.pending.get(request.key);
    if (pending?.request.signature === request.signature) {
      if (!request.interval) pending.request.interval = false;
      return pending.promise;
    }
    if (this.active?.request.key === request.key && this.active.request.signature === request.signature) return this.active.promise;
    if (!pending && !this.active && this.canReuse(request)) return Promise.resolve(undefined);
    let resolve!: Pending<T, R>["resolve"]; let reject!: Pending<T, R>["reject"];
    const promise = new Promise<R | undefined>((done, failed) => { resolve = done; reject = failed; });
    // A superseded waiter completes, but does not mistake a newer result for its own.
    pending?.resolve(undefined);
    this.pending.set(request.key, { request, promise, resolve, reject });
    void this.drain();
    return promise;
  }

  invalidate(key?: string): void { if (key) this.successful.delete(key); else this.successful.clear(); }
  dispose(): void {
    this.disposed = true;
    for (const item of this.pending.values()) item.resolve(undefined);
    this.pending.clear(); this.successful.clear();
  }

  private async drain(): Promise<void> {
    if (this.active || this.disposed) return;
    const item = this.pending.values().next().value as Pending<T, R> | undefined;
    if (!item) return;
    this.pending.delete(item.request.key); this.active = item;
    const current = () => !this.disposed && !this.pending.has(item.request.key);
    try {
      if (this.canReuse(item.request)) item.resolve(undefined);
      else {
        const result = await this.execute(item.request, current);
        if (current() && this.succeeded(result)) {
          this.successful.delete(item.request.key);
          this.successful.set(item.request.key, { signature: item.request.signature, result });
          if (this.successful.size > 128) this.successful.delete(this.successful.keys().next().value!);
        } else this.successful.delete(item.request.key);
        item.resolve(result);
      }
    } catch (error) { this.successful.delete(item.request.key); item.reject(error); }
    finally { this.active = undefined; void this.drain(); }
  }
}
