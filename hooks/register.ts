import type { AgentStatus, EngineInterface, Register } from 'claude-code'

type State = 'pending' | 'running' | 'waiting' | 'idle'
type Kind = 'agent' | 'shell' | 'monitor'
type Task = { kind: 'shell' | 'monitor'; state: State }
type Main = 'idle' | 'thinking'

const STATES: readonly State[] = ['pending', 'running', 'waiting', 'idle']
const LIVE: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting', 'idle'])

const GRAY = '\x1b[38;2;128;128;128m'
const BOLD = '\x1b[1m'
const UNBOLD = '\x1b[22m'
const RESET = '\x1b[0m'
const COLOR: Record<State, string> = {
  pending: '\x1b[38;2;212;201;106m',
  running: '\x1b[38;2;144;238;144m',
  waiting: '\x1b[38;2;135;206;235m',
  idle: '\x1b[38;2;170;170;170m',
}

const KIND_COLOR = {
  agents: '\x1b[38;2;152;251;152m',
  sub: '\x1b[38;2;135;206;250m',
  sh: '\x1b[38;2;175;238;238m',
  mon: '\x1b[38;2;255;160;160m',
}

const MAIN_COLOR = { idle: '\x1b[38;2;255;255;255m', waiting: '\x1b[38;2;135;206;235m', thinking: '\x1b[38;2;255;0;255m', tool: '\x1b[38;2;239;100;124m' }
const ELAPSED_COLOR = '\x1b[38;2;144;238;144m'
const WHITE = '\x1b[38;2;255;255;255m'

const toState = (status: string): State =>
  status === 'pending' ? 'pending' : status === 'waiting' ? 'waiting' : status === 'idle' ? 'idle' : 'running'

// 7s, 1m05s, 1h02m
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')

  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h${pad(Math.floor(s / 60) % 60)}m`
}

const pair = (key: string, value: number, color = '') =>
  `${BOLD}${key}${UNBOLD}:${color}${value}${color === '' ? '' : GRAY}`

// the key in the kind's color (agents: gray), the value colored only when non-zero
const kindPair = (key: keyof typeof KIND_COLOR, value: number) => {
  const label = key === 'agents' ? `${BOLD}${key}${UNBOLD}` : `${KIND_COLOR[key]}${BOLD}${key}${UNBOLD}${GRAY}`
  return `${label}:${value > 0 ? `${KIND_COLOR[key]}${value}${GRAY}` : value}`
}

// shells and monitors have no listing API: tracked from their tool calls,
// dropped on their task-notification, TaskStop, or the Stop hook's snapshot
const tasks = new Map<string, Task>()
let file: string | undefined
// the main loop: its turn, and its tool calls in flight (parallel calls stack)
let main: Main = 'idle'
const mainTools: string[] = []
// when the main loop left idle: the run time of the current prompt
let mainSince: number | undefined
// the run time of the last finished prompt, shown while idle
let mainLast: number | undefined
let shown = ''

async function refresh($: EngineInterface) {
  const agents = (await $.agent.list()).filter(agent => LIVE.has(agent.status))
  const byKind: Record<Kind, number> = { agent: agents.length, shell: 0, monitor: 0 }
  const byState: Record<State, number> = { pending: 0, running: 0, waiting: 0, idle: 0 }

  for (const agent of agents) byState[toState(agent.status)] += 1
  for (const task of tasks.values()) {
    byKind[task.kind] += 1
    byState[task.state] += 1
  }

  const tool = mainTools.at(-1)
  // an idle main loop still waits while background work is pending, running or waiting
  const busy = byState.pending + byState.running + byState.waiting
  const mainState = main === 'idle' && busy > 0 ? 'waiting' : main
  const mainLabel =
    tool !== undefined
      ? `${MAIN_COLOR.tool}tool:${tool}`
      : `${MAIN_COLOR[mainState]}${mainState}`
  const mainTime =
    main !== 'idle'
      ? mainSince === undefined ? '' : ` ${ELAPSED_COLOR}(${elapsed((await $.clock.now()) - mainSince)})`
      : mainLast === undefined ? '' : ` ${GRAY}(ltt:${WHITE}${elapsed(mainLast)}${GRAY})`

  const total = byKind.agent + byKind.shell + byKind.monitor
  const line =
    `${GRAY}⚙ ${BOLD}main${UNBOLD}:${mainLabel}${mainTime}${GRAY} │ ${kindPair('agents', total)} ` +
    `(${kindPair('sub', byKind.agent)} ${kindPair('sh', byKind.shell)} ${kindPair('mon', byKind.monitor)}) │ ` +
    STATES.map(state => pair(state, byState[state], byState[state] > 0 ? COLOR[state] : '')).join(' ') +
    RESET

  if (line === shown || file === undefined) return
  shown = line
  await $.fs.write(file, `${line}\n`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    file = `${home}/.claude/agent-count/${await $.session.id()}`
    shown = ''
    main = 'idle'
    mainTools.length = 0
    mainSince = undefined
    mainLast = undefined
    await refresh($)
    $.clock.every(1000, () => refresh($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (main === 'idle') mainSince = await $.clock.now()
    main = 'thinking'
    mainTools.length = 0
    await refresh($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (main !== 'idle' && mainSince !== undefined) mainLast = (await $.clock.now()) - mainSince
      main = 'idle'
      mainTools.length = 0
      mainSince = undefined
      await refresh($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    mainTools.push(e.tool)
    await refresh($)

    try {
      return await next(e)
    } finally {
      const at = mainTools.lastIndexOf(e.tool)
      if (at !== -1) mainTools.splice(at, 1)
      await refresh($)
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? ran.result.backgroundTaskId : undefined

    if (id !== undefined) tasks.set(id, { kind: 'shell', state: 'running' })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) tasks.set(ran.result.taskId, { kind: 'monitor', state: 'running' })

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id

    if (id !== undefined && ran.deny === undefined) tasks.delete(id)

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      for (const [, id] of e.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) tasks.delete(id.trim())
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    const live = new Map((e.background_tasks ?? []).map(task => [task.id, task]))

    for (const id of tasks.keys()) if (!live.has(id)) tasks.delete(id)
    for (const task of live.values()) {
      const kind = task.type === 'shell' ? 'shell' : task.type === 'monitor' ? 'monitor' : undefined
      if (kind !== undefined) tasks.set(task.id, { kind, state: toState(task.status) })
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
