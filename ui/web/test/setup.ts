import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class StorageStub implements Storage {
  readonly #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, String(value));
  }
}

Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
// Node's experimental global localStorage shadows jsdom with `undefined` on
// current releases unless a backing file is configured. Install one explicit
// in-memory browser storage object on both views of the test environment.
const localStorageStub = new StorageStub();
Object.defineProperty(window, "localStorage", { value: localStorageStub, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, configurable: true });
afterEach(() => cleanup());
