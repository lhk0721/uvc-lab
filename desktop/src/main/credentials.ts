import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Credential store, design section 2. safeStorage is a cipher, not a store:
// index.ts injects its encrypt/decrypt and this module owns the file. The
// design's no-plaintext rule is enforced here: when encryption is unavailable
// (or Linux falls back to basic_text) nothing is ever written to disk —
// credentials live in memory for this run and the user is asked again next
// time. Passwords cross IPC only inward (store/delete); there is no read
// channel, so the renderer can never get a value back out.

export interface Credentials {
  user: string
  password: string
  // Only for the different-account case; normally the SSH password IS the
  // sudo password and is tried first (design section 2, sudo).
  sudoPassword?: string
}

export interface CredentialCipher {
  /** False means: never persist, keep credentials in memory only. */
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

interface StoredEntry {
  user: string
  password: string // base64 of encrypt()
  sudoPassword?: string
}

interface FileShape {
  version: 1
  entries: Record<string, StoredEntry>
}

export class CredentialStore {
  private readonly memory = new Map<string, Credentials>()

  constructor(
    private readonly filePath: string,
    private readonly cipher: CredentialCipher
  ) {}

  /** True when credentials survive an app restart (encryption available). */
  canPersist(): boolean {
    return this.cipher.available()
  }

  /** Existence + username only — this is all the renderer may learn. */
  has(jetsonId: string): { user: string } | null {
    const creds = this.get(jetsonId)
    return creds ? { user: creds.user } : null
  }

  /** Full credentials. Main-process internal; never exposed over IPC. */
  get(jetsonId: string): Credentials | null {
    const inMemory = this.memory.get(jetsonId)
    if (inMemory) return inMemory
    const entry = this.readFile().entries[jetsonId]
    if (!entry) return null
    try {
      const creds: Credentials = {
        user: entry.user,
        password: this.cipher.decrypt(Buffer.from(entry.password, 'base64')),
        ...(entry.sudoPassword !== undefined && {
          sudoPassword: this.cipher.decrypt(Buffer.from(entry.sudoPassword, 'base64'))
        })
      }
      this.memory.set(jetsonId, creds)
      return creds
    } catch {
      // Undecryptable (file copied from another machine/account): as good as
      // absent — the app just asks again.
      return null
    }
  }

  /** Every id with usable credentials, for the identify hook to try. */
  list(): string[] {
    const ids = new Set(this.memory.keys())
    for (const id of Object.keys(this.readFile().entries)) {
      if (this.get(id)) ids.add(id)
    }
    return [...ids]
  }

  set(jetsonId: string, creds: Credentials): void {
    this.memory.set(jetsonId, creds)
    if (!this.cipher.available()) return
    const file = this.readFile()
    file.entries[jetsonId] = {
      user: creds.user,
      password: this.cipher.encrypt(creds.password).toString('base64'),
      ...(creds.sudoPassword !== undefined && {
        sudoPassword: this.cipher.encrypt(creds.sudoPassword).toString('base64')
      })
    }
    this.writeFile(file)
  }

  delete(jetsonId: string): void {
    this.memory.delete(jetsonId)
    if (!this.cipher.available()) return
    const file = this.readFile()
    if (jetsonId in file.entries) {
      delete file.entries[jetsonId]
      this.writeFile(file)
    }
  }

  private readFile(): FileShape {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as FileShape
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return parsed
      }
    } catch {
      // Missing or corrupt file: start empty rather than crash — the worst
      // case is asking the user for a password again.
    }
    return { version: 1, entries: {} }
  }

  private writeFile(file: FileShape): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), '.credentials.json.tmp')
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }
}
