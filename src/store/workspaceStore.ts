import path from "node:path";
import { FileStateStorage, type StoredWorkspaceBinding } from "./fileState.js";

export type WorkspaceBinding = StoredWorkspaceBinding;

export class WorkspaceStore {
  constructor(private readonly storage: FileStateStorage) {}

  flush(): Promise<void> {
    return this.storage.flush();
  }

  get(chatId: string): WorkspaceBinding | null {
    return this.storage.getWorkspace(chatId);
  }

  upsert(input: { chatId: string; workingRoot?: string; cwd?: string; name?: string | null }): WorkspaceBinding {
    const rootInput = input.workingRoot ?? input.cwd;
    if (!rootInput) {
      throw new Error("workingRoot is required");
    }
    const workingRoot = path.resolve(rootInput);
    const name = input.name?.trim() || path.basename(workingRoot) || workingRoot;
    return this.storage.upsertWorkspace({
      chatId: input.chatId,
      workingRoot,
      name,
    });
  }

  remove(chatId: string): void {
    this.storage.removeWorkspace(chatId);
  }

  list(): WorkspaceBinding[] {
    return this.storage.listWorkspaces();
  }
}
