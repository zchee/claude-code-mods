import type { SessionMessage } from 'claude-code'

import type { Action } from '../hooks/compact'

/**
 * A message the person typed.
 */
export function said(text: string, handle?: string): SessionMessage {
  return handle === undefined
    ? { role: 'user', text, toolUses: [] }
    : { role: 'user', text, toolUses: [], handle }
}

/**
 * An assistant message making the given calls: `[tool_use_id, tool, input]`.
 */
export function calling(
  text: string,
  uses: readonly (readonly [string, string, Record<string, unknown>])[],
  handle?: string,
): SessionMessage {
  const message: SessionMessage = {
    role: 'assistant',
    text,
    toolUses: uses.map(([id, tool, input]) => ({
      tool_use_id: id,
      tool,
      input,
    })),
  }

  if (handle !== undefined) {
    message.handle = handle
  }

  return message
}

/**
 * A user message answering calls: `[tool_use_id, text, isError?]`.
 */
export function answering(
  results: readonly (readonly [string, string, boolean?])[],
  handle?: string,
): SessionMessage {
  const message: SessionMessage = {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: results.map(([id, text, isError]) => ({
      tool_use_id: id,
      text,
      isError: isError === true,
    })),
  }

  if (handle !== undefined) {
    message.handle = handle
  }

  return message
}

/**
 * Copies every result onto the tool use it answers, as a transcript has it
 * once the call is answered.
 */
export function withOutcomes(messages: SessionMessage[]): SessionMessage[] {
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      for (const other of messages) {
        for (const use of other.toolUses) {
          if (use.tool_use_id === result.tool_use_id) {
            use.text = result.text

            if (result.isError) {
              use.isError = true
            }
          }
        }
      }
    }
  }

  return messages
}

/**
 * One benchmark conversation and the reference it is scored against.
 *
 * Every message is invented for the benchmark: the file names, commands and
 * outputs are plausible, but none comes from a real session.
 */
export type Scenario = {
  id: string
  /** One line for the report. */
  title: string
  messages: SessionMessage[]
  /**
   * Acceptable actions per tool_use_id of every call that is not pinned at
   * preserveRecentMessages = 6.
   *
   * A label lists every action the author accepts. A result of 420
   * characters or fewer (the default head of 300 plus the room of the note
   * that replaces the rest) is left whole by `truncate`, so a call whose
   * label is `keep` alone has a longer result: there a `truncate` loses
   * content and counts as a harmful cut.
   */
  expected: Readonly<Record<string, readonly Exclude<Action, 'pinned'>[]>>
}

/**
 * The `preserveRecentMessages` every scenario is labelled for: the mod's
 * default. A call in the newest six messages, or in the first message, is
 * pinned and has no label.
 */
export const PRESERVE_RECENT = 6

type Label = readonly Exclude<Action, 'pinned'>[]

const KEEP: Label = ['keep']
const CUT: Label = ['drop', 'truncate']

/**
 * A file as the Read tool shows it: each line after its number and a tab.
 */
function numbered(lines: readonly string[], from = 1): string {
  return lines
    .map((line, index) => `${String(from + index).padStart(6)}\t${line}`)
    .join('\n')
}

/**
 * `memory-queue` as `MemoryQueue`.
 */
