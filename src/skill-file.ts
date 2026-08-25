import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isMap, parseDocument } from 'yaml'

const WRITABLE_SOURCES = new Set([
  'project-dsh',
  'project-agents',
  'user-dsh',
  'user-agents',
  'custom',
])
const LOCK_WAIT_MS = 25
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000

export interface InvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export class SkillUpdateConflict extends Error {
  override readonly name = 'SkillUpdateConflict'
}

function findClosingFrontmatter(raw: string, start: number): { start: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const newline = raw.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? raw.length : newline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') return { start: lineStart }
    if (newline < 0) return undefined
    lineStart = newline + 1
  }
  return undefined
}

/** Update only the canonical invocation keys while preserving body text and YAML comments. */
export function renderInvocationPolicy(raw: string, expectedName: string, invocation: InvocationPolicy): string {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    throw new Error(`skill "${expectedName}" has no YAML frontmatter`)
  }
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) throw new Error(`skill "${expectedName}" has unclosed YAML frontmatter`)
  const document = parseDocument(raw.slice(start, closing.start), { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error(`skill "${expectedName}" has invalid YAML frontmatter`)
  }
  if (document.get('name') !== expectedName) {
    throw new Error(`skill "${expectedName}" changed identity before update`)
  }
  document.set('disable-model-invocation', !invocation.modelInvocable)
  document.set('user-invocable', invocation.userInvocable)
  const newline = raw.slice(0, firstLineEnd).endsWith('\r') ? '\r\n' : '\n'
  const frontmatter = document.toString().replaceAll('\n', newline)
  return `${raw.slice(0, start)}${frontmatter}${raw.slice(closing.start)}`
}

async function directEntryIsWritable(skill: SkillDefinition): Promise<boolean> {
  if (skill.path === undefined || !WRITABLE_SOURCES.has(skill.source)) return false
  try {
    const file = await lstat(skill.path)
    if (!file.isFile() || file.isSymbolicLink()) return false
    if (skill.resourceBase?.kind === 'directory') {
      const directory = await lstat(skill.resourceBase.path)
      if (directory.isSymbolicLink()) return false
      const lexicalBase = resolve(skill.resourceBase.path)
      const lexicalPath = resolve(skill.path)
      const childPath = relative(lexicalBase, lexicalPath)
      if (childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) return false
      const [resolvedBase, resolvedPath] = await Promise.all([
        realpath(skill.resourceBase.path),
        realpath(skill.path),
      ])
      if (resolvedPath !== resolve(resolvedBase, childPath)) return false
    }
    return true
  } catch {
    return false
  }
}

export async function isWritableSkill(skill: SkillDefinition): Promise<boolean> {
  return await directEntryIsWritable(skill)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = path + '.dsh-skill-manager.lock'
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      const token = randomUUID()
      const ownerPath = join(lockPath, 'owner')
      try {
        await writeFile(ownerPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return async () => {
        try {
          if (await readFile(ownerPath, 'utf8') !== token) return
          await rm(lockPath, { recursive: true, force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      try {
        const lock = await stat(lockPath)
        if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (inspectError) {
        if ((inspectError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw inspectError
      }
      if (Date.now() >= deadline) throw new SkillUpdateConflict(`skill "${basename(path)}" is busy; try again`)
      await sleep(LOCK_WAIT_MS)
    }
  }
}

async function atomicReplace(path: string, content: string, mode: number): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', mode & 0o777)
    // open(2) applies the process umask; restore the source file's exact mode.
    await handle.chmod(mode & 0o777)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    try {
      const directoryHandle = await open(directory, 'r')
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    } catch {
      // Directory fsync is not supported on every platform; the file rename is still atomic.
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Safely mutate one already-resolved, direct disk-backed Skill definition. */
export async function updateSkillInvocation(
  skill: SkillDefinition,
  invocation: InvocationPolicy,
): Promise<void> {
  if (!await directEntryIsWritable(skill) || skill.path === undefined) {
    throw new SkillUpdateConflict(`skill "${skill.name}" is read-only`)
  }
  const release = await acquireLock(skill.path)
  try {
    const info = await lstat(skill.path)
    if (!info.isFile() || info.isSymbolicLink()) throw new SkillUpdateConflict(`skill "${skill.name}" is read-only`)
    const raw = await readFile(skill.path, 'utf8')
    let next: string
    try {
      next = renderInvocationPolicy(raw, skill.name, invocation)
    } catch (error) {
      throw new SkillUpdateConflict(error instanceof Error ? error.message : `skill "${skill.name}" cannot be updated`)
    }
    await atomicReplace(skill.path, next, info.mode)
  } finally {
    await release()
  }
}
