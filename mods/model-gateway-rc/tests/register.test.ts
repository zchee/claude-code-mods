import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const GATEWAY = 'http://127.0.0.1:18764'
const SESSION = 'session-1'
const PID = 4242
const PROJECT = '/home/me/.claude/projects/-work-repo'
const LEAD = 'lead-session-7'
const LEADS = '/home/me/.claude/model-gateway-rc/leads'

/** `ps -o command=` of a tmux teammate as Claude Code 2.1.303 starts it. */
const TEAMMATE_COMMAND = `/Users/me/.local/bin/claude --agent-id envprobe@session-lead --agent-name envprobe --team-name session-lead --agent-color blue --parent-session-id ${LEAD} --dangerously-skip-permissions --model claude-gpt-6.1-sol-fast[1m]\n`

/**
 * What `model-gateway.js env` printed on 2026-10-07: advice around one JSON
 * object whose braces start a line.
 */
const ENV_STDOUT = `add this to the "env" block of this project's .claude/settings.local.json:
{
  "env": {
    "ANTHROPIC_BASE_URL": "${GATEWAY}",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
    "ENABLE_TOOL_SEARCH": "true",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5[1m]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1[1m]"
  }
}

or use /model-gateway:model-gateway to run its env --write-project command
`

/**
 * The machine beneath the plugin: its environment, the gateway's health,
 * Remote Control's pointer, and what the plugin did to them.
 */
type World = {
  env: Map<string, string>
  isReachable: boolean
  isOk: boolean
  pointerPid: number | undefined
  runs: string[][]
  toasts: string[]
  isRcListed: boolean
  commands: { command: string; baseUrl: string | undefined }[]
  duringRc: (() => Promise<void>) | undefined
  sets: string[]
  held: Set<string>
  isHanging: boolean
  envExitCode: number
  envStdout: string
  psStdout: string
  files: Map<string, string>
  ensureGate: Promise<void> | undefined
  leadReadGate: Promise<void> | undefined
  leadReads: number
  probeGate: Promise<void> | undefined
  sessionId: string
  filesAtSpawn: string[] | undefined
}

