import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FILE = '/home/me/.claude/agent-count/'

// the world beneath the plugin: what it writes, no agents, the theme row in /config
function world(on: On) {
  const files = new Map<string, string>()
  const sets: unknown[] = []

  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 0 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const provider = { plugin: 'agent-count', tier: 'user' } as const
  on('config.list', $ => ({
    value: [{ key: `${$.plugin.name}.theme`, label: 'Color theme', kind: 'choice', value: 'default', provider, isLocked: false }],
  }))
  on('config.set', ($, e) => {
    sets.push(`${e.key.split('.').at(-1)}=${e.value}`)
    return { value: e.value }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { HOME: '/home/me' })

  return { files, sets, line: () => [...files.entries()].find(([path]) => path.startsWith(FILE))?.[1] }
}

const start = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const run = (args: string) => ({
  command: 'agent-count-theme',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}) as const

// the line as the default colors drew it before themes
const IDLE =
  '\x1b[38;2;128;128;128m⚙ \x1b[1mmain\x1b[22m:\x1b[38;2;255;255;255midle\x1b[38;2;128;128;128m │ \x1b[1magents\x1b[22m:0 ' +
  '(\x1b[38;2;135;206;250m\x1b[1msub\x1b[22m\x1b[38;2;128;128;128m:0 \x1b[38;2;175;238;238m\x1b[1msh\x1b[22m\x1b[38;2;128;128;128m:0 ' +
  '\x1b[38;2;255;160;160m\x1b[1mmon\x1b[22m\x1b[38;2;128;128;128m:0) -> ' +
  '\x1b[1mpending\x1b[22m:0 \x1b[1mrunning\x1b[22m:0 \x1b[1mwaiting\x1b[22m:0 \x1b[1midle\x1b[22m:0\x1b[0m\n'

test('the default theme draws the line in the original colors', async ($, on) => {
  const { line } = world(on)

  await $.session.start(start)

  expect(line()).toBe(IDLE)
})

test('an unknown theme option falls back to default', { options: { theme: 'neon' } }, async ($, on) => {
  const { line } = world(on)

  await $.session.start(start)

  expect(line()).toBe(IDLE)
})

test('/agent-count-theme sets the option, shows it with no argument', async ($, on) => {
  const { sets, line } = world(on)

  await $.session.start(start)

  expect((await $.command.run(run(''))).text).toBe('Agent-count theme: default (one of default)')
  expect((await $.command.run(run('default'))).text).toBe('The agent-count line now uses the default theme.')
  expect(sets).toEqual(['theme=default'])
  expect(line()).toBe(IDLE)
  expect((await $.command.run(run('neon'))).text).toBe('Usage: /agent-count-theme [default]')
})

// the prompt box with the caret at the end, as prompt.autocomplete sees it
const typed = (text: string) => {
  const start = text.lastIndexOf(' ') + 1
  return { text, cursor: text.length, token: text.slice(start), start }
}

test('the typeahead offers the themes for /agent-count-theme', async ($, on) => {
  world(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))

  await $.session.start(start)

  expect((await $.prompt.autocomplete(typed('/agent-count-t'))).suggestions).toEqual([
    { text: '/agent-count-theme default', description: 'current theme' },
  ])
  expect((await $.prompt.autocomplete(typed('/agent-count-theme d'))).suggestions).toEqual([{ text: 'default', description: 'current theme' }])
  expect((await $.prompt.autocomplete(typed('/agent-count-theme default'))).suggestions).toEqual([])
  expect((await $.prompt.autocomplete(typed('/agent-count-theme x'))).suggestions).toEqual([])
  expect((await $.prompt.autocomplete(typed('/age'))).suggestions).toEqual([])
  expect((await $.prompt.autocomplete(typed('hello /agent-count-theme'))).suggestions).toEqual([])
})
