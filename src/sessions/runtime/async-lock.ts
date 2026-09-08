/** Serializes async operations submitted to the same queue instance. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

/** One SerialQueue per key, so different sessions never block each other. */
export class KeyedSerialQueue {
  private readonly queues = new Map<string, SerialQueue>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(key, queue);
    }
    return queue.run(operation);
  }
}