function worldOf(on: On, env: Record<string, string> = {}): World {
  const world: World = {
    env: new Map(Object.entries({
      HOME: '/home/me',
      CLAUDE_CODE_MESSAGING_SOCKET: `/private/tmp/user/501/cc-socks/${PID}.sock`,
      ...env,
    })),
    isReachable: true,
    isOk: true,
    pointerPid: undefined,
    runs: [],
    toasts: [],
    isRcListed: true,
    commands: [],
    duringRc: undefined,
    sets: [],
    held: new Set(),
    isHanging: false,
    envExitCode: 0,
    envStdout: ENV_STDOUT,
    psStdout: '/Users/me/.local/bin/claude --model claude-opus-5-5\n',
    files: new Map(),
    ensureGate: undefined,
    leadReadGate: undefined,
    leadReads: 0,
    probeGate: undefined,
    sessionId: SESSION,
    filesAtSpawn: undefined,
  }
  on('env.get', async ($, e) => ({ value: world.env.get(e.name) }))
  on('env.set', async ($, e) => {
    world.sets.push(e.name)
    if (world.held.has(e.name)) return { value: { deny: `${e.name} is managed by your organization` } }
    if (e.value === undefined) world.env.delete(e.name)
    else world.env.set(e.name, e.value)
    return { value: {} }
  })
  on('process.run', async ($, e) => {
    world.runs.push([...e.argv])
    if (e.argv[0] === 'ps') {
      const isOwn = e.argv.at(-1) === String(PID)
      return { value: { exitCode: isOwn ? 0 : 1, stdout: isOwn ? world.psStdout : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv.includes('ensure')) await world.ensureGate
    const isEnv = e.argv.includes('env')
    return { value: { exitCode: isEnv ? world.envExitCode : 0, stdout: isEnv ? world.envStdout : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', async ($, e) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('http.fetch', async () => {
    if (world.isHanging) await new Promise(() => {})
    await world.probeGate
    if (!world.isReachable) return { deny: 'connect ECONNREFUSED 127.0.0.1:18764' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: world.isOk }) } }
  })
  on('session.id', async () => ({ value: world.sessionId }))
  on('agent.spawn', async ($, e) => {
    world.filesAtSpawn = e.isTeammate === true ? [...world.files.keys()] : []
    return { model: 'claude-gpt-6.1-sol-fast[1m]', teammateId: `${e.name}@team` }
  })
  on('fs.list', async ($, e) => {
    if (e.path !== LEADS) return { value: [{ name: '-work-repo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }
    const names = [...world.files.keys()].filter((path) => path.startsWith(`${LEADS}/`)).map((path) => path.slice(LEADS.length + 1))
    return { value: names.map((name) => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', async ($, e) => ({ value: e.path === `${PROJECT}/${SESSION}.jsonl` }))
  on('fs.read', async ($, e) => {
    if (e.path.startsWith(`${LEADS}/`)) {
      world.leadReads += 1
      await world.leadReadGate
    }
    const file = world.files.get(e.path)
    if (file !== undefined) return { value: file }
    if (e.path !== `${PROJECT}/bridge-pointer.json` || world.pointerPid === undefined) return { deny: 'ENOENT' }
    return { value: JSON.stringify({ sessionId: 'cse_1', environmentId: 'env_1', source: 'repl', pid: world.pointerPid }) }
  })
  on('ui.toast', async ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('command.list', async () => ({
    value: world.isRcListed ? [{ name: 'remote-control', description: 'Disconnect Remote Control', source: 'builtin' as const }] : [],
  }))
  on('command.run', { command: ['reload-plugins', 'remote-control'] }, async ($, e) => {
    world.commands.push({ command: e.command, baseUrl: world.env.get('ANTHROPIC_BASE_URL') })
    if (e.command === 'remote-control') await world.duringRc?.()
    return { text: e.command === 'remote-control' ? 'Remote Control disconnected.' : 'Reloaded' }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  return world
}

async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
}

async function gateway($: Engine, args: string): Promise<string | undefined> {
  return (await $.command.run({ command: 'gateway', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text
}

function wiredEnvOf(world: World): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(WIRED).map((key) => [key, world.env.get(key)]))
}

const WIRED = {
  ANTHROPIC_BASE_URL: GATEWAY,
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-1[1m]',
}

describe('Remote Control detection', () => {
  test('wires every gateway variable once the bridge pointer names this process', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)

    await clock.advance(2000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'no pointer yet: still on api.anthropic.com').toBeUndefined()

    world.pointerPid = PID
    await clock.advance(2000)
    expect(wiredEnvOf(world)).toEqual(WIRED)
    expect(world.runs).toContainEqual(['node', '/home/me/.claude/model-gateway/model-gateway.js', 'ensure', '--quiet'])
    expect(world.toasts.at(-1)).toMatch(/Remote Control registered; requests now go through/)
  })

  test('leaves the session alone when the pointer names another process', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.pointerPid = 9999
    await startSession($)

    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^waiting/)
  })

  test('leaves a session already pointed at another endpoint alone', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { ANTHROPIC_BASE_URL: 'https://llm.example.com' })
    world.pointerPid = PID
    await startSession($)

    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBe('https://llm.example.com')
    expect(await gateway($, 'status')).toMatch(/^off/)
  })

  test('counts a session already pointed at the gateway as wired, and off then clears only the base URL', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { ANTHROPIC_BASE_URL: GATEWAY, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })
    await startSession($)

    await clock.advance(6000)
    expect(await gateway($, 'status')).toMatch(/^on:/)
    expect(world.runs.filter((argv) => argv.includes('ensure')).length, 'wired from the start: nothing to ensure').toBe(0)

    expect(await gateway($, 'off')).toBe('requests now go to api.anthropic.com')
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(world.env.get('CLAUDE_CODE_MAX_OUTPUT_TOKENS'), 'no snapshot to restore: the rest is left as it was').toBe('64000')
  })
})

describe('health watchdog', () => {
  test('unwires after two unreachable checks and restores what the session had', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' })
    await startSession($)
    expect(await gateway($, 'on')).toMatch(/^requests now go through/)
    expect(wiredEnvOf(world)).toEqual(WIRED)

    world.isReachable = false
    await clock.advance(2000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'one failed check is not enough').toBe(GATEWAY)

    await clock.advance(2000)
    expect(wiredEnvOf(world)).toEqual({
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: undefined,
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: undefined,
      ENABLE_TOOL_SEARCH: undefined,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      ANTHROPIC_DEFAULT_FABLE_MODEL: undefined,
    })
    expect(world.toasts.at(-1)).toMatch(/stopped answering; requests now go to api\.anthropic\.com/)
    expect(await gateway($, 'status')).toMatch(/^suspended/)
  })

  test('rewires after two reachable checks once the gateway answers again', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    world.isReachable = false
    await clock.advance(4000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()

    world.isReachable = true
    await clock.advance(2000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'one good check is not enough').toBeUndefined()

    await clock.advance(2000)
    expect(wiredEnvOf(world)).toEqual(WIRED)
    expect(world.toasts.at(-1)).toMatch(/answers again; requests now go through/)
  })

  test('asks the gateway CLI to start the gateway while suspended, at most every 30 seconds', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    world.isReachable = false
    await clock.advance(4000)
    const ensures = () => world.runs.filter((argv) => argv.includes('ensure')).length
    const afterUnwire = ensures()

    await clock.advance(20_000)
    expect(ensures(), 'within 30 seconds of the last ensure').toBe(afterUnwire)

    await clock.advance(12_000)
    expect(ensures()).toBe(afterUnwire + 1)
  })

  test('counts a check that gets no answer within three seconds as unreachable', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')

    world.isHanging = true
    await clock.advance(2000)
    await clock.advance(3000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'one timed-out check is not enough').toBe(GATEWAY)

    await clock.advance(1000)
    await clock.advance(3000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(world.toasts.at(-1)).toMatch(/stopped answering; requests now go to api\.anthropic\.com/)
  })

  test('keeps a degraded gateway wired and says so once', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')

    world.isOk = false
    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBe(GATEWAY)
    expect(world.toasts.filter((t) => t.includes('reports a problem')).length).toBe(1)
    expect(await gateway($, 'status')).toMatch(/\(degraded\)$/)
  })
})

