import fs from "node:fs"
import path from "node:path"
import { getDb } from "./database"
import { SearchResult } from "../src/types/global"

type EmbedOneFn = (text: string) => Promise<number[]>
type EmbedManyFn = (texts: string[]) => Promise<number[][]>

const TEXT_FILE_EXTENSIONS = new Set([".txt", ".md"])

export class VectorStore {
    constructor(
        private readonly embedOne: EmbedOneFn,
        private readonly embedMany: EmbedManyFn,
        private readonly embeddingDimensions: number
    ) { }

    async indexDirectory(rootPath: string) {
        const files = walkDirectory(rootPath)
        let indexedCount = 0
        let skippedCount = 0

        for (const filePath of files) {
            if (!shouldIndexFile(filePath)) {
                skippedCount += 1
                continue
            }

            const result = await this.indexFile(filePath)
            if (result.skipped) skippedCount += 1
            else indexedCount += 1
        }

        return { indexedCount, skippedCount }
    }

    async indexFile(filePath: string) {
        const db = getDb()

        const stat = fs.statSync(filePath)
        const updatedAtMs = stat.mtimeMs

        const existingDoc = db
            .prepare("SELECT id, updated_at_ms FROM documents WHERE path = ?")
            .get(filePath) as { id: number; updated_at_ms: number } | undefined

        if (existingDoc && existingDoc.updated_at_ms === updatedAtMs) {
            return { skipped: true as const, reason: "unchanged" as const }
        }

        const rawText = safeReadTextFile(filePath)
        if (!rawText.trim()) {
            return { skipped: true as const, reason: "empty" as const }
        }

        const chunks = chunkText(rawText, 800, 120)
        if (chunks.length === 0) {
            return { skipped: true as const, reason: "no_chunks" as const }
        }

        const embeddings = await this.embedMany(chunks)

        for (const embedding of embeddings) {
            if (embedding.length !== this.embeddingDimensions) {
                throw new Error(
                    `Embedding dimension mismatch. Expected ${this.embeddingDimensions}, got ${embedding.length}`
                )
            }
        }

        let documentId!: number

        const tx = db.transaction(() => {
            if (existingDoc) {
                documentId = existingDoc.id

                db.prepare(`
          DELETE FROM chunk_embeddings
          WHERE chunk_id IN (
            SELECT id FROM chunks WHERE document_id = ?
          )
        `).run(documentId)

                db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId)

                db.prepare(`
          UPDATE documents
          SET file_name = ?, updated_at_ms = ?, indexed_at_ms = ?
          WHERE id = ?
        `).run(path.basename(filePath), updatedAtMs, Date.now(), documentId)
            } else {
                const result = db.prepare(`
          INSERT INTO documents (path, file_name, updated_at_ms, indexed_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(filePath, path.basename(filePath), updatedAtMs, Date.now())

                documentId = Number(result.lastInsertRowid)
            }

            const insertChunk = db.prepare(`
        INSERT INTO chunks (document_id, chunk_index, content)
        VALUES (?, ?, ?)
      `)

            const insertEmbedding = db.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, embedding)
        VALUES (?, ?)
      `)

            for (let i = 0; i < chunks.length; i += 1) {
                const chunkResult = insertChunk.run(documentId!, i, chunks[i])
                const chunkId = Number(chunkResult.lastInsertRowid)

                insertEmbedding.run(chunkId, serializeVector(embeddings[i]))
            }
        })

        tx()

        return {
            skipped: false as const,
            chunkCount: chunks.length,
        }
    }

    async search(query: string, limit = 5): Promise<SearchResult[]> {
        const db = getDb()
        const queryEmbedding = await this.embedOne(query)

        if (queryEmbedding.length !== this.embeddingDimensions) {
            throw new Error(
                `Embedding dimension mismatch. Expected ${this.embeddingDimensions}, got ${queryEmbedding.length}`
            )
        }

        const rows = db.prepare(
            `SELECT
                c.id AS chunk_id,
                d.path AS document_path,
                d.file_name AS file_name,
                c.content AS content,
                distance
            FROM chunk_embeddings
            JOIN chunks c ON c.id = chunk_embeddings.chunk_id
            JOIN documents d ON d.id = c.document_id
            WHERE embedding MATCH ?
                AND k = ?
            ORDER BY distance ASC`
        ).all(serializeVector(queryEmbedding), limit) as Array<{
            chunk_id: number
            document_path: string
            file_name: string
            content: string
            distance: number
        }>

        return rows.map((row) => ({
            chunkId: row.chunk_id,
            documentPath: row.document_path,
            fileName: row.file_name,
            content: row.content,
            distance: row.distance,
        }))
    }

    async deleteDocument(filePath: string) {
        const db = getDb()

        const row = db
            .prepare("SELECT id FROM documents WHERE path = ?")
            .get(filePath) as { id: number } | undefined

        if (!row) {
            return { deleted: false }
        }

        // Wrap in a transaction to avoid partial deletes
        const tx = db.transaction(() => {
            db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)`).run(row.id);
            db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(row.id);
            db.prepare(`DELETE FROM documents WHERE id = ?`).run(row.id);
        });
        tx();

        return { deleted: true }
    }
}

function walkDirectory(rootPath: string): string[] {
    const results: string[] = []

    function walk(currentPath: string) {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true })

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name)

            if (entry.isDirectory()) {
                walk(fullPath)
            } else if (entry.isFile()) {
                results.push(fullPath)
            }
        }
    }

    walk(rootPath)
    return results
}

function shouldIndexFile(filePath: string) {
    return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function safeReadTextFile(filePath: string) {
    return fs.readFileSync(filePath, "utf8")
}

function chunkText(text: string, chunkSize = 800, overlap = 120) {
    const normalized = text.replace(/\r\n/g, "\n").trim()
    if (!normalized) return []

    const chunks: string[] = []
    let start = 0

    while (start < normalized.length) {
        const end = Math.min(start + chunkSize, normalized.length)
        const chunk = normalized.slice(start, end).trim()

        if (chunk) chunks.push(chunk)
        if (end === normalized.length) break

        start = Math.max(end - overlap, start + 1)
    }

    return chunks
}

function serializeVector(vector: number[]): Buffer {
    const f32 = new Float32Array(vector);
    return Buffer.from(f32.buffer);
}

