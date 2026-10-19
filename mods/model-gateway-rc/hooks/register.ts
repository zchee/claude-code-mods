import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_GATEWAY = 'http://127.0.0.1:18764'

/** How often the bridge pointer and the gateway's health are checked. */
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
 * The fixed part of model-gateway's env block: always the base layer, which
 * the block `env` prints overrides key by key.
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

/** The values the session had before wiring, restored by `unwire`. */
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
  /** Every session id this lead has had, `/clear` adding one each time. */
  leadIds: [] as string[],
  /** Whether leadIds was read back from the files an earlier load of this module wrote. */
  hasLeadIds: false,
  /**
   * The lead's session id while this session is a teammate that follows it;
   * undefined for a lead, and for a teammate told `/gateway on` or `off`.
   */
  leader: undefined as string | undefined,
  /** The env block the lead last wrote, which a teammate wires with again on recovery. */
  leadEnv: undefined as GatewayEnv | undefined,
  /** The env block the last wiring set, for the lead file. */
  env: undefined as GatewayEnv | undefined,
  /** The lead file text last written, so that an unchanged mode is not rewritten. */
  published: undefined as string | undefined,
  /**
   * The session start's setup, a teammate's wiring included. A teammate's
   * first turn can begin before session.start settles, and turn.start does
   * not hold a turn back, so each model request waits on this at turn.step.
   */
  starting: undefined as Promise<void> | undefined,
}

let ticker: { cancel: () => void } | undefined

let transitions: Promise<unknown> = Promise.resolve()

/**
 * Runs `change` after every change queued before it. A check, a `/gateway`
 * command and a teammate's following each read the state across awaits and
 * then write it, so two at once would leave a `/gateway off` wired.
 */
function serially<T>(change: () => Promise<T>): Promise<T> {
  const run = transitions.then(change, change)
  transitions = run.catch(() => {})
  return run
}


async function cliOf($: EngineInterface): Promise<string> {
  return `${await $.env.get('HOME')}/.claude/model-gateway/model-gateway.js`
}

async function configDirOf($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
}

/** This process's pid, the file name of the session's messaging socket. */
async function pidOf($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET'))?.match(/\/(\d+)\.sock$/)?.[1]
}

/**
 * Where a lead session says whether it routes through the gateway, for the
 * teammates it spawns to follow.
 */
async function leadFileOf($: EngineInterface, sessionId: string): Promise<string> {
  return `${await configDirOf($)}/model-gateway-rc/leads/${sessionId}.json`
}

/**
 * The session id of the lead that spawned this process as a tmux teammate,
 * read from its command line: Claude Code starts a teammate as `claude
 * --agent-id <name@team> ... --parent-session-id <lead's session id>`.
 *
 * A teammate has to wire itself, because Claude Code builds a teammate's
 * `env` prefix with every variable a person's plugin wrote set back to the
 * value it had before the write, so the lead's gateway never reaches it.
 */
async function leaderOf($: EngineInterface): Promise<string | undefined> {
  const pid = await pidOf($)
  if (pid === undefined) return undefined
  const run = await $.process.run(['ps', '-o', 'command=', '-p', pid], { timeoutMs: 5000 }).catch(() => undefined)
  if (run === undefined || run.exitCode !== 0 || !/(?:^|\s)--agent-id[=\s]/.test(run.stdout)) return undefined
  return /(?:^|\s)--parent-session-id[=\s]+([\w-]+)/.exec(run.stdout)?.[1]
}

/**
 * What the lead last wrote: its mode, and the env block it wired, which
 * lets a teammate wire without starting the gateway CLI twice. Undefined
 * when it wrote none.
 */