describe('/gateway', () => {
  test('on refuses to wire when the gateway does not answer', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.isReachable = false
    await startSession($)

    expect(await gateway($, 'on')).toMatch(/is not answering; requests stay on api\.anthropic\.com/)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
  })

  test('on sets ANTHROPIC_BASE_URL after every other gateway variable', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')

    expect([...world.sets].sort()).toEqual(Object.keys(WIRED).sort())
    expect(world.sets.indexOf('ANTHROPIC_BASE_URL')).toBe(world.sets.length - 1)
  })

  const holds = {
    'the base URL, after every pin was written': 'ANTHROPIC_BASE_URL',
    'a switch, before the base URL': 'ENABLE_TOOL_SEARCH',
  }
  for (const [name, variable] of Object.entries(holds)) {
    test(`on restores the session and turns off when Claude Code holds ${name}`, async ($, on) => {
      const clock = mock.clock(on)
      const world = worldOf(on, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' })
      world.held.add(variable)
      await startSession($)
      const before = wiredEnvOf(world)

      expect(await gateway($, 'on')).toBe(
        `Claude Code held a gateway variable (${variable} is managed by your organization); requests stay on api.anthropic.com`,
      )
      expect(wiredEnvOf(world), 'every write made before the hold is undone').toEqual(before)
      expect(await gateway($, 'status')).toMatch(/^off/)

      const toasts = world.toasts.length
      await clock.advance(10_000)
      expect(world.toasts.length, 'the watchdog does not retry a held write').toBe(toasts)
      expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    })
  }

  const unreadable = {
    'exits non-zero': { exitCode: 1, stdout: ENV_STDOUT },
    'prints no env block': { exitCode: 0, stdout: 'the gateway is not installed\n' },
    'prints a malformed env block': { exitCode: 0, stdout: '{\n  "env": {\n}\n' },
  }
  for (const [name, run] of Object.entries(unreadable)) {
    test(`on wires the fixed values and the default gateway, pins unchanged, when \`env\` ${name}`, async ($, on) => {
      mock.clock(on)
      const world = worldOf(on, { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' })
      world.envExitCode = run.exitCode
      world.envStdout = run.stdout
      await startSession($)

      expect(await gateway($, 'on')).toMatch(/pins unchanged$/)
      expect(wiredEnvOf(world)).toEqual({
        ANTHROPIC_BASE_URL: GATEWAY,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
        ENABLE_TOOL_SEARCH: 'true',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
        ANTHROPIC_DEFAULT_FABLE_MODEL: undefined,
      })
    })
  }

  test('off stays off through gateway recovery and the bridge pointer', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.pointerPid = PID
    await startSession($)
    await gateway($, 'on')

    expect(await gateway($, 'off')).toBe('requests now go to api.anthropic.com')
    await clock.advance(10_000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^off/)
  })
})

