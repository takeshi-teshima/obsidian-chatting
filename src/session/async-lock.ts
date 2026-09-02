/** Tiny browser-safe serial queues. No Node primitives. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class KeyedSerialQueue {
  private readonly queues = new Map<string, SerialQueue>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(key, queue);
    }
    return queue.run(task);
  }
}