async function leadOf($: EngineInterface, leader: string): Promise<{ mode: Mode; env?: GatewayEnv } | undefined> {
  const text = await $.fs.read(await leadFileOf($, leader)).catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as { mode?: unknown; env?: unknown }
    const mode = parsed.mode
    if (mode !== 'waiting' && mode !== 'on' && mode !== 'off') return undefined
    const block = stringsOf(parsed.env)
    if (block.ANTHROPIC_BASE_URL === undefined) return { mode }
    return { mode, env: { ...STATIC_ENV, ...block, ANTHROPIC_BASE_URL: block.ANTHROPIC_BASE_URL } }
  } catch {
    return undefined
  }
}

/**
 * Writes this lead's mode for its teammates. `on` covers a suspended gateway
 * and an open `/gateway rc`, which each teammate's own watchdog handles.
 *
 * The session id is read each time: `/clear` gives the process a new one
 * without a session.start, and teammates spawned after it name the new id.
 * Every id the process has had keeps its file, for the teammates spawned
 * under it; the file names the pid, so that a hot reload, which starts this
 * module with fresh state, reads the ids back.
 */
async function publish($: EngineInterface): Promise<void> {
  if (state.leader !== undefined) return
  if (!state.hasLeadIds) {
    state.leadIds = await ownLeadIdsOf($)
    state.hasLeadIds = true
  }
  const id = await $.session.id()
  if (!state.leadIds.includes(id)) {
    state.leadIds.push(id)
    state.published = undefined
  }
  const pid = await pidOf($)
  const text = JSON.stringify({ mode: state.mode, gateway: state.gateway, env: state.env, pid: pid === undefined ? undefined : Number(pid) })
  if (text === state.published) return
  for (const leadId of state.leadIds) await $.fs.write(await leadFileOf($, leadId), text)
  state.published = text
}

/** The session ids whose lead files this process wrote, read from the files. */
async function ownLeadIdsOf($: EngineInterface): Promise<string[]> {
  const pid = await pidOf($)
  if (pid === undefined) return []
  const dir = `${await configDirOf($)}/model-gateway-rc/leads`
  const ids: string[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    try {
      if (text !== undefined && (JSON.parse(text) as { pid?: unknown }).pid === Number(pid)) ids.push(entry.name.slice(0, -'.json'.length))
    } catch {
      continue
    }
  }
  return ids
}

async function publishOrLog($: EngineInterface): Promise<void> {
  await publish($).catch((error: unknown) => $.ui.log(`gateway: could not write the lead file: ${String(error)}`, { to: 'debug' }))
}

/**
 * Reads the env block from `model-gateway.js env`, which prints it as the
 * one JSON object whose braces start a line, among lines of advice.
 */
function envBlockOf(stdout: string): Partial<GatewayEnv> | undefined {
  const match = /^\{\n[\s\S]*?\n\}$/m.exec(stdout)
  if (match === null) return undefined
  try {
    return stringsOf((JSON.parse(match[0]) as { env?: unknown }).env ?? {})
  } catch {
    return undefined
  }
}

/** The string-valued entries of a parsed env object, the rest dropped. */
function stringsOf(env: unknown): Partial<GatewayEnv> {
  const block: Record<string, string> = {}
  if (typeof env !== 'object' || env === null) return block
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') block[key] = value
  }
  return block as Partial<GatewayEnv>
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
 * behind it is down, which still lets Claude models through. The sleep that
 * bounds the wait is aborted once either side wins, so that no host wait
 * outlives the check.
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
  const timer = new AbortController()
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS, { signal: timer.signal }).then(() => ({ reachable: false, ok: false }))
  try {
    return await Promise.race([answer, timeout])
  } finally {
    timer.abort()
    timeout.catch(() => {})
  }
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
 * Sets the variables of `env` in order and stops at the first write Claude
 * Code holds, returning why; a session whose organization manages its
 * settings holds a variable the person could not set there. The base URL
 * goes last so that no request reaches the gateway before its pins and
 * switches are in place, nor at all when one of them is held.
 */
