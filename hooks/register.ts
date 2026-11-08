import type { AgentStatus, ConfigValue, EngineInterface, PromptAutocompleteInput, Register } from 'claude-code'

type State = 'pending' | 'running' | 'waiting' | 'idle'
type Kind = 'agent' | 'shell' | 'monitor'
type Task = { kind: 'shell' | 'monitor'; state: State }
type Main = 'idle' | 'thinking'

const STATES: readonly State[] = ['pending', 'running', 'waiting', 'idle']
const LIVE: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting', 'idle'])

const BOLD = '\x1b[1m'
const UNBOLD = '\x1b[22m'
const RESET = '\x1b[0m'

type Theme = {
  gray: string
  white: string
  elapsed: string
  state: Record<State, string>
  kind: { agents: string; sub: string; sh: string; mon: string }
  main: { idle: string; waiting: string; thinking: string; tool: string }
}

// the color themes, by the names the theme option takes (/agent-count-theme);
// 24-bit ANSI matching the agent-prompt-view status line's palette
const THEMES: Record<string, Theme> = {
  default: {
    gray: '\x1b[38;2;128;128;128m',
    white: '\x1b[38;2;255;255;255m',
    elapsed: '\x1b[38;2;144;238;144m',
    state: {
      pending: '\x1b[38;2;212;201;106m',
      running: '\x1b[38;2;144;238;144m',
      waiting: '\x1b[38;2;135;206;235m',
      idle: '\x1b[38;2;170;170;170m',
    },
    kind: {
      agents: '\x1b[38;2;152;251;152m',
      sub: '\x1b[38;2;135;206;250m',
      sh: '\x1b[38;2;175;238;238m',
      mon: '\x1b[38;2;255;160;160m',
    },
    main: { idle: '\x1b[38;2;255;255;255m', waiting: '\x1b[38;2;135;206;235m', thinking: '\x1b[38;2;255;0;255m', tool: '\x1b[38;2;239;100;124m' },
  },
}
const THEME_NAMES = Object.keys(THEMES)
let theme = THEMES.default

// a subagent's task on its `->` line is cut to this many characters
const TASK_MAX = 60

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

const clip = (text: string) => (text.length > TASK_MAX ? `${text.slice(0, TASK_MAX - 1)}…` : text)

const pair = (key: string, value: number, color = '') =>
  `${BOLD}${key}${UNBOLD}:${color}${value}${color === '' ? '' : theme.gray}`

