import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { envBlockOf } from '../hooks/register'

const GATEWAY = 'http://127.0.0.1:18764'
const SESSION = 'session-1'
const PID = 4242
const PROJECT = '/home/me/.claude/projects/-work-repo'

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
  }
  on('env.get', async ($, e) => ({ value: world.env.get(e.name) }))
  on('env.set', async ($, e) => {
    if (e.value === undefined) world.env.delete(e.name)
    else world.env.set(e.name, e.value)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    world.runs.push([...e.argv])
    const stdout = e.argv.includes('env') ? ENV_STDOUT : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async () => {
    if (!world.isReachable) return { deny: 'connect ECONNREFUSED 127.0.0.1:18764' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: world.isOk }) } }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('fs.list', async () => ({ value: [{ name: '-work-repo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', async ($, e) => ({ value: e.path === `${PROJECT}/${SESSION}.jsonl` }))
  on('fs.read', async ($, e) => {
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
  return {
    ANTHROPIC_BASE_URL: world.env.get('ANTHROPIC_BASE_URL'),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: world.env.get('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'),
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: world.env.get('CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'),
    ENABLE_TOOL_SEARCH: world.env.get('ENABLE_TOOL_SEARCH'),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: world.env.get('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: world.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: world.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    ANTHROPIC_DEFAULT_FABLE_MODEL: world.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL'),
  }
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

describe('envBlockOf', () => {
  test('reads the env object out of the advice around it', () => {
    expect(envBlockOf(ENV_STDOUT)).toEqual(WIRED)
  })

  test('answers undefined when no JSON object starts a line', () => {
    expect(envBlockOf('the gateway is not installed\n')).toBeUndefined()
  })

  test('answers undefined on malformed JSON', () => {
    expect(envBlockOf('{\n  "env": {\n}\n')).toBeUndefined()
  })
})

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
