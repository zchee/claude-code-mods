import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_GATEWAY = 'http://127.0.0.1:18764'

/**
 * How often the bridge pointer and the gateway's health are checked.
 */
const TICK_MS = 2000

/**
 * `$.http.fetch` takes no timeout, so a shim that accepts the connection and
 * never answers would hold the check forever without this bound.
 */
const PROBE_TIMEOUT_MS = 3000

/**
 * Consecutive unreachable checks before the session leaves the gateway, and
 * reachable ones before it returns, so that one slow answer does not flap it.
 */
const FAILURES_TO_UNWIRE = 2
const SUCCESSES_TO_REWIRE = 2

/**
 * How often a suspended session asks the gateway's own CLI to start whatever
 * is not running; the supervisor recovers the proxy itself, but a dead
 * supervisor needs `ensure`.
 */
const ENSURE_INTERVAL_MS = 30_000

/**
 * The fixed part of model-gateway's env block, used when `env` prints none.
 */
const STATIC_ENV = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
} as const

/**
 * Every variable model-gateway wires. The pins are absent when the gateway's
 * `env` printed none, and are then left as the session had them.
 */
type GatewayEnv = {
  ANTHROPIC_BASE_URL: string
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: string
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: string
  ENABLE_TOOL_SEARCH: string
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_FABLE_MODEL?: string
}

/**
 * The values the session had before wiring, restored by `unwire`.
 */
type Snapshot = Record<keyof GatewayEnv, string | undefined>

/**
 * `waiting`: Remote Control has not registered yet. `on`: the gateway is
 * wanted, wired or suspended after it stopped answering. `off`: the user
 * turned it off, or the session was already pointed elsewhere.
 */
type Mode = 'waiting' | 'on' | 'off'

const state = {
  mode: 'waiting' as Mode,
  wired: false,
  gateway: DEFAULT_GATEWAY,
  saved: undefined as Snapshot | undefined,
  failures: 0,
  successes: 0,
  lastEnsureMs: 0,
  isDegraded: false,
  isBusy: false,
  projectDir: undefined as string | undefined,
  rcHold: false,
}

let ticker: { cancel: () => void } | undefined

async function cliOf($: EngineInterface): Promise<string> {
  return `${await $.env.get('HOME')}/.claude/model-gateway/model-gateway.js`
}

/**
 * Reads the env block from `model-gateway.js env`, which prints it as the
 * one JSON object whose braces start a line, among lines of advice.
 */
export function envBlockOf(stdout: string): Partial<GatewayEnv> | undefined {
  const match = /^\{\n[\s\S]*?\n\}$/m.exec(stdout)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[0]) as { env?: Record<string, unknown> }
    const env = parsed.env ?? {}
    const block: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') block[key] = value
    }
    return block as Partial<GatewayEnv>
  } catch {
    return undefined
  }
}

async function gatewayEnvOf($: EngineInterface): Promise<GatewayEnv> {
  const run = await $.process.run(['node', await cliOf($), 'env'], { timeoutMs: 30_000 })
  const block = run.exitCode === 0 ? envBlockOf(run.stdout) : undefined
  if (block === undefined) $.ui.log('gateway: `model-gateway.js env` printed no env block; using the fixed values without pins', { to: 'debug' })
  return {
    ...STATIC_ENV,
    ...block,
    ANTHROPIC_BASE_URL: block?.ANTHROPIC_BASE_URL ?? DEFAULT_GATEWAY,
  }
}

/**
 * Asks the shim's health endpoint. `reachable` is whether anything answered
 * in time; `ok` is the gateway's own verdict, false when only the proxy
 * behind it is down, which still lets Claude models through.
 */
async function probe($: EngineInterface, gateway: string): Promise<{ reachable: boolean; ok: boolean }> {
  const answer = $.http.fetch(`${gateway}/healthz`).then(
    (response) => {
      try {
        return { reachable: true, ok: response.ok && (JSON.parse(response.text) as { ok?: unknown }).ok === true }
      } catch {
        return { reachable: true, ok: false }
      }
    },
    () => ({ reachable: false, ok: false }),
  )
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => ({ reachable: false, ok: false }))
  return Promise.race([answer, timeout])
}

async function ensureGateway($: EngineInterface): Promise<void> {
  state.lastEnsureMs = await $.clock.now()
  await $.process.run(['node', await cliOf($), 'ensure', '--quiet'], { timeoutMs: 60_000 })
}

async function snapshotOf($: EngineInterface): Promise<Snapshot> {
  return {
    ANTHROPIC_BASE_URL: await $.env.get('ANTHROPIC_BASE_URL'),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: await $.env.get('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'),
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: await $.env.get('CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'),
    ENABLE_TOOL_SEARCH: await $.env.get('ENABLE_TOOL_SEARCH'),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: await $.env.get('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    ANTHROPIC_DEFAULT_FABLE_MODEL: await $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL'),
  }
}

