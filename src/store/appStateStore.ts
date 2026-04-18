import type { FileStateStorage } from "./fileState.js";

export class AppStateStore {
  constructor(private readonly storage: FileStateStorage) {}

  flush(): Promise<void> {
    return this.storage.flush();
  }

  get(key: string): string | null {
    return this.storage.getAppState(key);
  }

  set(key: string, value: string): void {
    this.storage.setAppState(key, value);
  }

  delete(key: string): void {
    this.storage.deleteAppState(key);
  }
}