describe('/gateway rc', () => {
  test('pauses the gateway, rebuilds the command list, runs /remote-control, then wires again', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    expect(wiredEnvOf(world)).toEqual(WIRED)

    expect(await gateway($, 'rc')).toBe('opening /remote-control with the gateway paused')
    await clock.settle()

    expect(world.commands).toEqual([
      { command: 'reload-plugins', baseUrl: undefined },
      { command: 'remote-control', baseUrl: undefined },
    ])
    expect(wiredEnvOf(world), 'wired again once the dialog closed').toEqual(WIRED)
    expect(await gateway($, 'status')).toMatch(/^on:/)
  })

  test('holds the watchdog while the dialog is open', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    let close = () => {}
    world.duringRc = () =>
      new Promise<void>((resolve) => {
        close = resolve
      })

    await gateway($, 'rc')
    await clock.settle()
    expect(await gateway($, 'status')).toMatch(/^paused for \/remote-control/)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'unwired while the dialog is open').toBeUndefined()

    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the watchdog does not rewire during the dialog').toBeUndefined()
    expect(world.toasts.some((t) => t.includes('answers again'))).toBe(false)

    close()
    await clock.settle()
    expect(wiredEnvOf(world)).toEqual(WIRED)
    expect(await gateway($, 'status')).toMatch(/^on:/)
  })

  test('stays unwired when the person turns the gateway off during the dialog', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    world.duringRc = async () => {
      await gateway($, 'off')
    }

    await gateway($, 'rc')
    await clock.settle()

    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^off/)
  })

  test('says so and wires again when Remote Control stays unavailable', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.isRcListed = false
    await startSession($)
    await gateway($, 'on')

    await gateway($, 'rc')
    await clock.settle()

    expect(world.commands.map((c) => c.command)).toEqual(['reload-plugins'])
    expect(world.toasts.some((t) => t.includes('/remote-control is still unavailable'))).toBe(true)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBe(GATEWAY)
  })

  test('opens /remote-control without touching the env in an unwired session', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)

    expect(await gateway($, 'rc')).toBe('opening /remote-control')
    await clock.settle()

    expect(world.commands.map((c) => c.command)).toEqual(['reload-plugins', 'remote-control'])
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(world.runs.filter((argv) => argv.includes('ensure')).length).toBe(0)
  })
})

function leadFileOf(mode: string): string {
  return JSON.stringify({ mode, gateway: GATEWAY })
}

