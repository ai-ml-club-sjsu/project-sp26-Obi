import Database from 'better-sqlite3';
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import * as sqliteVec from "sqlite-vec";

let db: Database.Database | null = null;

function getUserDataPath() {
    return app.getPath("userData")
}

function getDbPath() {
    const dataDir = path.join(getUserDataPath(), "rag")
    fs.mkdirSync(dataDir, { recursive: true })
    return path.join(dataDir, "app.db")
}

export function getDb() {
    if (!db) {
        throw new Error("Database not initialized. Call initDatabase() first.")
    }
    return db
}

export function initDatabase() {
    if (db) return db;

    const dbPath = getDbPath();
    db = new Database(dbPath);

    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    sqliteVec.load(db);


    createSchema(db);

    console.log("DB path:", dbPath);
    return db;
}

function createSchema(db: Database.Database) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);

    -- sqlite-vec virtual table
    -- Adjust 768 to match your embedding size.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );
  `)
}