import { LIMITS, validateRequestBudget } from "./constants.mjs";
import { sdkError } from "./errors.mjs";

export class RequestGovernor {
  #used = 0;
  #lastStartedAt = null;
  #tail = Promise.resolve();
  #now;
  #sleep;
  #limit;

  constructor(options = {}) {
    this.#limit = validateRequestBudget(options.maxRequests);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get used() {
    return this.#used;
  }

  get remaining() {
    return Math.max(0, this.#limit - this.#used);
  }

  run(task) {
    const next = this.#tail.then(() => this.#execute(task));
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #execute(task) {
    if (this.#used >= this.#limit) {
      throw sdkError(
        "REQUEST_LIMIT",
        `本次运行已发起 ${this.#limit} 次新请求，已停止`,
      );
    }

    if (this.#lastStartedAt !== null) {
      const waitMs =
        LIMITS.minRequestIntervalMs - (this.#now() - this.#lastStartedAt);
      if (waitMs > 0) await this.#sleep(waitMs);
    }

    this.#lastStartedAt = this.#now();
    this.#used += 1;
    return task();
  }
}