describe('teammate following its lead', () => {
  test('wires at session start, before any check, when its lead routes through the gateway', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    await startSession($)

    expect(wiredEnvOf(world), 'wired before the first request, without waiting for a check').toEqual(WIRED)
    expect(await gateway($, 'status')).toMatch(/^on:/)
    expect([...world.files.keys()], 'a teammate writes no lead file of its own').toEqual([`${LEADS}/${LEAD}.json`])
  })

  test('follows its lead onto the gateway and back, and never waits on the bridge pointer', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' })
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('waiting'))
    world.pointerPid = PID
    await startSession($)

    await clock.advance(4000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the lead is not on the gateway').toBeUndefined()
    expect(await gateway($, 'status')).toMatch(new RegExp(`^following the lead session ${LEAD}`))

    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    await clock.advance(2000)
    expect(wiredEnvOf(world)).toEqual(WIRED)
    expect(world.toasts.at(-1)).toMatch(/the lead routes through the gateway; requests now go through/)

    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('off'))
    await clock.advance(2000)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBeUndefined()
    expect(world.env.get('CLAUDE_CODE_MAX_OUTPUT_TOKENS'), 'the teammate gets back what it had').toBe('32000')
    expect(world.toasts.at(-1)).toMatch(/the lead turned the gateway off; requests now go to api\.anthropic\.com/)
    expect(await gateway($, 'status')).toMatch(/^following the lead session/)
  })

  test('leaves a teammate alone when its lead wrote no file', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { ANTHROPIC_BASE_URL: GATEWAY })
    world.psStdout = TEAMMATE_COMMAND
    await startSession($)

    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'wired through the tmux environment, as before').toBe(GATEWAY)
    expect(await gateway($, 'status')).toMatch(/^on:/)
  })

  test('stays off when /gateway off arrives while the lead file is being read', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('waiting'))
    await startSession($)

    let release: () => void = () => {}
    world.leadReadGate = new Promise((resolve) => {
      release = resolve
    })
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    const readsAtStart = world.leadReads
    await clock.advance(2000)
    for (let i = 0; i < 1000 && world.leadReads === readsAtStart; i++) await Promise.resolve()
    expect(world.leadReads, 'the check is inside its read of the lead file').toBe(readsAtStart + 1)
    const off = gateway($, 'off')
    release()
    world.leadReadGate = undefined
    expect(await off).toBe('requests already go to api.anthropic.com')
    await clock.advance(4000)

    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the read began before off, but off was the last word').toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^off/)
  })

  test('stays off when /gateway off arrives while following is checking the gateway', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, JSON.stringify({ mode: 'waiting', gateway: GATEWAY, env: WIRED }))
    await startSession($)

    let release: () => void = () => {}
    world.probeGate = new Promise((resolve) => {
      release = resolve
    })
    world.files.set(`${LEADS}/${LEAD}.json`, JSON.stringify({ mode: 'on', gateway: GATEWAY, env: WIRED }))
    await clock.advance(2000)
    for (let i = 0; i < 1000; i++) await Promise.resolve()
    const off = gateway($, 'off')
    release()
    world.probeGate = undefined
    await off
    await clock.advance(4000)

    expect(world.env.get('ANTHROPIC_BASE_URL'), 'off came after the wiring began, so off stands').toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^off/)
  })

  test('does not follow its lead while /gateway rc is open', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('waiting'))
    await startSession($)
    let close = () => {}
    world.duringRc = () =>
      new Promise<void>((resolve) => {
        close = resolve
      })

    await gateway($, 'rc')
    await clock.settle()
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the lead switched on while the dialog was open').toBeUndefined()

    close()
    await clock.settle()
    await clock.advance(2000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'followed once the dialog closed').toBe(GATEWAY)
  })

  test('keeps a teammate wired through the tmux environment while its lead still waits', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on, { ANTHROPIC_BASE_URL: GATEWAY })
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('waiting'))
    await startSession($)

    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the lead turned nothing off').toBe(GATEWAY)
    expect(await gateway($, 'status')).toMatch(/^on:/)
  })

  test('stops following once the teammate is told /gateway off', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    await startSession($)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBe(GATEWAY)

    expect(await gateway($, 'off')).toBe('requests now go to api.anthropic.com')
    await clock.advance(6000)
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the lead is still on, but the person said off here').toBeUndefined()
    expect(await gateway($, 'status')).toMatch(/^off/)
  })

  test('a lead writes its mode for its teammates on start, on and off', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.psStdout = `/Users/me/.local/bin/claude --parent-session-id ${LEAD}\n`
    const own = `${LEADS}/${SESSION}.json`
    await startSession($)
    expect(JSON.parse(world.files.get(own) ?? '{}'), 'no --agent-id: a lead, whatever else its command line says').toEqual({ mode: 'waiting', gateway: GATEWAY, pid: PID })

    await gateway($, 'on')
    expect(JSON.parse(world.files.get(own) ?? '{}').mode).toBe('on')

    await gateway($, 'off')
    expect(JSON.parse(world.files.get(own) ?? '{}').mode).toBe('off')
  })
})