// the key in the kind's color (agents: gray), the value colored only when non-zero
const kindPair = (key: keyof Theme['kind'], value: number | 'main') => {
  const label = key === 'agents' ? `${BOLD}${key}${UNBOLD}` : `${theme.kind[key]}${BOLD}${key}${UNBOLD}${theme.gray}`
  return `${label}:${value !== 0 ? `${theme.kind[key]}${value}${theme.gray}` : value}`
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
// when each live agent was first listed: `AgentInfo` has no start time
const agentSince = new Map<string, number>()
let shown = ''

// sets this plugin's /config row of the field; the reason when it was refused
async function setOption($: EngineInterface, field: string, value: ConfigValue) {
  const row = (await $.config.list()).find(one => one.provider.plugin === $.plugin.name && one.key.endsWith(`.${field}`))

  return row === undefined ? undefined : (await $.config.set({ key: row.key, value })).deny
}

async function refresh($: EngineInterface) {
  const agents = (await $.agent.list()).filter(agent => LIVE.has(agent.status))
  const now = await $.clock.now()
  const byKind: Record<Kind, number> = { agent: agents.length, shell: 0, monitor: 0 }
  const byState: Record<State, number> = { pending: 0, running: 0, waiting: 0, idle: 0 }

  for (const agent of agents) byState[toState(agent.status)] += 1
  for (const task of tasks.values()) {
    byKind[task.kind] += 1
    byState[task.state] += 1
  }

  const { gray: GRAY, white: WHITE, elapsed: ELAPSED_COLOR, state: COLOR, kind: KIND_COLOR, main: MAIN_COLOR } = theme
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
      ? mainSince === undefined ? '' : ` ${ELAPSED_COLOR}(${elapsed(now - mainSince)})`
      : mainLast === undefined ? '' : ` ${GRAY}(ltt:${WHITE}${elapsed(mainLast)}${GRAY})`

  const total = byKind.agent + byKind.shell + byKind.monitor
  // only the main loop at work (thinking or in a tool call): `agents:main` instead of a zero
  const agentsValue = total === 0 && (tool !== undefined || main !== 'idle') ? 'main' : total
  const line =
    `${GRAY}⚙ ${BOLD}main${UNBOLD}:${mainLabel}${mainTime}${GRAY} │ ${kindPair('agents', agentsValue)} ` +
    `(${kindPair('sub', byKind.agent)} ${kindPair('sh', byKind.shell)} ${kindPair('mon', byKind.monitor)}) -> ` +
    STATES.map(state => pair(state, byState[state], byState[state] > 0 ? COLOR[state] : '')).join(' ') +
    RESET

  const live = new Set(agents.map(agent => agent.id))
  for (const id of agentSince.keys()) if (!live.has(id)) agentSince.delete(id)
  for (const agent of agents) if (!agentSince.has(agent.id)) agentSince.set(agent.id, now)

  // one `-> <type> (time:<run time>) [<task>]` line per live agent, oldest first;
  // a teammate goes by its name
  const subs = agents
    .map(agent => ({ agent, since: agentSince.get(agent.id) ?? now }))
    .sort((a, b) => a.since - b.since)
    .map(({ agent, since }) => {
      const who = agent.type === 'teammate' && agent.name !== undefined ? agent.name : agent.type
      return (
        `${GRAY}-> ${KIND_COLOR.sub}${who}${GRAY} (time:${ELAPSED_COLOR}${elapsed(now - since)}${GRAY}) ` +
        `[${WHITE}${clip(agent.description)}${GRAY}]${RESET}`
      )
    })

  const text = [line, ...subs].map(row => `${row}\n`).join('')

  if (text === shown || file === undefined) return
  shown = text
  await $.fs.write(file, text)
}

// typeahead rows for the theme command: `/agent-count-theme <theme>` rows while the command
// itself is being typed (the event never fires for an empty token, so not right
// after the space), then the themes that start with the typed argument
function themeRows(e: PromptAutocompleteInput, names: readonly string[], current: string) {
  const before = e.text.slice(0, e.cursor)
  const command = '/agent-count-theme'
  const row = (name: string, text: string) => ({ text, description: name === current ? 'current theme' : 'theme' })

  // from the command's own part on (`/agent-count-`), not with every command
  if (e.start === 0 && e.token.length > command.lastIndexOf('-') && command.startsWith(e.token)) {
    return names.map(name => row(name, `${command} ${name}`))
  }

  const arg = /^\/agent-count-theme\s+(\S+)$/.exec(before)?.[1]?.toLowerCase()

  return arg === undefined ? [] : names.filter(name => name.startsWith(arg) && name !== arg).map(name => row(name, name))
}

export const register: Register = (on, options) => {
  theme = THEMES[String(options.theme)] ?? THEMES.default

  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    file = `${home}/.claude/agent-count/${await $.session.id()}`
    shown = ''
    main = 'idle'
    mainTools.length = 0
    mainSince = undefined
    mainLast = undefined
    agentSince.clear()
    await refresh($)
    $.clock.every(1000, () => refresh($))
    await $.command.register({
      name: 'agent-count-theme',
      description: "The agent-count line's color theme",
      argumentHint: `[${THEME_NAMES.join('|')}]`,
    })

    return next(e)
  })

  // /agent-count-theme <name>: the theme option; the current one when no argument
  on('command.run', { command: 'agent-count-theme' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = THEME_NAMES.find(name => THEMES[name] === theme) ?? 'default'

    if (arg === '') return { text: `Agent-count theme: ${current} (one of ${THEME_NAMES.join(', ')})` }
    if (!THEME_NAMES.includes(arg)) return { text: `Usage: /agent-count-theme [${THEME_NAMES.join('|')}]` }

    const deny = await setOption($, 'theme', arg)

    if (deny !== undefined) return { text: `The agent-count theme was not changed: ${deny}` }

    theme = THEMES[arg]
    shown = ''
    await refresh($)

    return { text: `The agent-count line now uses the ${arg} theme.` }
  }).catch(($, e, next) => next(e))

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

  // the theme names in the prompt box's typeahead for /agent-count-theme
  on('prompt.autocomplete', ($, e, next) => {
    const rows = themeRows(e, THEME_NAMES, THEME_NAMES.find(name => THEMES[name] === theme) ?? 'default')

    if (rows.length === 0) return next(e)

    return next(e).then(result => ({ suggestions: [...result.suggestions, ...rows] }))
  }).catch(($, e, next) => next(e))
}
