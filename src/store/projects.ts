import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface ProjectBinding {
  chatId: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  chat_id: string;
  name: string;
  cwd: string;
  created_at: string;
  updated_at: string;
}

export class ProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  get(chatId: string): ProjectBinding | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE chat_id = ?").get(chatId) as ProjectRow | undefined;
    return row ? mapRow(row) : null;
  }

  upsert(input: { chatId: string; cwd: string; name?: string | null }): ProjectBinding {
    const now = new Date().toISOString();
    const cwd = path.resolve(input.cwd);
    const name = input.name?.trim() || path.basename(cwd) || cwd;
    this.db
      .prepare(
        `INSERT INTO projects (chat_id, name, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           name = excluded.name,
           cwd = excluded.cwd,
           updated_at = excluded.updated_at`,
      )
      .run(input.chatId, name, cwd, now, now);

    const project = this.get(input.chatId);
    if (!project) {
      throw new Error("Project upsert failed");
    }
    return project;
  }

  remove(chatId: string): void {
    this.db.prepare("DELETE FROM projects WHERE chat_id = ?").run(chatId);
  }

  list(): ProjectBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all() as unknown as ProjectRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: ProjectRow): ProjectBinding {
  return {
    chatId: row.chat_id,
    name: row.name,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
