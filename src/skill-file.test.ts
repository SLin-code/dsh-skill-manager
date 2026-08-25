import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isWritableSkill, renderInvocationPolicy, updateSkillInvocation } from './skill-file.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

function definition(path: string, directory: string): SkillDefinition {
  return {
    name: 'example-skill',
    description: 'Example',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: directory },
    path,
    content: '# Instructions',
  }
}

async function fixture(): Promise<{ directory: string; path: string; skill: SkillDefinition }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-skill-manager-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, [
    '---',
    '# keep this comment',
    'name: example-skill',
    'description: Example',
    'metadata:',
    '  owner: local',
    '---',
    '# Instructions',
    '',
    'Do the thing.',
    '',
  ].join('\n'))
  return { directory, path, skill: definition(path, directory) }
}

describe('Skill invocation frontmatter', () => {
  it('preserves comments and body while writing canonical policy keys', async () => {
    const item = await fixture()
    await expect(isWritableSkill(item.skill)).resolves.toBe(true)
    await updateSkillInvocation(item.skill, { modelInvocable: false, userInvocable: true })
    const next = await readFile(item.path, 'utf8')
    expect(next).toContain('# keep this comment')
    expect(next).toContain('disable-model-invocation: true')
    expect(next).toContain('user-invocable: true')
    expect(next.endsWith('# Instructions\n\nDo the thing.\n')).toBe(true)
    await expect(readFile(item.path + '.dsh-skill-manager.lock')).rejects.toThrow()
  })

  it('preserves the exact file mode across the atomic replacement', async () => {
    const item = await fixture()
    await chmod(item.path, 0o764)
    await updateSkillInvocation(item.skill, { modelInvocable: false, userInvocable: true })
    expect((await stat(item.path)).mode & 0o777).toBe(0o764)
  })

  it('rejects invalid frontmatter and an identity change', () => {
    expect(() => renderInvocationPolicy('hello', 'example-skill', {
      modelInvocable: true,
      userInvocable: true,
    })).toThrow('no YAML frontmatter')
    expect(() => renderInvocationPolicy('---\nname: another-skill\n---\nbody\n', 'example-skill', {
      modelInvocable: true,
      userInvocable: true,
    })).toThrow('changed identity')
  })

  it('keeps direct symbolic-link entries read-only', async () => {
    const item = await fixture()
    const linked = join(item.directory, 'linked.md')
    await symlink(item.path, linked)
    const skill = definition(linked, item.directory)
    await expect(isWritableSkill(skill)).resolves.toBe(false)
    await expect(updateSkillInvocation(skill, {
      modelInvocable: false,
      userInvocable: false,
    })).rejects.toThrow('read-only')
  })

  it('keeps entries below a symbolic-link directory read-only', async () => {
    const item = await fixture()
    const base = join(item.directory, 'base')
    const outside = join(item.directory, 'outside')
    await Promise.all([mkdir(base), mkdir(outside)])
    const outsideSkill = join(outside, 'SKILL.md')
    await writeFile(outsideSkill, '---\nname: example-skill\n---\nbody\n')
    await symlink(outside, join(base, 'linked'), 'dir')
    const skill = definition(join(base, 'linked', 'SKILL.md'), base)

    await expect(isWritableSkill(skill)).resolves.toBe(false)
    await expect(updateSkillInvocation(skill, {
      modelInvocable: false,
      userInvocable: false,
    })).rejects.toThrow('read-only')
    expect(await readFile(outsideSkill, 'utf8')).not.toContain('disable-model-invocation')
  })
})
