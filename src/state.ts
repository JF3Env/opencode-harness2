import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, lstat, open, rename, rm, rmdir } from "node:fs/promises"
import { join, isAbsolute } from "node:path"

export type Lesson = {
  id: string
  status: "candidate" | "approved" | "removed"
  cue: string
  lesson: string
  evidence: string
  source: string
  harness: Record<string, string>
  created: string
}
type Database = { version: 1; enabled: boolean; lessons: Lesson[] }
const empty = (): Database => ({ version: 1, enabled: false, lessons: [] })
export const projectKey = (directory: string) => createHash("sha256").update(directory).digest("hex")
const secret = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_\-]{12,}|(?:api[_-]?key|password|authorization)\s*[:=]\s*\S{8,})/i

export function validateLesson(input: Pick<Lesson, "cue" | "lesson" | "evidence" | "source">, general = false) {
  for (const value of Object.values(input)) {
    if (typeof value !== "string" || !value.trim() || value.length > 4000 || secret.test(value)) {
      throw new Error("A lesson needs bounded text, provenance, and no apparent credentials.")
    }
    if (general && /(?:https?:\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|\b\S+@\S+\b)/.test(value)) {
      throw new Error("General lessons must not contain URLs, personal paths, or email addresses.")
    }
  }
}

export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("State requires a private directory without a symlink.")
}

export class MemoryStore {
  readonly root: string
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("The state directory must be absolute.")
    this.root = root
  }

  private filename(key: string) {
    if (!/^(?:[a-f0-9]{64}|general)$/.test(key)) throw new Error("Invalid state key.")
    return join(this.root, `${key}.json`)
  }

  async read(key: string): Promise<Database> {
    await privateDirectory(this.root)
    try {
      const file = await open(this.filename(key), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        const link = await lstat(this.filename(key))
        if (!stat.isFile() || link.isSymbolicLink() || stat.size > 2_000_000 || (stat.mode & 0o077)) throw new Error("Unsafe state file.")
        const data = JSON.parse(await file.readFile("utf8")) as Database
        if (data.version !== 1 || typeof data.enabled !== "boolean" || !Array.isArray(data.lessons)) throw new Error("Unsupported state format.")
        for (const lesson of data.lessons) {
          validateLesson({ cue: lesson.cue, lesson: lesson.lesson, evidence: lesson.evidence, source: lesson.source }, key === "general")
          if (!/^[a-f0-9]{64}$/.test(lesson.id) || !["candidate", "approved", "removed"].includes(lesson.status)) throw new Error("Invalid lesson record.")
        }
        return data
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Unsafe state file.")
      throw error
    }
  }

  private async update<T>(key: string, change: (data: Database) => T): Promise<T> {
    await privateDirectory(this.root)
    const filename = this.filename(key)
    const lock = `${filename}.lock`
    await mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error("State is busy or locked. No update was applied.") })
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      const data = await this.read(key)
      const result = change(data)
      const content = JSON.stringify(data, null, 2) + "\n"
      if (content.length > 2_000_000) throw new Error("State capacity reached. Remove obsolete lessons first.")
      const file = await open(temporary, "wx", 0o600)
      try { await file.writeFile(content); await file.sync() } finally { await file.close() }
      await rename(temporary, filename)
      return result
    } finally {
      await rm(temporary, { force: true })
      await rmdir(lock)
    }
  }

  async enable(key: string, enabled: boolean) { return this.update(key, (data) => { data.enabled = enabled; return enabled }) }

  async add(key: string, input: Pick<Lesson, "cue" | "lesson" | "evidence" | "source">, harness: Record<string, string> = {}) {
    validateLesson(input, key === "general")
    if (key === "general" && Object.keys(harness).length) throw new Error("General lessons cannot carry a project harness.")
    if (Object.values(harness).some((value) => typeof value !== "string" || secret.test(value)) || JSON.stringify(harness).length > 32_000) throw new Error("Invalid lesson harness.")
    const id = projectKey(JSON.stringify(input))
    return this.update(key, (data) => {
      const previous = data.lessons.find((lesson) => lesson.id === id)
      if (previous) return previous
      const lesson: Lesson = { ...input, id, harness, status: "candidate", created: new Date().toISOString() }
      data.lessons.push(lesson)
      return lesson
    })
  }

  async setStatus(key: string, id: string, status: "approved" | "removed") {
    return this.update(key, (data) => {
      const lesson = data.lessons.find((entry) => entry.id === id)
      if (!lesson || lesson.status === "removed") throw new Error("The lesson does not exist or was removed.")
      lesson.status = status
      return lesson
    })
  }

  async relevant(key: string, query: string, maxChars = 6000) {
    const data = await this.read(key)
    if (!data.enabled) return []
    const general = await this.read("general")
    const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])
    const ranked = [...data.lessons, ...general.lessons].filter((lesson) => lesson.status === "approved")
      .map((lesson) => ({ lesson, weight: [...words].filter((word) => `${lesson.cue} ${lesson.lesson}`.toLowerCase().includes(word)).length }))
      .filter((entry) => entry.weight > 0).sort((a, b) => b.weight - a.weight || a.lesson.id.localeCompare(b.lesson.id))
    let size = 0
    return ranked.filter(({ lesson }) => {
      size += lesson.cue.length + lesson.lesson.length + lesson.evidence.length + lesson.id.length + 40
      return size <= maxChars
    }).slice(0, 3).map(({ lesson }) => lesson)
  }
}