describe('teammate first request', () => {
  test('holds each model request until the wiring that session start began is done', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, leadFileOf('on'))
    let release: () => void = () => {}
    world.ensureGate = new Promise((resolve) => {
      release = resolve
    })
    const baseUrlAtRequest: (string | undefined)[] = []
    on('turn.step', async function* ($, e) {
      baseUrlAtRequest.push(world.env.get('ANTHROPIC_BASE_URL'))
      return { turnId: e.turnId, index: e.index, answer: 'pong', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })

    const started = startSession($)
    const step = (async () => {
      const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-gpt-6.1-sol-fast[1m]', messageCount: 1 })
      let read = await stream.next()
      while (read.done !== true) read = await stream.next()
      return read.value
    })()
    for (let i = 0; i < 1000; i++) await Promise.resolve()
    expect(baseUrlAtRequest, 'the request is held while `ensure` runs').toEqual([])

    release()
    await started
    expect((await step).answer).toBe('pong')
    expect(baseUrlAtRequest).toEqual([GATEWAY])
  })

  test('wires from the env block the lead wrote, without starting the gateway CLI', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, JSON.stringify({ mode: 'on', gateway: GATEWAY, env: WIRED }))
    await startSession($)

    expect(wiredEnvOf(world)).toEqual(WIRED)
    expect(world.runs.filter((argv) => argv[0] === 'node'), 'the lead already ran ensure and env').toEqual([])
  })

  test('a lead writes the env block it wired into its file', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')

    expect(JSON.parse(world.files.get(`${LEADS}/${SESSION}.json`) ?? '{}')).toEqual({ mode: 'on', gateway: GATEWAY, env: WIRED, pid: PID })
  })
})

describe('lead identity', () => {
  test('after /clear a lead also writes under its new session id, and keeps the old one current', async ($, on) => {
    const clock = mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')

    world.sessionId = 'session-2'
    await clock.advance(2000)
    expect(JSON.parse(world.files.get(`${LEADS}/session-2.json`) ?? '{}').mode, 'teammates spawned after /clear name the new id').toBe('on')

    await gateway($, 'off')
    expect(JSON.parse(world.files.get(`${LEADS}/${SESSION}.json`) ?? '{}').mode, 'teammates spawned before /clear still follow').toBe('off')
    expect(JSON.parse(world.files.get(`${LEADS}/session-2.json`) ?? '{}').mode).toBe('off')
  })

  test('writes the lead file under the current id before a teammate is spawned', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    await startSession($)
    await gateway($, 'on')
    world.sessionId = 'session-3'

    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'Reply with your model id.',
      description: 'model probe',
      subagentType: 'gpt-sol-ultrafast-executor',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
      isTeammate: true,
      name: 'scout',
    })
    expect(world.filesAtSpawn, 'no check ran since /clear; the spawn itself wrote it').toContain(`${LEADS}/session-3.json`)
  })

  test('after a hot reload a lead keeps the files it wrote under earlier session ids current', async ($, on) => {
    mock.clock(on)
    const world = worldOf(on)
    world.files.set(`${LEADS}/before-clear.json`, JSON.stringify({ mode: 'on', gateway: GATEWAY, env: WIRED, pid: PID }))
    world.files.set(`${LEADS}/someone-else.json`, JSON.stringify({ mode: 'on', gateway: GATEWAY, env: WIRED, pid: 9999 }))
    await startSession($)

    await gateway($, 'off')
    expect(JSON.parse(world.files.get(`${LEADS}/before-clear.json`) ?? '{}').mode, 'this process wrote it before the reload').toBe('off')
    expect(JSON.parse(world.files.get(`${LEADS}/someone-else.json`) ?? '{}').mode, 'another process wrote it').toBe('on')
  })

  test('a teammate back from /gateway rc wires with its lead\'s env block, not the local CLI\'s', async ($, on) => {
    const clock = mock.clock(on)
    const lead = { ...WIRED, ANTHROPIC_BASE_URL: 'http://127.0.0.1:19999' }
    const world = worldOf(on)
    world.psStdout = TEAMMATE_COMMAND
    world.files.set(`${LEADS}/${LEAD}.json`, JSON.stringify({ mode: 'on', gateway: lead.ANTHROPIC_BASE_URL, env: lead }))
    await startSession($)
    expect(world.env.get('ANTHROPIC_BASE_URL')).toBe(lead.ANTHROPIC_BASE_URL)

    await gateway($, 'rc')
    await clock.settle()
    expect(world.env.get('ANTHROPIC_BASE_URL'), 'the local CLI prints the default gateway').toBe(lead.ANTHROPIC_BASE_URL)
  })
})