function pascalOf(name: string): string {
  return name
    .split(/[-_.]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * The lines of one generated function of a module, varied by `n` so that a
 * long file does not repeat one block.
 */
function blockOf(area: string, name: string, n: number): string[] {
  switch (n % 3) {
    case 0:
      return [
        `export function check${name}${n}(job: Job, options: ${name}Options): boolean {`,
        '  const started = Date.now()',
        '',
        '  if (job.attempt > options.maxAttempts) {',
        `    logger.warn('${area}: job %s gave up after %d attempts', job.id, job.attempt)`,
        '    return false',
        '  }',
        '',
        '  return Date.now() - started < options.timeoutMs',
        '}',
      ]
    case 1:
      return [
        `export async function load${name}${n}(store: JobStore, id: string): Promise<Job | undefined> {`,
        '  const row = await store.get(id)',
        '',
        '  if (row === undefined) {',
        `    logger.debug('${area}: no job %s', id)`,
        '    return undefined',
        '  }',
        '',
        `  return { ...row, tags: [...row.tags, '${area}'] }`,
        '}',
      ]
    default:
      return [
        `export const ${name.toUpperCase()}_LIMIT_${n} = ${n * 16}`,
        '',
        `export function describe${name}${n}(job: Job): string {`,
        `  return \`\${job.id} (\${job.kind}, attempt \${job.attempt}) in ${area}\``,
        '}',
      ]
  }
}

/**
 * A source file as the Read tool shows it: the given lines, then generated
 * functions until the text is at least `chars` long.
 */
function sourceOf(
  path: string,
  head: readonly string[],
  chars: number,
): string {
  const area = path.split('/')[1] ?? 'app'
  const name = pascalOf(
    path.split('/').at(-1)?.replace(/\.ts$/, '') ?? 'module',
  )
  const lines = [`// ${path}`, ...head]
  let length = numbered(lines).length

  for (let n = 1; length < chars; n++) {
    const block = ['', ...blockOf(area, name, n)]

    length += numbered(block, lines.length + 1).length + 1
    lines.push(...block)
  }

  return numbered(lines)
}

/**
 * Lines of a JavaScript stack, as a failing Node process prints them.
 */
function framesOf(file: string, count: number): string[] {
  const names = ['resolve', 'load', 'link', 'evaluate', 'import', 'run']

  return Array.from(
    { length: count },
    (_, n) =>
      `    at ${names[n % names.length]}${n} (${file}:${40 + n * 7}:${(n * 5) % 31})`,
  )
}

/**
 * The scenarios' bodies, in builders so a scenario keeps its labels next to
 * the messages they are about.
 */
type Body = Pick<Scenario, 'messages' | 'expected'>

/**
 * A test fixes a parser bug: read, failing test, grep, edit, passing test,
 * full suite, and the person says it is done.
 */
function fixTestOf(): Body {
  const test = 'pnpm vitest run tests/http/headers.test.ts'
  const parser = [
    "import { HeaderError } from './errors'",
    '',
    '/**',
    ' * Splits a header value into its comma-separated items.',
    ' */',
    'export function itemsOf(value: string): string[] {',
    "  return value.split(',').map(item => item.trim()).filter(item => item !== '')",
    '}',
    '',
    'export function quotedOf(item: string): string {',
    "  if (!item.startsWith('\"')) {",
    '    return item',
    '  }',
    '',
    "  if (!item.endsWith('\"')) {",
    '    throw new HeaderError(`unterminated quoted value: ${item}`)',
    '  }',
    '',
    "  return item.slice(1, -1).replace(/\\\\(.)/g, '$1')",
    '}',
  ]
  const failure = [
    ` RUN  v3.2.4 /home/dev/projects/relay`,
    '',
    ' ❯ tests/http/headers.test.ts (12 tests | 1 failed) 41ms',
    '   ✓ itemsOf > splits a plain list',
    '   ✓ itemsOf > drops empty items',
    '   × itemsOf > parses a quoted header value 9ms',
    "     → expected [ '\"a', 'b\"' ] to deeply equal [ '\"a, b\"' ]",
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  tests/http/headers.test.ts > itemsOf > parses a quoted header value',
    "AssertionError: expected [ '\"a', 'b\"' ] to deeply equal [ '\"a, b\"' ]",
    '',
    '- Expected',
    '+ Received',
    '',
    '  [',
    '-   "\\"a, b\\"",',
    '+   "\\"a",',
    '+   "b\\"",',
    '  ]',
    '',
    ' ❯ tests/http/headers.test.ts:58:36',
    '     56|   test("parses a quoted header value", () => {',
    '     57|     const value = \'"a, b", c\'',
    '     58|     expect(itemsOf(value).slice(0, 1)).toEqual([\'"a, b"\'])',
    '       |                                    ^',
    '     59|   })',
    '',
    ...framesOf('node_modules/@vitest/runner/dist/index.js', 40),
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 11 passed (12)',
    '   Start at  10:14:02',
    '   Duration  412ms (transform 88ms, setup 0ms, collect 61ms, tests 41ms)',
  ].join('\n')
  const grep = [
    "src/http/headers.ts:7:  return value.split(',').map(item => item.trim()).filter(item => item !== '')",
    "src/http/cookies.ts:22:  for (const pair of scanPairs(header, ';')) {",
    "src/http/accept.ts:15:  return header.split(',').map(rangeOf)",
    "src/http/link.ts:31:  const parts = value.split(',')",
    "src/url/query.ts:48:      .split(',')",
    "tests/http/accept.test.ts:12:    expect(rangesOf('text/html, */*;q=0.8').map(r => r.type)).toEqual([",
    "tests/http/headers.test.ts:20:    expect(itemsOf('a,,b')).toEqual(['a', 'b'])",
  ].join('\n')
  const edited = numbered(
    [
      '/**',
      ' * Splits a header value into its comma-separated items. A comma inside',
      ' * a quoted string belongs to the item.',
      ' */',
      'export function itemsOf(value: string): string[] {',
      '  const items: string[] = []',
      '  let start = 0',
      '  let isQuoted = false',
      '',
      '  for (let at = 0; at < value.length; at++) {',
      "    if (value[at] === '\\\\' && isQuoted) {",
      '      at++',
      "    } else if (value[at] === '\"') {",
      '      isQuoted = !isQuoted',
      "    } else if (value[at] === ',' && !isQuoted) {",
      '      items.push(value.slice(start, at).trim())',
      '      start = at + 1',
      '    }',
      '  }',
      '',
      '  items.push(value.slice(start).trim())',
      '',
      "  return items.filter(item => item !== '')",
      '}',
    ],
    3,
  )
  const passing = (files: number, tests: number, ms: number) =>
    [
      ' RUN  v3.2.4 /home/dev/projects/relay',
      '',
      ...(files === 1
        ? [
            ' ✓ tests/http/headers.test.ts (12 tests) 38ms',
            '   ✓ itemsOf > splits a plain list',
            '   ✓ itemsOf > drops empty items',
            '   ✓ itemsOf > parses a quoted header value',
            '   ✓ itemsOf > keeps an escaped quote inside a quoted value',
            '   ✓ quotedOf > unquotes a quoted item',
            '   ✓ quotedOf > rejects an unterminated quote',
          ]
        : Array.from(
            { length: files },
            (_, n) =>
              ` ✓ tests/${['http', 'url', 'router', 'cache', 'proxy'][n % 5]}/suite-${n + 1}.test.ts (${8 + (n % 7)} tests) ${12 + n * 3}ms`,
          )),
      '',
      ` Test Files  ${files} passed (${files})`,
      `      Tests  ${tests} passed (${tests})`,
      '   Start at  10:21:47',
      `   Duration  ${ms}ms (transform 102ms, setup 0ms, collect 77ms, tests ${Math.round(ms / 3)}ms)`,
    ].join('\n')

  return {
    messages: withOutcomes([
      said(
        'The test "parses a quoted header value" in tests/http/headers.test.ts ' +
          'has failed since the tokenizer change. Please fix it.',
      ),
      calling('Reading the header parser first.', [
        ['ft1', 'Read', { file_path: 'src/http/headers.ts' }],
      ]),
      answering([['ft1', sourceOf('src/http/headers.ts', parser, 6500)]]),
      calling('Running the failing test to see the actual output.', [
        ['ft2', 'Bash', { command: test }],
      ]),
      answering([['ft2', failure, true]]),
      calling(
        'The quoted value is split at its inner comma. Looking for other ' +
          'places that split header values the same way.',
        [['ft3', 'Grep', { pattern: "split\\(','\\)", path: 'src' }]],
      ),
      answering([['ft3', grep]]),
      calling(
        'itemsOf in src/http/headers.ts splits on every comma, including the ' +
          'ones inside quotes. Replacing the split with a quote-aware scan.',
        [
          [
            'ft4',
            'Edit',
            {
              file_path: 'src/http/headers.ts',
              old_string:
                "  return value.split(',').map(item => item.trim()).filter(item => item !== '')",
              new_string:
                '  const items: string[] = []\n  let start = 0\n  let isQuoted = false\n  ...',
            },
          ],
        ],
      ),
      answering([
        [
          'ft4',
          "The file src/http/headers.ts has been updated. Here's the result of " +
            `running \`cat -n\` on a snippet of the edited file:\n${edited}`,
        ],
      ]),
      calling('Running the test again.', [['ft5', 'Bash', { command: test }]]),
      answering([['ft5', passing(1, 12, 398)]]),
      calling('Running the whole suite to check that nothing else broke.', [
        ['ft6', 'Bash', { command: 'pnpm vitest run' }],
      ]),
      answering([['ft6', passing(40, 214, 3180)]]),
      calling(
        'All 214 tests pass. itemsOf now keeps a comma inside a quoted value ' +
          'as part of the item, and an escaped quote does not end the quoted value.',
        [],
      ),
      said('Done, thanks. Does the cookie parser have the same bug?'),
      calling(
        'No: src/http/cookies.ts splits with its own scanner, which already ' +
          'skips separators inside quotes.',
        [],
      ),
      said(
        'Good. Commit the header fix with a message that names the quoted-comma bug.',
      ),
    ]),
    expected: {
      ft1: CUT,
      ft2: CUT,
      ft3: CUT,
      ft4: KEEP,
      ft5: KEEP,
    },
  }
}

/**
 * What an exploration looks for, and the two files its conclusion names.
 */
const QUESTION =
  'How does the scheduler decide which worker a retried job goes to? I want ' +
  'to understand it before changing anything.'
const DISPATCH = 'src/scheduler/dispatch.ts'
const RETRY_POLICY = 'src/scheduler/retry-policy.ts'

/**
 * The modules an exploration reads besides the two that matter, in the
 * order it reaches them.
 */
const AREAS = [
  'queue',
  'worker',
  'metrics',
  'http',
  'storage',
  'config',
  'log',
  'cli',
  'events',
  'cache',
] as const
const MODULES = [
  'index',
  'types',
  'errors',
  'client',
  'service',
  'codec',
] as const
const ELSEWHERE: readonly string[] = MODULES.flatMap(module =>
  AREAS.map(area => `src/${area}/${module}.ts`),
)

const DISPATCH_HEAD = [
  "import { logger } from '../log/logger'",
  "import type { WorkerRegistry } from '../worker/registry'",
  "import type { Job, WorkerId } from './types'",
  '',
  '/**',
  ' * Picks the worker a job runs on: the live worker with the fewest jobs in',
  ' * flight. A retried job comes through here exactly like a new one.',
  ' */',
  'export function pickWorker(job: Job, registry: WorkerRegistry): WorkerId | undefined {',
  '  let best: WorkerId | undefined',
  '  let fewest = Number.POSITIVE_INFINITY',
  '',
  '  for (const worker of registry.live()) {',
  '    const load = registry.inFlight(worker)',
  '',
  '    if (load < fewest) {',
  '      best = worker',
  '      fewest = load',
  '    }',
  '  }',
  '',
  "  logger.debug('dispatch: job %s attempt %d to %s', job.id, job.attempt, best)",
  '',
  '  return best',
  '}',
  '',
  'export function dispatch(job: Job, registry: WorkerRegistry): boolean {',
  '  const worker = pickWorker(job, registry)',
  '',
  '  if (worker === undefined) {',
  '    return false',
  '  }',
  '',
  '  registry.assign(worker, job)',
  '',
  '  return true',
  '}',
]

const RETRY_POLICY_HEAD = [
  "import type { Job, WorkerId } from './types'",
  '',
  'export type RetryPolicy = {',
  '  maxAttempts: number',
  '  baseDelayMs: number',
  '  maxDelayMs: number',
  '}',
  '',
  'export const DEFAULT_POLICY: RetryPolicy = {',
  '  maxAttempts: 5,',
  '  baseDelayMs: 500,',
  '  maxDelayMs: 60_000,',
  '}',
  '',
  '/**',
  ' * Schedules the next attempt of a failed job, with exponential backoff and',
  ' * full jitter. The job records the worker it failed on in lastWorkerId;',
  ' * nothing reads that field yet, so dispatch may pick the same worker again.',
  ' */',
  'export function nextAttempt(',
  '  job: Job,',
  '  failedOn: WorkerId,',
  '  policy: RetryPolicy = DEFAULT_POLICY,',
  '  now = Date.now(),',
  '): Job | undefined {',
  '  if (job.attempt + 1 >= policy.maxAttempts) {',
  '    return undefined',
  '  }',
  '',
  '  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** job.attempt)',
  '',
  '  return {',
  '    ...job,',
  '    attempt: job.attempt + 1,',
  '    lastWorkerId: failedOn,',
  '    runAt: now + Math.floor(Math.random() * ceiling),',
  '  }',
  '}',
]

/**
 * One call an exploration makes, with its output and whether the
 * conclusion relies on it.
 */
type Probe = {
  tool: string
  input: Record<string, unknown>
  output: string
  isNeeded: boolean
}

function readProbe(
  path: string,
  head: readonly string[],
  chars: number,
  isNeeded = false,
): Probe {
  return {
    tool: 'Read',
    input: { file_path: path },
    output: sourceOf(path, head, chars),
    isNeeded,
  }
}

function grepProbe(
  pattern: string,
  path: string,
  files: readonly string[],
  chars: number,
): Probe {
  const lines: string[] = []

  for (let n = 0; lines.join('\n').length < chars; n++) {
    const file = files[n % files.length] ?? path

    lines.push(
      `${file}:${12 + n * 9}:  if (job.attempt > options.maxAttempts) { // ${pattern}`,
    )
  }

  return {
    tool: 'Grep',
    input: { pattern, path },
    output: lines.join('\n'),
    isNeeded: false,
  }
}

/**
 * The calls of an exploration before its conclusion: a listing, the
 * scheduler's entry point, a search, `probes - 6` other modules (every
 * fourth a search of that module's folder), the two files that answer the
 * question, and the history of the scheduler.
 */
function probesOf(probes: number, chars: number): Probe[] {
  const others = ELSEWHERE.slice(0, probes - 6)
  const list: Probe[] = [
    {
      tool: 'Glob',
      input: { pattern: 'src/**/*.ts' },
      output: [
        'src/scheduler/index.ts',
        DISPATCH,
        RETRY_POLICY,
        'src/scheduler/types.ts',
        ...ELSEWHERE,
      ].join('\n'),
      isNeeded: false,
    },
    readProbe(
      'src/scheduler/index.ts',
      [
        "export { dispatch, pickWorker } from './dispatch'",
        "export { nextAttempt, DEFAULT_POLICY } from './retry-policy'",
        "export type { Job, WorkerId } from './types'",
        "import { logger } from '../log/logger'",
      ],
      chars,
    ),
    grepProbe(
      'retry',
      'src',
      [RETRY_POLICY, DISPATCH, 'src/queue/service.ts', 'src/worker/client.ts'],
      chars / 3,
    ),
    ...others.map((path, n) =>
      n % 4 === 3
        ? grepProbe(
            'attempt',
            path.slice(0, path.lastIndexOf('/')),
            [path],
            chars / 2,
          )
        : readProbe(
            path,
            [
              "import { logger } from '../log/logger'",
              "import type { Job } from '../scheduler/types'",
            ],
            chars,
          ),
    ),
    {
      tool: 'Bash',
      input: { command: 'git log --oneline -n 40 -- src/scheduler' },
      output: Array.from(
        { length: 40 },
        (_, n) =>
          `${(0x3f1a2c0 + n * 0x1d3b7).toString(16)} scheduler: ${['tune backoff ceiling', 'log the chosen worker', 'count in-flight jobs per worker', 'move the policy defaults out of dispatch', 'keep the failed worker on the job'][n % 5]} (#${812 - n})`,
      ).join('\n'),
      isNeeded: false,
    },
  ]

  list.splice(
    Math.floor(list.length * 0.3),
    0,
    readProbe(DISPATCH, DISPATCH_HEAD, chars * 1.2, true),
  )
  list.splice(
    Math.floor(list.length * 0.65),
    0,
    readProbe(RETRY_POLICY, RETRY_POLICY_HEAD, chars * 1.2, true),
  )

  return list
}

/**
 * An exploration: `probes` calls of reading and searching, an assistant
 * conclusion that names the two files that answer the question, a new
 * request, and the first four calls made for it, which fall in the pinned
 * tail. Every result the conclusion does not rely on is `drop` or
 * `truncate`; the reads of the two named files are `keep`.
 */
function explorationOf(prefix: string, probes: number, chars: number): Body {
  const idOf = (n: number) => `${prefix}${String(n).padStart(2, '0')}`
  const messages: SessionMessage[] = [said(QUESTION)]
  const expected: Record<string, Label> = {}
  const notes = [
    'Listing the source tree.',
    'Reading the scheduler entry point.',
    'Searching for retry handling.',
  ]

  probesOf(probes, chars).forEach((probe, n) => {
    const id = idOf(n + 1)

    messages.push(
      calling(notes[n] ?? (n % 5 === 0 ? 'Checking the next module.' : ''), [
        [id, probe.tool, probe.input],
      ]),
      answering([[id, probe.output]]),
    )
    expected[id] = probe.isNeeded ? KEEP : CUT
  })

  messages.push(
    ...closingOf(
      `The worker for a retried job is chosen in \`${DISPATCH}\`: pickWorker takes ` +
        'the live worker with the fewest jobs in flight and treats a retry like a ' +
        `new job. The retry itself is scheduled in \`${RETRY_POLICY}\`: nextAttempt ` +
        'sets the backoff and records the failed worker in lastWorkerId, which ' +
        'nothing reads. Nothing else takes part: the queue backends only store ' +
        'jobs, the worker pool only reports its load, and metrics, HTTP, storage ' +
        'and config are not involved.',
      n => idOf(probes + n),
      chars,
    ),
  )

  return { messages: withOutcomes(messages), expected }
}

/**
 * How an exploration ends: its conclusion, a new request, and the first
 * four calls made for that request, which fill the pinned tail of six
 * messages. None of the four reads a file the conclusion names.
 *
 * @param conclusion the assistant's answer, naming its files in backticks
 * @param tail the tool_use_id of the n-th call of the tail, from 1
 * @param chars about how long the read of the dispatch tests is, doubled
 */
function closingOf(
  conclusion: string,
  tail: (n: number) => string,
  chars: number,
): SessionMessage[] {
  return [
    calling(conclusion, []),
    said(
      'Change it so a retried job never goes back to the worker it failed on, ' +
        'unless that worker is the only one alive. Add a test for both cases.',
    ),
    calling(
      'Reading the dispatch tests and the places that set lastWorkerId.',
      [
        [tail(1), 'Read', { file_path: 'tests/scheduler/dispatch.test.ts' }],
        [tail(2), 'Grep', { pattern: 'lastWorkerId', path: 'src' }],
      ],
    ),
    answering([
      [
        tail(1),
        sourceOf(
          'tests/scheduler/dispatch.test.ts',
          [
            "import { describe, expect, test } from 'vitest'",
            "import { pickWorker } from '../../src/scheduler/dispatch'",
            "import { registryOf } from './fixtures'",
          ],
          chars / 2,
        ),
      ],
      [
        tail(2),
        `${RETRY_POLICY}:34:    lastWorkerId: failedOn,\nsrc/scheduler/types.ts:9:  lastWorkerId?: WorkerId`,
      ],
    ]),
    calling('', [[tail(3), 'Read', { file_path: 'src/scheduler/types.ts' }]]),
    answering([
      [
        tail(3),
        sourceOf(
          'src/scheduler/types.ts',
          [
            "export type WorkerId = string & { readonly brand: 'WorkerId' }",
            '',
            'export type Job = {',
            '  id: string',
            '  kind: string',
            '  attempt: number',
            '  runAt: number',
            '  lastWorkerId?: WorkerId',
            '  tags: string[]',
            '}',
          ],
          600,
        ),
      ],
    ]),
    calling('Running the scheduler tests before changing them.', [
      [tail(4), 'Bash', { command: 'pnpm vitest run tests/scheduler' }],
    ]),
    answering([
      [
        tail(4),
        ' RUN  v3.2.4 /home/dev/projects/relay\n\n ✓ tests/scheduler/dispatch.test.ts (9 tests) 22ms\n' +
          ' ✓ tests/scheduler/retry-policy.test.ts (7 tests) 14ms\n\n Test Files  2 passed (2)\n' +
          '      Tests  16 passed (16)\n   Duration  301ms',
      ],
    ]),
  ]
}

/**
 * A build fails twice with two different errors, then passes.
 */
function retryOf(): Body {
  const build = 'pnpm --filter @acme/docs build'
  const header = [
    '',
    '> @acme/docs@3.8.0 build /home/dev/projects/site/docs',
    '> astro build',
    '',
  ]
  const missing = [
    ...header,
    '10:02:11 [build] output: "static"',
    '10:02:11 [build] directory: /home/dev/projects/site/docs/dist/',
    '10:02:11 [build] Collecting build info...',
    "[ERROR] Cannot find module '/home/dev/projects/site/packages/docs-theme/dist/index.js' imported from /home/dev/projects/site/docs/astro.config.mjs",
    '  Did you mean to build the workspace package @acme/docs-theme first? Its package.json',
    '  points "exports" at dist/, and dist/ does not exist.',
    '',
    '  Stack trace:',
    ...framesOf('node:internal/modules/esm/resolve', 45),
    ...framesOf('node_modules/astro/dist/core/config/vite-load.js', 45),
    '',
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find module imported from astro.config.mjs',
    ' ELIFECYCLE  Command failed with exit code 1.',
  ].join('\n')
  const theme = [
    '',
    '> @acme/docs-theme@1.4.2 build /home/dev/projects/site/packages/docs-theme',
    '> tsup src/index.ts --format esm --dts',
    '',
    'CLI Building entry: src/index.ts',
    'CLI Using tsconfig: tsconfig.json',
    'CLI tsup v8.3.5',
    'CLI Target: es2022',
    'ESM Build start',
    ...Array.from(
      { length: 18 },
      (_, n) =>
        `ESM dist/components/${['Header', 'Footer', 'Sidebar', 'Search', 'Callout', 'Tabs'][n % 6]}${n}.js ${(1.2 + n * 0.37).toFixed(2)} KB`,
    ),
    'ESM ⚡️ Build success in 412ms',
    'DTS Build start',
    'DTS ⚡️ Build success in 1893ms',
    'DTS dist/index.d.ts 6.81 KB',
  ].join('\n')
  const unresolved = [
    ...header,
    '10:06:40 [build] output: "static"',
    '10:06:40 [build] Collecting build info...',
    '10:06:41 [build] ✓ Completed in 498ms.',
    '10:06:41 [build] Building static entrypoints...',
    '[vite]: Rollup failed to resolve import "shiki/langs/hcl.mjs" from "/home/dev/projects/site/docs/src/components/Code.astro".',
    'This is most likely unintended because it can break your application at runtime.',
    'If you do want to externalize this module explicitly add it to',
    '`build.rollupOptions.external`',
    '',
    '  Location:',
    '    /home/dev/projects/site/docs/src/components/Code.astro:4:23',
    '  Stack trace:',
    ...framesOf('node_modules/vite/dist/node/chunks/dep-build.js', 50),
    ...framesOf('node_modules/rollup/dist/es/shared/node-entry.js', 45),
    ' ELIFECYCLE  Command failed with exit code 1.',
  ].join('\n')
  const usages = [
    'docs/src/components/Code.astro',
    '3-import { codeToHtml } from "shiki"',
    '4:import hcl from "shiki/langs/hcl.mjs"',
    '5-import typescript from "shiki/langs/typescript.mjs"',
    '--',
    '18-const langs = [typescript, hcl, bash, json]',
    '',
    'docs/src/content/guides/deploy.mdx',
    '41-```hcl',
    '42:resource "relay_queue" "jobs" {',
    '',
    'node_modules/.pnpm/shiki@3.0.1/node_modules/shiki/CHANGELOG.md',
    '12:- Removed the `hcl` alias module; import `terraform` instead, which highlights HCL.',
  ].join('\n')
  const edited = numbered(
    [
      'import { codeToHtml } from "shiki"',
      'import terraform from "shiki/langs/terraform.mjs"',
      'import typescript from "shiki/langs/typescript.mjs"',
      'import bash from "shiki/langs/bash.mjs"',
      'import json from "shiki/langs/json.mjs"',
      '',
      'interface Props {',
      '  code: string',
      '  lang: string',
      '}',
      '',
      'const { code, lang } = Astro.props',
      'const langs = [typescript, terraform, bash, json]',
      'const html = await codeToHtml(code, { lang: lang === "hcl" ? "terraform" : lang, langs, theme: "github-dark" })',
    ],
    3,
  )
  const built = [
    ...header,
    '10:11:03 [build] output: "static"',
    '10:11:03 [build] Collecting build info...',
    '10:11:04 [build] ✓ Completed in 512ms.',
    '10:11:04 [build] Building static entrypoints...',
    '10:11:19 [vite] ✓ built in 14.82s',
    '10:11:19 [build] ✓ Completed in 15.11s.',
    '',
    ' generating static routes ',
    ...Array.from(
      { length: 40 },
      (_, n) =>
        `10:11:${String(20 + Math.floor(n / 4)).padStart(2, '0')}   ├─ /guides/${['deploy', 'queues', 'workers', 'retries', 'metrics'][n % 5]}-${n}/index.html (+${3 + (n % 9)}ms)`,
    ),
    '10:11:41 ✓ Completed in 21.40s.',
    '',
    '10:11:41 [build] 214 page(s) built in 38.12s',
    '10:11:41 [build] Complete!',
  ].join('\n')

  return {
    messages: withOutcomes([
      said(
        'The docs site build fails on CI since this morning. Build it locally and get it passing.',
      ),
      calling('Building the docs site.', [
        ['rt1', 'Bash', { command: build }],
      ]),
      answering([['rt1', missing, true]]),
      calling('The theme package has no build output. Building it first.', [
        ['rt2', 'Bash', { command: 'pnpm --filter @acme/docs-theme build' }],
      ]),
      answering([['rt2', theme]]),
      calling('The theme is built. Building the docs site again.', [
        ['rt3', 'Bash', { command: build }],
      ]),
      answering([['rt3', unresolved, true]]),
      calling(
        'Code.astro imports a Shiki grammar that the upgraded shiki no longer ships. ' +
          'Finding every use of it.',
        [
          [
            'rt4',
            'Grep',
            { pattern: 'langs/hcl|```hcl|hcl` alias', path: '.', '-C': 1 },
          ],
        ],
      ),
      answering([['rt4', usages]]),
      calling(
        'Only docs/src/components/Code.astro imports it. Switching it to the ' +
          'terraform grammar, which highlights HCL, and mapping the hcl fence to it.',
        [
          [
            'rt5',
            'Edit',
            {
              file_path: 'docs/src/components/Code.astro',
              old_string: 'import hcl from "shiki/langs/hcl.mjs"',
              new_string: 'import terraform from "shiki/langs/terraform.mjs"',
            },
          ],
        ],
      ),
      answering([
        [
          'rt5',
          "The file docs/src/components/Code.astro has been updated. Here's the result " +
            `of running \`cat -n\` on a snippet of the edited file:\n${edited}`,
        ],
      ]),
      calling('Building once more.', [['rt6', 'Bash', { command: build }]]),
      answering([['rt6', built]]),
      calling('The build passes with 214 pages. Checking what changed.', [
        ['rt7', 'Bash', { command: 'git status --short' }],
      ]),
      answering([['rt7', ' M docs/src/components/Code.astro']]),
      calling('', [['rt8', 'Bash', { command: 'git diff --stat' }]]),
      answering([
        [
          'rt8',
          ' docs/src/components/Code.astro | 8 ++++----\n 1 file changed, 4 insertions(+), 4 deletions(-)',
        ],
      ]),
      calling(
        'Only Code.astro changed. CI broke because the shiki upgrade removed the ' +
          'hcl grammar module; the theme package only needed building locally, CI ' +
          'builds it already.',
        [],
      ),
      said('Good. Open a PR for it.'),
    ]),
    expected: {
      rt1: CUT,
      rt2: CUT,
      rt3: CUT,
      rt4: CUT,
      rt5: KEEP,
      rt6: KEEP,
    },
  }
}

/**
 * One very long output whose first lines answer the question asked.
 */
function longOutputOf(): Body {
  const importers = Array.from(
    { length: 48 },
    (_, n) =>
      `packages/${['app', 'api', 'jobs', 'admin', 'web', 'cli'][n % 6]}-${String(n + 1).padStart(2, '0')}`,
  )
  const chains = [
    '@acme/lint-config 4.2.0 > cosmiconfig 7.1.0 > yaml 1.10.2',
    'tailwindcss 3.4.17 > postcss-load-config 3.1.4 > yaml 1.10.2',
    'yaml 2.4.1',
    '@acme/lint-config 4.2.0 > eslint-plugin-yml 1.14.0 > yaml-eslint-parser 1.2.3 > yaml 2.4.1',
    'vitest 3.2.4 > vite 6.0.7 > yaml 2.4.1',
  ]
  const paths: string[] = []

  for (let n = 0; paths.join('\n').length < 42_000; n++) {
    const importer = importers[n % importers.length] ?? 'packages/app-01'

    paths.push(
      `${importer} > ${chains[n % chains.length]}  (${n % 3 === 0 ? 'dev' : 'prod'})`,
    )
  }

  const why = [
    'yaml: 2 versions in the tree, 1 of them vulnerable (<2.2.2)',
    '  1.10.2  via @acme/lint-config > cosmiconfig 7.1.0      (24 importers)',
    '  1.10.2  via tailwindcss > postcss-load-config 3.1.4  (16 importers)',
    '  2.4.1   direct in the root, and 3 other paths',
    '',
    'All paths:',
    ...paths,
  ].join('\n')
  const audit = [
    '┌─────────────────────┬────────────────────────────────────────────────────────┐',
    '│ high                │ yaml is vulnerable to prototype pollution via a        │',
    '│                     │ crafted merge key                                      │',
    '├─────────────────────┼────────────────────────────────────────────────────────┤',
    '│ Package             │ yaml                                                   │',
    '├─────────────────────┼────────────────────────────────────────────────────────┤',
    '│ Vulnerable versions │ <2.2.2                                                 │',
    '├─────────────────────┼────────────────────────────────────────────────────────┤',
    '│ Patched versions    │ >=2.2.2                                                │',
    '├─────────────────────┼────────────────────────────────────────────────────────┤',
    '│ Paths               │ 40 paths through 2 direct dependencies                 │',
    '└─────────────────────┴────────────────────────────────────────────────────────┘',
    '1 vulnerabilities found',
    'Severity: 1 high',
  ].join('\n')
  const root = numbered([
    '{',
    '  "name": "relay-monorepo",',
    '  "private": true,',
    '  "packageManager": "pnpm@10.4.1",',
    '  "scripts": {',
    '    "build": "turbo run build",',
    '    "lint": "eslint .",',
    '    "test": "vitest run",',
    '    "audit": "pnpm audit --audit-level high"',
    '  },',
    '  "devDependencies": {',
    '    "@acme/lint-config": "^4.2.0",',
    '    "tailwindcss": "^3.4.17",',
    '    "turbo": "^2.3.3",',
    '    "vitest": "^3.2.4",',
    '    "yaml": "^2.4.1"',
    '  },',
    '  "pnpm": {',
    '    "overrides": {',
    '      "semver@<7.5.2": "^7.5.2"',
    '    }',
    '  }',
    '}',
  ])

  return {
    messages: withOutcomes([
      said(
        "CI's audit step fails on yaml (prototype pollution, fixed in 2.2.2). Which of " +
          'our top-level dependencies still pull in an old yaml? Then pin it with an override.',
      ),
      calling('Checking the advisory first.', [
        ['lo1', 'Bash', { command: 'pnpm audit --audit-level high' }],
      ]),
      answering([['lo1', audit, true]]),
      calling('Listing every path to yaml.', [
        ['lo2', 'Bash', { command: 'node scripts/dep-paths.mjs yaml' }],
      ]),
      answering([['lo2', why]]),
      calling(
        'Two top-level dependencies bring yaml 1.10.2: @acme/lint-config through ' +
          'cosmiconfig 7, and tailwindcss through postcss-load-config 3. Reading the ' +
          'root package.json to add the override.',
        [['lo3', 'Read', { file_path: 'package.json' }]],
      ),
      answering([['lo3', root]]),
      calling('Adding the override next to the existing semver one.', [
        [
          'lo4',
          'Edit',
          {
            file_path: 'package.json',
            old_string: '      "semver@<7.5.2": "^7.5.2"',
            new_string:
              '      "semver@<7.5.2": "^7.5.2",\n      "yaml@<2.2.2": "^2.2.2"',
          },
        ],
      ]),
      answering([
        [
          'lo4',
          "The file package.json has been updated. Here's the result of running `cat -n` " +
            'on a snippet of the edited file:\n' +
            numbered(
              [
                '  "pnpm": {',
                '    "overrides": {',
                '      "semver@<7.5.2": "^7.5.2",',
                '      "yaml@<2.2.2": "^2.2.2"',
                '    }',
                '  }',
              ],
              18,
            ),
        ],
      ]),
      calling(
        'The override is in place. Shall I run pnpm install and the audit again?',
        [],
      ),
      said('Yes, go ahead.'),
    ]),
    expected: {
      lo1: KEEP,
      lo2: CUT,
    },
  }
}

/**
 * A short session in which every judged call feeds the task still open.
 */
function allNeededOf(): Body {
  const grep = [
    'packages/worker/src/config.ts:41:  const retryLimit = numberOf(raw.retryLimit, defaults.retryLimit)',
    'packages/worker/src/config.ts:58:  return { concurrency, retryLimit, timeoutMs }',
    'packages/worker/src/defaults.ts:6:  retryLimit: 5,',
    'packages/worker/src/scheduler.ts:118:      if (job.attempt >= config.retryLimit) {',
    'packages/worker/src/scheduler.ts:120:          `job ${job.id} gave up after ${config.retryLimit} attempts`,',
    'packages/worker/src/types.ts:14:  retryLimit: number',
  ].join('\n')

  return {
    messages: withOutcomes([
      said(
        'Rename the config key retryLimit to maxRetries across the worker package. ' +
          'The old key must keep working, with a deprecation warning.',
      ),
      calling('Finding every use of the key.', [
        [
          'an1',
          'Grep',
          { pattern: 'retryLimit', path: 'packages/worker/src', '-n': true },
        ],
      ]),
      answering([['an1', grep]]),
      calling(
        'Reading the config parser, which is where the old key has to stay accepted.',
        [['an2', 'Read', { file_path: 'packages/worker/src/config.ts' }]],
      ),
      answering([
        [
          'an2',
          sourceOf(
            'packages/worker/src/config.ts',
            [
              "import { defaults } from './defaults'",
              "import type { WorkerConfig } from './types'",
              '',
              'function numberOf(value: unknown, fallback: number): number {',
              "  return typeof value === 'number' && Number.isFinite(value) ? value : fallback",
              '}',
              '',
              'export function parseConfig(raw: Record<string, unknown>): WorkerConfig {',
              '  const concurrency = numberOf(raw.concurrency, defaults.concurrency)',
              '  const retryLimit = numberOf(raw.retryLimit, defaults.retryLimit)',
              '  const timeoutMs = numberOf(raw.timeoutMs, defaults.timeoutMs)',
              '',
              '  return { concurrency, retryLimit, timeoutMs }',
              '}',
            ],
            3500,
          ),
        ],
      ]),
      calling('Reading the retry loop in the scheduler.', [
        [
          'an3',
          'Read',
          {
            file_path: 'packages/worker/src/scheduler.ts',
            offset: 111,
            limit: 60,
          },
        ],
      ]),
      answering([
        [
          'an3',
          numbered(
            [
              '  async runOnce(job: Job): Promise<void> {',
              '    try {',
              '      await this.handler(job)',
              "      this.metrics.count('job.done')",
              '    } catch (error) {',
              "      this.metrics.count('job.failed')",
              '',
              '      if (job.attempt >= config.retryLimit) {',
              '        this.log.warn(',
              '          `job ${job.id} gave up after ${config.retryLimit} attempts`,',
              '        )',
              '        await this.store.markDead(job.id, String(error))',
              '        return',
              '      }',
              '',
              '      const delay = Math.min(60_000, 500 * 2 ** job.attempt)',
              '      await this.store.reschedule(job.id, Date.now() + delay, job.attempt + 1)',
              '    }',
              '  }',
              '',
              '  async drain(): Promise<void> {',
              '    while (this.inFlight.size > 0) {',
              '      await Promise.race(this.inFlight)',
              '    }',
              '  }',
              '',
              '  /**',
              '   * Takes jobs off the queue until stopped, never more than',
              '   * config.concurrency at once. A job that throws is retried by',
              '   * runOnce, so the loop itself only stops on stop().',
              '   */',
              '  async start(): Promise<void> {',
              '    this.isRunning = true',
              '',
              '    while (this.isRunning) {',
              '      if (this.inFlight.size >= config.concurrency) {',
              '        await Promise.race(this.inFlight)',
              '        continue',
              '      }',
              '',
              '      const job = await this.store.claimNext(config.timeoutMs)',
              '',
              '      if (job === undefined) {',
              '        await sleep(this.idleMs)',
              '        continue',
              '      }',
              '',
              '      const running = this.runOnce(job).finally(() => {',
              '        this.inFlight.delete(running)',
              '      })',
              '',
              '      this.inFlight.add(running)',
              '    }',
              '  }',
              '',
              '  async stop(): Promise<void> {',
              '    this.isRunning = false',
              '    await this.drain()',
              "    this.log.info('scheduler stopped with %d jobs drained', this.drained)",
              '  }',
              '}',
            ],
            111,
          ),
        ],
      ]),
      calling('Reading the defaults and the config type.', [
        ['an4', 'Read', { file_path: 'packages/worker/src/defaults.ts' }],
      ]),
      answering([
        [
          'an4',
          numbered([
            "import type { WorkerConfig } from './types'",
            '',
            '/**',
            ' * What a worker runs with when its config file leaves a key out.',
            ' * Every key here is documented in docs/configuration.md.',
            ' */',
            'export const defaults: WorkerConfig = {',
            '  concurrency: 4,',
            '  retryLimit: 5,',
            '  timeoutMs: 30_000,',
            '}',
            '',
            '/** The keys that were renamed, old name first. Read by parseConfig. */',
            'export const RENAMED: readonly (readonly [string, string])[] = []',
          ]),
        ],
      ]),
      calling(
        'retryLimit is read in three places: parseConfig in config.ts (line 41), the ' +
          'default of 5 in defaults.ts, and the give-up check in scheduler.ts (line 118). ' +
          'defaults.ts already has an empty RENAMED list that parseConfig is meant to ' +
          'read, so the old key can be mapped there and warned about in parseConfig.',
        [],
      ),
      said(
        'Sounds right. Check whether the docs mention it too before you start editing.',
      ),
      calling('', [
        ['an5', 'Grep', { pattern: 'retryLimit', path: 'docs', '-n': true }],
      ]),
      answering([
        [
          'an5',
          'docs/configuration.md:27:| `retryLimit` | 5 | How many times a failed job is retried before it is marked dead. |',
        ],
      ]),
      calling(
        'docs/configuration.md lists it in the options table. Starting with config.ts.',
        [],
      ),
      said('Go.'),
    ]),
    expected: {
      an1: KEEP,
      an2: KEEP,
      an3: KEEP,
      an4: KEEP,
    },
  }
}

/**
 * Where the `large` session runs. Its calls name files by absolute path, as
 * the tools write them, which also gives each input the length a real one
 * has.
 */
const ROOT = '/home/dev/projects/relay'

/**
 * What each layer of the codebase is, and why the assistant reads it while
 * looking for the choice of worker.
 */
const LAYERS: Readonly<
  Record<(typeof AREAS)[number], readonly [string, string]>
> = {
  queue: [
    'the storage of pending jobs',
    'the queue backends are where a failed job is put back, and a backend that kept the worker id would be the obvious place for affinity',
  ],
  worker: [
    'the pool of workers and their liveness',
    'the worker pool reports load and liveness, which is what any choice of worker is made from',
  ],
  metrics: [
    'counters and histograms',
    'metrics sometimes carry per-worker failure counts that a scheduler reads back',
  ],
  http: [
    'the admin API',
    'the admin API can requeue a job by hand, and I want to know whether that path goes through the same dispatch',
  ],
  storage: [
    'the persistent job store',
    'the job store persists every field of a job, so it shows whether lastWorkerId survives a restart',
  ],
  config: [
    'the loading of settings',
    'a config flag could switch on worker affinity without any code reading it directly',
  ],
  log: [
    'structured logging',
    'the logger formats job context and shows which fields a job carries',
  ],
  cli: [
    'the command line tools',
    'the CLI has a replay command that re-dispatches dead jobs',
  ],
  events: [
    'the internal event bus',
    'the event bus is how the worker pool tells the scheduler that a job failed',
  ],
  cache: [
    'a short-lived in-memory cache',
    'the cache keeps a map of job ids to workers, which looks like affinity',
  ],
}

const ROLES: Readonly<Record<(typeof MODULES)[number], string>> = {
  index: 'little more than re-exports',
  types: 'type declarations',
  errors: 'error classes and their codes',
  client: 'a thin client over the backend',
  service: 'the long-running loop',
  codec: 'the serialisation of jobs to bytes',
}

/**
 * One call of the `large` exploration before its conclusion.
 */
type Step =
  | { kind: 'overview' }
  | { kind: 'history' }
  | { kind: 'read'; path: string; isNeeded: boolean }
  | { kind: 'grep'; area: (typeof AREAS)[number]; matches: number }

const REASONS = [
  'What I am looking for is the one place that turns a failed job back into a dispatch, and whether anything on that path remembers the worker the attempt failed on.',
  'The question is about retries specifically, so the interesting code is whatever runs between a failure being reported and the job being handed to a worker again.',
  'Worker affinity, if it exists, would show up as a worker id travelling with a requeued job, so I am following every place a job is copied or requeued.',
  'So far the only field that looks related is lastWorkerId on Job, and I want to know who writes it and who reads it before drawing a conclusion.',
  'I am also ruling out indirect routes: a backend that requeues with a hint, a cache that maps jobs to workers, or a config switch that enables affinity.',
  'Since the scheduler folder itself is small, the risk is in other layers quietly influencing the choice, which is why I am going through them one by one.',
]

const ASIDES = [
  'I am keeping a list of each module I rule out, so that the final answer can say why the other layers are not involved rather than only naming the two that are.',
  'The tests under tests/scheduler cover pickWorker only with fresh jobs, which is another hint that retries were never treated as a case of their own.',
  'None of this changes the picture the scheduler index gave: the choice of worker has to be made in the scheduler, and the other layers can only feed it.',
  'The naming in this codebase is consistent, so a function that chooses a worker would almost certainly have worker or pick in its name, and a search would find it.',
  'I have not changed anything yet; this is still reading only, and the files stay as they are until the behaviour is understood.',
  'Each layer has the same six modules (index, types, errors, client, service, codec), which makes it quick to see where a layer keeps its logic.',
  'If a layer did keep a worker id, it would also need a type for it, and the only WorkerId type so far is the branded string in the scheduler types.',
  'A requeue that went around the scheduler would show up as a direct call to registry.assign, and no module read so far makes one.',
  'The failure path is short so far: the worker reports the error on the event bus, the scheduler calls nextAttempt, and the job goes back to the queue with a later runAt.',
  'No worker id appears in any signature read so far.',
  'Still no reader of lastWorkerId anywhere.',
  'The answer keeps narrowing to the scheduler folder.',
]

function moduleOf(path: string): {
  area: (typeof AREAS)[number]
  module: (typeof MODULES)[number]
} {
  const [, area, file] = path.split('/')

  return {
    area: AREAS.find(name => name === area) ?? 'queue',
    module: MODULES.find(name => `${name}.ts` === file) ?? 'index',
  }
}

/**
 * What the assistant says it found in the result of a step.
 */
function foundOf(step: Step, n: number): string {
  switch (step.kind) {
    case 'overview':
      return 'The listing shows about sixty modules under src, grouped by layer: scheduler, queue, worker, metrics, http, storage, config, log, cli, events and cache. The scheduler folder is small: index.ts, dispatch.ts, retry-policy.ts and types.ts, and the index re-exports dispatch, pickWorker, nextAttempt and DEFAULT_POLICY.'
    case 'history':
      return ''
    case 'grep':
      return n % 2 === 0
        ? `The search of src/${step.area} for attempt checks found ${step.matches} matches. Every one of them compares job.attempt with maxAttempts to decide whether to give up; none of them passes a worker id on, so the ${step.area} code does not route retries.`
        : `In src/${step.area} the pattern matched ${step.matches} lines, all of them the same guard clause copied across modules. That guard only stops a job that has run out of attempts; where the next attempt runs is decided somewhere else.`
    case 'read': {
      if (step.path === DISPATCH) {
        return 'dispatch.ts is where the worker is chosen. pickWorker walks registry.live() and takes the worker with the fewest jobs in flight; a retried job comes through exactly like a new one, and nothing there reads lastWorkerId, so a retry can land on the worker it just failed on whenever that worker is the least loaded. This is one of the files the answer rests on.'
      }

      if (step.path === RETRY_POLICY) {
        return 'retry-policy.ts schedules the next attempt: nextAttempt raises attempt, sets runAt with exponential backoff and full jitter, and records the failed worker in lastWorkerId. The comment above it says outright that nothing reads that field yet. Together with dispatch.ts this explains the behaviour.'
      }

      const { area, module } = moduleOf(step.path)
      const name = pascalOf(module)
      const role = ROLES[module]
      const what = LAYERS[area][0]

      return [
        `${step.path} is ${role}, part of ${what}. It exports load${name}1 and check${name}3, which check job.attempt against maxAttempts and return early, but neither takes a worker id or looks at where the job ran before.`,
        `Nothing in ${step.path} decides where a job runs. Its functions (load${name}1, describe${name}2, check${name}3) take a Job and the ${area} options and only decide whether the job is still worth running, which is the give-up rule, not the choice of worker.`,
        `${step.path} turned out to be ${role}. The only scheduler type it touches is Job, and it reads id, kind, attempt and tags; lastWorkerId is not mentioned anywhere in the file.`,
        `I read ${step.path} to the end. It is ${role} for ${what} and calls no dispatch function, so a retry passing through ${area} keeps whatever worker choice the scheduler makes later.`,
      ][n % 4] as string
    }
  }
}

/**
 * What the assistant says it does next, and why.
 */
function nextOf(step: Step): string {
  switch (step.kind) {
    case 'overview':
      return 'First an overview of the repository, the largest source files first, before reading any one module.'
    case 'history':
      return 'Last, the history of src/scheduler, to see whether worker affinity was ever added and then removed, or discussed in a commit message.'
    case 'grep':
      return `Next is a search of src/${step.area} for attempt checks, to see whether any of them hands a worker id along with the job it gives back to the queue.`
    case 'read':
      if (step.path === DISPATCH) {
        return 'Next I am reading src/scheduler/dispatch.ts, since the scheduler index re-exports pickWorker from there and that name is the most likely place for the choice of worker.'
      }

      if (step.path === RETRY_POLICY) {
        return 'Next I am reading src/scheduler/retry-policy.ts, the other module the scheduler index re-exports, because nextAttempt is what runs after a failure.'
      }

      return `Next I am reading ${step.path}, because ${LAYERS[moduleOf(step.path).area][1]}.`
  }
}

/**
 * The length an assistant message of the `large` session is written to,
 * and the most it may reach.
 */
const PROSE_CHARS = 1140
const PROSE_MAX_CHARS = 1200

/**
 * An assistant message of about 1,150 characters, never over 1,200: what
 * the last call showed, what is being looked for, a remark or two, and what
 * comes next.
 */
function proseOf(previous: Step | undefined, step: Step, n: number): string {
  const said = [
    previous === undefined ? '' : foundOf(previous, n),
    REASONS[n % REASONS.length] ?? '',
  ].filter(part => part !== '')
  const next = nextOf(step)
  const textOf = () => [...said, next].join(' ')

  // Each remark is tried once, from a place that moves with n so that
  // neighbouring messages do not repeat each other; one that would take the
  // message past the most it may reach is passed over.
  for (let tried = 0; tried < ASIDES.length; tried++) {
    const aside = ASIDES[(n + tried) % ASIDES.length] ?? ''

    if (textOf().length >= PROSE_CHARS) {
      break
    }

    if (textOf().length + 1 + aside.length <= PROSE_MAX_CHARS) {
      said.push(aside)
    }
  }

  return textOf()
}

/**
 * The call a step makes: its tool and its input.
 */
function useOf(step: Step): readonly [string, Record<string, unknown>] {
  switch (step.kind) {
    case 'overview':
      return [
        'Bash',
        {
          command: `git -C ${ROOT} ls-files 'src/**/*.ts' | xargs wc -l | sort -n | tail -n 40`,
          description: 'Largest sources',
        },
      ]
    case 'history':
      return [
        'Bash',
        {
          command: `git -C ${ROOT} log --oneline -n 40 --format='%h %s' -- src/scheduler`,
          description: 'Show the scheduler history',
        },
      ]
    case 'grep':
      return [
        'Grep',
        {
          pattern: 'attempt\\s*>\\s*\\w+\\.maxAttempts',
          path: `${ROOT}/src/${step.area}`,
          output_mode: 'content',
          '-n': true,
          '-C': 2,
        },
      ]
    case 'read':
      return [
        'Read',
        { file_path: `${ROOT}/${step.path}`, offset: 1, limit: 400 },
      ]
  }
}

/**
 * The output a step's call answered with.
 */
function outputOf(step: Step, chars: number): string {
  switch (step.kind) {
    case 'overview':
      return [...ELSEWHERE, DISPATCH, RETRY_POLICY]
        .map(
          (path, n) => `${String(80 + ((n * 37) % 400)).padStart(5)} ${path}`,
        )
        .join('\n')
    case 'history':
      return Array.from(
        { length: 40 },
        (_, n) =>
          `${(0x3f1a2c0 + n * 0x1d3b7).toString(16)} scheduler: ${['tune backoff ceiling', 'log the chosen worker', 'count in-flight jobs per worker', 'move the policy defaults out of dispatch', 'keep the failed worker on the job'][n % 5]} (#${812 - n})`,
      ).join('\n')
    case 'grep':
      return MODULES.slice(0, step.matches)
        .flatMap((module, n) => {
          const file = `${ROOT}/src/${step.area}/${module}.ts`
          const line = 14 + n * 11

          return [
            `${file}-${line - 2}-export function check${pascalOf(module)}3(job: Job, options: ${pascalOf(module)}Options): boolean {`,
            `${file}-${line - 1}-  const started = Date.now()`,
            `${file}:${line}:  if (job.attempt > options.maxAttempts) {`,
            `${file}-${line + 1}-    logger.warn('${step.area}: job %s gave up after %d attempts', job.id, job.attempt)`,
            `${file}-${line + 2}-    return false`,
            '--',
          ]
        })
        .join('\n')
    case 'read':
      if (step.path === DISPATCH) {
        return sourceOf(DISPATCH, DISPATCH_HEAD, chars * 1.2)
      }

      if (step.path === RETRY_POLICY) {
        return sourceOf(RETRY_POLICY, RETRY_POLICY_HEAD, chars * 1.2)
      }

      return sourceOf(
        step.path,
        [
          "import { logger } from '../log/logger'",
          "import type { Job } from '../scheduler/types'",
        ],
        chars,
      )
  }
}

/**
 * The exploration at 60 calls, written as a long session is: every
 * assistant message says at some length what it found and why it reads the
 * next file, and every input is an absolute path or a full search. That is
 * what makes the state large, since the state carries the messages and the
 * inputs but only the length of each output; it does not fit the smaller
 * state budgets whole. The labels follow the shorter exploration: the reads
 * of the two files the conclusion names are `keep`, every other call is
 * `drop` or `truncate`.
 */
function largeOf(): Body {
  const probes = 56
  const chars = 3300
  const idOf = (n: number) => `lg${String(n).padStart(2, '0')}`
  const others: Step[] = ELSEWHERE.slice(0, probes - 4).map((path, n) =>
    n % 4 === 3
      ? { kind: 'grep', area: moduleOf(path).area, matches: 2 + (n % 5) }
      : { kind: 'read', path, isNeeded: false },
  )
  const steps: Step[] = [{ kind: 'overview' }, ...others, { kind: 'history' }]

  steps.splice(Math.floor(steps.length * 0.3), 0, {
    kind: 'read',
    path: DISPATCH,
    isNeeded: true,
  })
  steps.splice(Math.floor(steps.length * 0.65), 0, {
    kind: 'read',
    path: RETRY_POLICY,
    isNeeded: true,
  })

  const messages: SessionMessage[] = [said(QUESTION)]
  const expected: Record<string, Label> = {}

  steps.forEach((step, n) => {
    const id = idOf(n + 1)
    const [tool, input] = useOf(step)

    messages.push(
      calling(proseOf(steps[n - 1], step, n), [[id, tool, input]]),
      answering([[id, outputOf(step, chars)]]),
    )
    expected[id] = step.kind === 'read' && step.isNeeded ? KEEP : CUT
  })

  messages.push(
    ...closingOf(
      `The worker for a retried job is chosen in \`${ROOT}/${DISPATCH}\`: ` +
        'pickWorker takes the live worker with the fewest jobs in flight and ' +
        'treats a retry exactly like a new job. The retry itself is scheduled in ' +
        `\`${ROOT}/${RETRY_POLICY}\`: nextAttempt sets the backoff and records the ` +
        'failed worker in lastWorkerId, which nothing reads. Nothing else takes ' +
        'part: the queue backends only store jobs, the worker pool only reports ' +
        'its load, the event bus only carries the failure, and metrics, HTTP, ' +
        'storage, config, the CLI and the cache are not involved.',
      n => idOf(probes + n),
      chars,
    ),
  )

  return { messages: withOutcomes(messages), expected }
}

function scenario(id: string, title: string, body: Body): Scenario {
  return { id, title, ...body }
}

export const SCENARIOS: readonly Scenario[] = [
  scenario(
    'fix-test',
    'a failing test is read, fixed and passes',
    fixTestOf(),
  ),
  scenario(
    'exploration',
    '20 reads and searches, then a conclusion naming two files',
    explorationOf('ex', 20, 3000),
  ),
  scenario(
    'retry',
    'a build fails twice with different errors, then passes',
    retryOf(),
  ),
  scenario(
    'long-output',
    'one 40k-character result whose first lines answer the question',
    longOutputOf(),
  ),
  scenario(
    'all-needed',
    'a short session where every call feeds the open task',
    allNeededOf(),
  ),
  scenario(
    'large',
    'the exploration at 60 calls, its reasoning written out at length',
    largeOf(),
  ),
]

/**
 * The scenario with this id, if there is one.
 */
export function scenarioOf(id: string): Scenario | undefined {
  return SCENARIOS.find(scenario => scenario.id === id)
}
