/**
 * 等一个回执：相当于安卓端的 CompletableDeferred。complete 只认第一次。
 */
export class Waiter<T> {
  readonly promise: Promise<T>;
  private resolver: ((v: T) => void) | null = null;
  private done: boolean = false;

  constructor() {
    this.promise = new Promise<T>((resolve: (v: T) => void) => {
      this.resolver = resolve;
    });
  }

  get isCompleted(): boolean {
    return this.done;
  }

  complete(value: T): void {
    if (this.done) {
      return;
    }
    this.done = true;
    const r = this.resolver;
    this.resolver = null;
    if (r !== null) {
      r(value);
    }
  }
}

/** 等 promise，超过 ms 毫秒还没结果（或者出错）就返回 null */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve: (v: T | null) => void) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((v: T) => {
      clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => resolve(), ms);
  });
}

/** 一串短编号，用作图片、文件、解锁请求的 id（协议要求 1 到 32 个字母或数字） */
export function shortId(prefix: string): string {
  const n = Math.floor(Date.now() % 1000000000000) * 1000 + Math.floor(Math.random() * 1000);
  return prefix + n.toString(36);
}