async function applyEnv($: EngineInterface, env: GatewayEnv | Snapshot): Promise<string | undefined> {
  const writes = [
    () => $.env.set('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY),
    () => $.env.set('CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK),
    () => $.env.set('ENABLE_TOOL_SEARCH', env.ENABLE_TOOL_SEARCH),
    () => $.env.set('CLAUDE_CODE_MAX_OUTPUT_TOKENS', env.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
  ]
  if ('ANTHROPIC_DEFAULT_OPUS_MODEL' in env) writes.push(() => $.env.set('ANTHROPIC_DEFAULT_OPUS_MODEL', env.ANTHROPIC_DEFAULT_OPUS_MODEL))
  if ('ANTHROPIC_DEFAULT_SONNET_MODEL' in env) writes.push(() => $.env.set('ANTHROPIC_DEFAULT_SONNET_MODEL', env.ANTHROPIC_DEFAULT_SONNET_MODEL))
  if ('ANTHROPIC_DEFAULT_FABLE_MODEL' in env) writes.push(() => $.env.set('ANTHROPIC_DEFAULT_FABLE_MODEL', env.ANTHROPIC_DEFAULT_FABLE_MODEL))
  writes.push(() => $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL))
  for (const write of writes) {
    const { deny } = await write()
    if (deny !== undefined) return deny
  }
  return undefined
}

/**
 * Points the session at the gateway once its shim answers; leaves the
 * session as it was and says why when it does not. A held write turns the
 * gateway off, since checking again would only meet the same hold.
 *
 * `given` is the env block a lead wired, which a teammate takes in place of
 * asking the gateway CLI: the lead already started the gateway.
 */
async function wire($: EngineInterface, given?: GatewayEnv): Promise<string> {
  if (state.wired) return `requests already go through ${state.gateway}`
  if (given === undefined) await ensureGateway($)
  const env = given ?? (await gatewayEnvOf($))
  const health = await probe($, env.ANTHROPIC_BASE_URL)
  state.gateway = env.ANTHROPIC_BASE_URL
  if (!health.reachable) return `the gateway at ${env.ANTHROPIC_BASE_URL} is not answering; requests stay on api.anthropic.com`
  state.saved ??= await snapshotOf($)
  const held = await applyEnv($, env)
  if (held !== undefined) {
    await applyEnv($, state.saved)
    state.saved = undefined
    state.mode = 'off'
    state.leader = undefined
    return `Claude Code held a gateway variable (${held}); requests stay on api.anthropic.com`
  }
  state.gateway = env.ANTHROPIC_BASE_URL
  state.env = env
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
  const projects = `${await configDirOf($)}/projects`
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
  const pid = await pidOf($)
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
 * Moves a teammate with its lead: on when the lead is on, back to
 * api.anthropic.com when the lead was turned off. A lead still waiting for
 * Remote Control has turned nothing on or off, so a teammate wired some
 * other way (the tmux environment) is left as it is; so is every teammate
 * of a lead that wrote no file (an older version of this mod). Returns
 * whether it moved.
 */
async function follow($: EngineInterface, leader: string): Promise<boolean> {
  const lead = await leadOf($, leader)
  // A `/gateway on` or `off` while the file was read ended the following.
  if (lead === undefined || state.leader !== leader) return false
  state.leadEnv = lead.env
  if (lead.mode === 'on' && state.mode !== 'on') {
    state.mode = 'on'
    $.ui.toast(`gateway: the lead routes through the gateway; ${await wire($, lead.env)}`)
    return true
  }
  if (lead.mode === 'off' && state.mode === 'on') {
    state.mode = 'waiting'
    $.ui.toast(`gateway: the lead turned the gateway off; ${await unwire($)}`)
    return true
  }
  return false
}

/**
 * One check: a teammate follows its lead, and a lead starts the gateway once
 * Remote Control registers; either leaves it after FAILURES_TO_UNWIRE
 * unreachable probes and returns after SUCCESSES_TO_REWIRE reachable ones.
 * Nothing moves while `/gateway rc` holds the gateway back.
 */
async function tick($: EngineInterface): Promise<void> {
  if (state.rcHold) return
  if (state.leader !== undefined) {
    if (await follow($, state.leader)) return
    if (state.mode !== 'on') return
  }
  if (state.mode === 'off') return
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
  $.ui.toast(`gateway: the gateway answers again; ${await wire($, state.leader === undefined ? undefined : state.leadEnv)}`)
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
    if (wasWired) await serially(() => unwire($))
    await $.command.run({ command: 'reload-plugins' })
    const listed = (await $.command.list()).some((command) => command.name === 'remote-control')
    if (!listed) {
      $.ui.toast('gateway: /remote-control is still unavailable; see `claude --debug` for why Remote Control is disabled')
      return
    }
    await $.command.run({ command: 'remote-control' })
  } catch (error) {
    $.ui.toast(`gateway: /remote-control failed: ${String(error)}`)
  } finally {
    await serially(async () => {
      state.rcHold = false
      if (wasWired && state.mode === 'on') $.ui.toast(`gateway: ${await wire($, state.leader === undefined ? undefined : state.leadEnv)}`)
    })
  }
}

function statusOf(): string {
  if (state.mode === 'off') return 'off: requests go to api.anthropic.com until `/gateway on`'
  if (state.mode === 'waiting' && state.leader !== undefined) return `following the lead session ${state.leader}, which has not turned the gateway on; \`/gateway on\` switches this teammate alone`
  if (state.mode === 'waiting') return 'waiting for Remote Control to register; `/gateway on` switches now'
  if (state.rcHold) return 'paused for /remote-control; the gateway returns when the dialog closes'
  if (state.wired) return `on: requests go through ${state.gateway}${state.isDegraded ? ' (degraded)' : ''}`
  return `suspended: ${state.gateway} is not answering; requests go to api.anthropic.com until it does`
}

/**
 * Registers `/gateway`, finds out whether this session is a lead or a
 * teammate, wires a teammate whose lead is on, and starts the check.
 */
async function setUp($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'gateway',
    description: 'Routes requests through the local model gateway; `rc` opens Remote Control from a wired session.',
    argumentHint: 'on|off|rc|status',
    immediate: true,
  })
  state.leader = await leaderOf($)
  const current = await $.env.get('ANTHROPIC_BASE_URL')
  // What model-gateway would wire, read without starting anything, so that
  // a session already wired through settings is recognized as such.
  const env = current === undefined ? undefined : await gatewayEnvOf($).catch(() => undefined)
  if (current !== undefined && current === (env?.ANTHROPIC_BASE_URL ?? DEFAULT_GATEWAY)) {
    state.mode = 'on'
    state.wired = true
    state.gateway = current
    state.env = env
  } else if (current !== undefined) {
    state.mode = 'off'
    state.leader = undefined
    $.ui.log(`gateway: ANTHROPIC_BASE_URL is already ${current}; this session is left alone`, { to: 'debug' })
  }
  const leader = state.leader
  if (leader !== undefined) {
    await serially(() => follow($, leader))
  } else {
    state.projectDir = await projectDirOf($)
    await publishOrLog($)
  }
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => {
    if (state.isBusy) return
    state.isBusy = true
    serially(async () => {
      await tick($)
      await publishOrLog($)
    })
      .catch((error: unknown) => $.ui.log(`gateway: check failed: ${String(error)}`, { to: 'debug' }))
      .finally(() => {
        state.isBusy = false
      })
  })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    state.starting = setUp($)
    await state.starting
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // A teammate reads the lead file as it starts, so it must name this
    // session's current id and mode before the teammate's process exists.
    if (e.isTeammate === true) await serially(() => publishOrLog($))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    await state.starting?.catch(() => {})
    return yield* next(e)
  })

  on('command.run', { command: 'gateway' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      // The intent is recorded at once, so that a change already queued
      // (a teammate's following, a check) sees it and stands down.
      state.leader = undefined
      const text = await serially(async () => {
        state.mode = arg
        const text = arg === 'off' ? await unwire($) : await wire($)
        await publishOrLog($)
        return text
      })
      return { text }
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
