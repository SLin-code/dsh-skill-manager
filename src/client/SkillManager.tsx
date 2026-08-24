import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManagedSkillDetail, ManagedSkillEntry } from '../protocol.ts'
import css from './SkillManager.module.css'

export interface SkillManagerInjected {
  list: (sessionId: string) => Promise<{ skills: readonly ManagedSkillEntry[] }>
  get: (sessionId: string, name: string) => Promise<ManagedSkillDetail>
  update: (
    sessionId: string,
    name: string,
    invocation: { modelInvocable: boolean; userInvocable: boolean },
  ) => Promise<ManagedSkillEntry>
}

export type SkillManagerProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dsh.skillManager'>
  & InjectFace<SkillManagerInjected>

type CatalogState =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'ready'; skills: readonly ManagedSkillEntry[] }
type DetailState =
  | { status: 'loading' | 'error' }
  | { status: 'ready'; detail: ManagedSkillDetail }

function matches(skill: ManagedSkillEntry, query: string): boolean {
  return query.length === 0 || [skill.name, skill.description, skill.path, skill.source, skill.provider]
    .some(value => value.toLocaleLowerCase().includes(query))
}

export function SkillManager({ list, get, update, useSessions, t }: SkillManagerProps): ReactNode {
  const catalogId = useId()
  const sessionId = useSessions(state => state.current)
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'idle' })
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set())
  const [saveError, setSaveError] = useState<string | null>(null)
  const mounted = useRef(true)
  const activeSession = useRef<string | undefined>(sessionId)
  activeSession.current = sessionId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setExpanded(null)
    setDetails({})
    setSaving(new Set())
    setSaveError(null)
  }, [sessionId])

  useEffect(() => {
    if (sessionId === undefined) {
      setCatalog({ status: 'idle' })
      return
    }
    let current = true
    setCatalog({ status: 'loading' })
    void list(sessionId).then(
      value => { if (current) setCatalog({ status: 'ready', skills: value.skills }) },
      () => { if (current) setCatalog({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request, sessionId])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () => catalog.status === 'ready' ? catalog.skills.filter(skill => matches(skill, normalizedQuery)) : [],
    [catalog, normalizedQuery],
  )

  const openSkill = (skill: ManagedSkillEntry): void => {
    if (sessionId === undefined) return
    if (expanded === skill.name) {
      setExpanded(null)
      return
    }
    setExpanded(skill.name)
    const cached = details[skill.name]
    if (cached !== undefined && cached.status !== 'error') return
    setDetails(current => ({ ...current, [skill.name]: { status: 'loading' } }))
    void get(sessionId, skill.name).then(
      detail => {
        if (mounted.current && activeSession.current === sessionId) {
          setDetails(current => ({ ...current, [skill.name]: { status: 'ready', detail } }))
        }
      },
      () => {
        if (mounted.current && activeSession.current === sessionId) {
          setDetails(current => ({ ...current, [skill.name]: { status: 'error' } }))
        }
      },
    )
  }

  const save = (skill: ManagedSkillEntry, invocation: { modelInvocable: boolean; userInvocable: boolean }): void => {
    if (sessionId === undefined || !skill.writable || saving.has(skill.name)) return
    setSaveError(null)
    setSaving(current => new Set(current).add(skill.name))
    void update(sessionId, skill.name, invocation).then(
      next => {
        if (!mounted.current || activeSession.current !== sessionId) return
        setCatalog(current => current.status === 'ready'
          ? { status: 'ready', skills: current.skills.map(item => item.name === next.name ? next : item) }
          : current)
        setDetails(current => {
          const detail = current[next.name]
          return detail?.status === 'ready'
            ? { ...current, [next.name]: { status: 'ready', detail: { ...detail.detail, ...next } } }
            : current
        })
      },
      () => {
        if (mounted.current && activeSession.current === sessionId) setSaveError(skill.name)
      },
    ).finally(() => {
      if (!mounted.current || activeSession.current !== sessionId) return
      setSaving(current => {
        const next = new Set(current)
        next.delete(skill.name)
        return next
      })
    })
  }

  if (sessionId === undefined) return <p className={css.status}>{t('noSession')}</p>

  return (
    <div className={css.section} aria-busy={catalog.status === 'loading'}>
      {catalog.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {catalog.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : null}
      {catalog.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input type="search" value={query} placeholder={t('search')} aria-label={t('search')}
              onChange={event => { setQuery(event.currentTarget.value) }} />
          </label>
          <div className={css.heading}><h3>{t('catalog')}</h3><span>{filtered.length}</span></div>
          {catalog.skills.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {catalog.skills.length > 0 && filtered.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
          <ul className={css.cards}>
            {filtered.map(skill => {
              const open = expanded === skill.name
              const detail = details[skill.name]
              const busy = saving.has(skill.name)
              const detailId = `${catalogId}-${skill.name}`
              return (
                <li className={css.card} key={skill.name} data-skill={skill.name}>
                  <div className={css.summaryRow}>
                    <button className={css.summary} type="button" aria-expanded={open} aria-controls={detailId}
                      onClick={() => { openSkill(skill) }}>
                      <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                      <span className={css.source}>{skill.source}</span>
                    </button>
                    <div className={css.policies} aria-busy={busy}>
                      <label>
                        <input type="checkbox" checked={skill.modelInvocable} disabled={!skill.writable || busy}
                          onChange={event => { save(skill, { modelInvocable: event.currentTarget.checked, userInvocable: skill.userInvocable }) }} />
                        {t('modelInvocation')}
                      </label>
                      <label>
                        <input type="checkbox" checked={skill.userInvocable} disabled={!skill.writable || busy}
                          onChange={event => { save(skill, { modelInvocable: skill.modelInvocable, userInvocable: event.currentTarget.checked }) }} />
                        {t('userInvocation')}
                      </label>
                      {!skill.writable ? <span className={css.readOnly}>{t('readOnly')}</span> : null}
                      {busy ? <span className={css.saving}>{t('saving')}</span> : null}
                      {saveError === skill.name ? <span className={css.saveError} role="alert">{t('saveError')}</span> : null}
                    </div>
                  </div>
                  {open ? (
                    <div className={css.details} id={detailId}>
                      <dl>
                        <div><dt>{t('source')}</dt><dd>{skill.source}</dd></div>
                        <div><dt>{t('provider')}</dt><dd>{skill.provider}</dd></div>
                        <div><dt>{t('path')}</dt><dd><code>{skill.path}</code></dd></div>
                      </dl>
                      <h4>{t('instructions')}</h4>
                      {detail?.status === 'loading' || detail === undefined ? <p className={css.status}>{t('loading')}</p> : null}
                      {detail?.status === 'error' ? <p className={css.saveError}>{t('detailError')}</p> : null}
                      {detail?.status === 'ready' ? <pre className={css.instructions}>{detail.detail.content}</pre> : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
