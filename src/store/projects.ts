import path from "node:path";
import { FileStateStorage, type StoredProjectBinding } from "./fileState.js";

export type ProjectBinding = StoredProjectBinding;

export class ProjectStore {
  constructor(private readonly storage: FileStateStorage) {}

  get(chatId: string): ProjectBinding | null {
    return this.storage.getProject(chatId);
  }

  upsert(input: { chatId: string; cwd: string; name?: string | null }): ProjectBinding {
    const cwd = path.resolve(input.cwd);
    const name = input.name?.trim() || path.basename(cwd) || cwd;
    return this.storage.upsertProject({
      chatId: input.chatId,
      cwd,
      name,
    });
  }

  remove(chatId: string): void {
    this.storage.removeProject(chatId);
  }

  list(): ProjectBinding[] {
    return this.storage.listProjects();
  }
}