/**
 * Sets every variable of `env`. The base URL goes last so that no request
 * reaches the gateway before its pins and switches are in place.
 */
async function applyEnv($: EngineInterface, env: GatewayEnv | Snapshot): Promise<void> {
  await $.env.set('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)
  await $.env.set('CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK)
  await $.env.set('ENABLE_TOOL_SEARCH', env.ENABLE_TOOL_SEARCH)
  await $.env.set('CLAUDE_CODE_MAX_OUTPUT_TOKENS', env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  if ('ANTHROPIC_DEFAULT_OPUS_MODEL' in env) await $.env.set('ANTHROPIC_DEFAULT_OPUS_MODEL', env.ANTHROPIC_DEFAULT_OPUS_MODEL)
  if ('ANTHROPIC_DEFAULT_SONNET_MODEL' in env) await $.env.set('ANTHROPIC_DEFAULT_SONNET_MODEL', env.ANTHROPIC_DEFAULT_SONNET_MODEL)
  if ('ANTHROPIC_DEFAULT_FABLE_MODEL' in env) await $.env.set('ANTHROPIC_DEFAULT_FABLE_MODEL', env.ANTHROPIC_DEFAULT_FABLE_MODEL)
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL)
}


/**
 * Points the session at the gateway once its shim answers; leaves the
 * session as it was and says why when it does not.
 */
async function wire($: EngineInterface): Promise<string> {
  if (state.wired) return `requests already go through ${state.gateway}`
  await ensureGateway($)
  const env = await gatewayEnvOf($)
  const health = await probe($, env.ANTHROPIC_BASE_URL)
  if (!health.reachable) return `the gateway at ${env.ANTHROPIC_BASE_URL} is not answering; requests stay on api.anthropic.com`
  state.saved ??= await snapshotOf($)
  await applyEnv($, env)
  state.gateway = env.ANTHROPIC_BASE_URL
  state.wired = true
  state.failures = 0
  state.successes = 0
  state.isDegraded = !health.ok
  const pins = [env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_FABLE_MODEL].filter(Boolean)
  const note = health.ok ? '' : ' (the gateway reports a problem behind it; gateway models may fail)'
  return `requests now go through ${state.gateway}, pins ${pins.length > 0 ? pins.join(', ') : 'unchanged'}${note}`
}

/**
 * Restores what the session had before wiring. Without a snapshot (the
 * module reloaded while wired) only the base URL is cleared.
 */
async function unwire($: EngineInterface): Promise<string> {
  if (!state.wired) return 'requests already go to api.anthropic.com'
  if (state.saved === undefined) await $.env.set('ANTHROPIC_BASE_URL', undefined)
  else await applyEnv($, state.saved)
  state.wired = false
  state.saved = undefined
  state.failures = 0
  state.successes = 0
  return 'requests now go to api.anthropic.com'
}

/**
 * Finds the projects folder that holds this session's transcript, which is
 * also where Remote Control keeps its bridge-pointer.json.
 */
async function projectDirOf($: EngineInterface): Promise<string | undefined> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const projects = `${configDir}/projects`
  const id = await $.session.id()
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${projects}/${entry.name}/${id}.jsonl`))) {
      return `${projects}/${entry.name}`
    }
  }
  return undefined
}

/**
 * True once this process registered a Remote Control environment: the bridge
 * writes bridge-pointer.json after registration, naming the pid that owns it,
 * and the pid is the file name of this session's messaging socket.
 */
async function isBridgeRegistered($: EngineInterface, projectDir: string): Promise<boolean> {
  const socket = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
  const pid = socket?.match(/\/(\d+)\.sock$/)?.[1]
  if (pid === undefined) return false
  const text = await $.fs.read(`${projectDir}/bridge-pointer.json`).catch(() => undefined)
  if (text === undefined) return false
  try {
    return (JSON.parse(text) as { pid?: unknown }).pid === Number(pid)
  } catch {
    return false
  }
}

/**
 * One check: start the gateway once Remote Control registers, leave it after
 * FAILURES_TO_UNWIRE unreachable probes, return after SUCCESSES_TO_REWIRE
 * reachable ones. Nothing moves while `/gateway rc` holds the gateway back.
 */
async function tick($: EngineInterface): Promise<void> {
  if (state.mode === 'off' || state.rcHold) return
  if (state.mode === 'waiting') {
    if (state.projectDir === undefined || !(await isBridgeRegistered($, state.projectDir))) return
    state.mode = 'on'
    $.ui.toast(`gateway: Remote Control registered; ${await wire($)}`)
    return
  }
  const health = await probe($, state.gateway)
  if (state.wired) {
    if (health.reachable) {
      state.failures = 0
      if (!health.ok && !state.isDegraded) $.ui.toast('gateway: the gateway reports a problem behind it; gateway models may fail')
      state.isDegraded = !health.ok
      return
    }
    state.failures += 1
    if (state.failures < FAILURES_TO_UNWIRE) return
    $.ui.toast(`gateway: ${state.gateway} stopped answering; ${await unwire($)}`)
    return
  }
  if (!health.reachable) {
    state.successes = 0
    if ((await $.clock.now()) - state.lastEnsureMs >= ENSURE_INTERVAL_MS) await ensureGateway($)
    return
  }
  state.successes += 1
  if (state.successes < SUCCESSES_TO_REWIRE) return
  $.ui.toast(`gateway: the gateway answers again; ${await wire($)}`)
}

/**
 * Opens Claude Code's own Remote Control dialog from a wired session.
 *
 * `/remote-control` is enabled only while `ANTHROPIC_BASE_URL` points at
 * api.anthropic.com, and the command list is rebuilt only when plugins
 * reload, so a session wired after it was built keeps a stale entry that
 * `Unknown command` answers. The gateway is unwired, the list rebuilt with
 * `/reload-plugins`, the dialog run, and the gateway wired again once the
 * dialog closes, unless the person turned it off meanwhile.
 */
async function remoteControlThroughFirstParty($: EngineInterface): Promise<void> {
  const wasWired = state.wired
  state.rcHold = true
  try {
    if (wasWired) await unwire($)
    await $.command.run({ command: 'reload-plugins' })
    const listed = (await $.command.list()).some((command) => command.name === 'remote-control')
    if (!listed) {
      $.ui.toast('gateway: /remote-control is still unavailable; see `claude --debug` for why Remote Control is disabled')
      return
    }
    await $.command.run({ command: 'remote-control' })
  } catch (error: unknown) {
    $.ui.toast(`gateway: /remote-control failed: ${String(error)}`)
  } finally {
    state.rcHold = false
    if (wasWired && state.mode === 'on') $.ui.toast(`gateway: ${await wire($)}`)
  }
}

function statusOf(): string {
  if (state.mode === 'off') return 'off: requests go to api.anthropic.com until `/gateway on`'
  if (state.mode === 'waiting') return 'waiting for Remote Control to register; `/gateway on` switches now'
  if (state.rcHold) return 'paused for /remote-control; the gateway returns when the dialog closes'
  if (state.wired) return `on: requests go through ${state.gateway}${state.isDegraded ? ' (degraded)' : ''}`
  return `suspended: ${state.gateway} is not answering; requests go to api.anthropic.com until it does`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gateway',
      description: 'Routes requests through the local model gateway; `rc` opens Remote Control from a wired session.',
      argumentHint: 'on|off|rc|status',
      immediate: true,
    })
    const current = await $.env.get('ANTHROPIC_BASE_URL')
    if (current !== undefined && current === (await gatewayUrlOf($))) {
      state.mode = 'on'
      state.wired = true
      state.gateway = current
    } else if (current !== undefined) {
      state.mode = 'off'
      $.ui.log(`gateway: ANTHROPIC_BASE_URL is already ${current}; this session is left alone`, { to: 'debug' })
    }
    state.projectDir = await projectDirOf($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      if (state.isBusy) return
      state.isBusy = true
      tick($)
        .catch((error: unknown) => $.ui.log(`gateway: check failed: ${String(error)}`, { to: 'debug' }))
        .finally(() => {
          state.isBusy = false
        })
    })
    return next(e)
  })

  on('command.run', { command: 'gateway' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      state.mode = 'off'
      return { text: await unwire($) }
    }
    if (arg === 'on') {
      state.mode = 'on'
      return { text: await wire($) }
    }
    if (arg === 'rc') {
      if (state.rcHold) return { text: '/remote-control is already open' }
      $.clock.after(0, () => {
        void remoteControlThroughFirstParty($)
      })
      return { text: state.wired ? 'opening /remote-control with the gateway paused' : 'opening /remote-control' }
    }
    return { text: statusOf() }
  })
}

/**
 * The gateway URL model-gateway would wire, read without starting anything,
 * so that a session already wired through settings is recognized as such.
 */
async function gatewayUrlOf($: EngineInterface): Promise<string> {
  const run = await $.process.run(['node', await cliOf($), 'env'], { timeoutMs: 30_000 }).catch(() => undefined)
  const block = run !== undefined && run.exitCode === 0 ? envBlockOf(run.stdout) : undefined
  return block?.ANTHROPIC_BASE_URL ?? DEFAULT_GATEWAY
}
