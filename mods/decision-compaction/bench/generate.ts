import type { SessionMessage, ToolUseSummary } from 'claude-code'

import type { Action } from '../hooks/compact'
import { pairCalls } from '../hooks/state'
import type { Scenario } from './corpus'
import type { Shape } from './shape'

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
 * The lengths the generator holds a Bash command to, whatever the shape.
 */
const COMMAND_MIN_CHARS = 300
const COMMAND_MAX_CHARS = 3000

/**
 * The shortest result a call the newest prompt depends on is given: well
 * past the 420 characters a `truncate` leaves whole, so its label can be
 * `keep` alone.
 */
const DEPENDED_MIN_CHARS = 900

/**
 * How many calls in a row the newest messages hold: the last two calls, a
 * summary and the newest prompt fill the six pinned messages.
 */
const TAIL_CALLS = 2

/**
 * The z-score of the 90th percentile of a normal distribution.
 */
const Z_AT_P90 = 1.2816

/**
 * Draws from one seed. The same seed gives the same sequence everywhere:
 * the generator reads no clock and no other source of randomness.
 */
type Draw = {
  /** A number in [0, 1). */
  next: () => number
  /** An integer in [low, high]. */
  int: (low: number, high: number) => number
  pick: <T>(list: readonly T[]) => T
  /** A length whose logarithm is uniform between the two. */
  logUniform: (low: number, high: number) => number
  /** A length with this median and this 90th percentile. */
  logNormal: (median: number, p90: number) => number
}

/**
 * mulberry32: a 32-bit state, good enough to vary invented text.
 */
function drawOf(seed: number): Draw {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    pick: list => list[Math.floor(next() * list.length)] as (typeof list)[0],
    logUniform: (low, high) =>
      Math.round(low * (high / low) ** next()),
    logNormal: (median, p90) => {
      const sigma = Math.log(p90 / median) / Z_AT_P90
      const z =
        Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())

      return Math.round(median * Math.exp(sigma * z))
    },
  }
}

function pascalOf(name: string): string {
  return name
    .split(/[-_./]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Lines from `lineOf(0)`, `lineOf(1)`, … until they join to `chars`.
 */
function filled(chars: number, lineOf: (n: number) => string): string[] {
  const lines: string[] = []
  let length = 0

  for (let n = 0; length < chars; n++) {
    const line = lineOf(n)

    lines.push(line)
    length += line.length + 1
  }

  return lines
}

/**
 * Lines as the Read tool shows them: each after its number and a tab.
 */
function numbered(lines: readonly string[], from: number): string {
  return lines
    .map((line, index) => `${String(from + index).padStart(6)}\t${line}`)
    .join('\n')
}

/**
 * What the invented session is about.
 */
type Topic = {
  task: string
  packages: readonly [string, string, string]
  /** What the newest prompt says the change still lacks. */
  caveat: string
}

const TOPICS: readonly Topic[] = [
  {
    task: 'add per-tenant rate limiting to the ingest API',
    packages: ['ingest', 'limiter', 'config'],
    caveat: 'a tenant with no limit configured must not be throttled at all',
  },
  {
    task: 'move the job store from the in-memory map to Postgres',
    packages: ['store', 'queue', 'config'],
    caveat:
      'a job claimed by a worker that died has to come back once its lease runs out',
  },
  {
    task: 'make the router retry an upstream once on a 503 before it fails the request',
    packages: ['router', 'upstream', 'metrics'],
    caveat: 'a POST without an idempotency key must never be retried',
  },
]

const REPOSITORIES = [
  'harbor',
  'tallow',
  'quarry',
  'lumen',
  'parcel',
  'cinder',
  'ferrule',
  'marrow',
] as const

const WORKERS = ['worker-1', 'worker-2', 'reviewer', 'verifier'] as const

/**
 * The invented repository and what the session works on in it.
 */
type World = {
  repository: string
  root: string
  module: string
  topic: Topic
  /** The files the work keeps coming back to. */
  focus: readonly string[]
  /** Files read once or twice on the way. */
  aside: readonly string[]
  draw: Draw
}

function worldOf(draw: Draw): World {
  const repository = draw.pick(REPOSITORIES)
  const topic = draw.pick(TOPICS)
  const root = `/home/dev/projects/${repository}`
  const [main, helper, third] = topic.packages

  return {
    repository,
    root,
    module: `example.com/${repository}`,
    topic,
    focus: [
      `${root}/internal/${main}/${main}.go`,
      `${root}/internal/${helper}/${helper}.go`,
      `${root}/internal/${main}/${main}_test.go`,
    ],
    aside: [
      `${root}/internal/${third}/${third}.go`,
      `${root}/cmd/${repository}/main.go`,
      `${root}/internal/${helper}/options.go`,
      `${root}/docs/operations.md`,
    ],
    draw,
  }
}

/**
 * The repository-relative form of a path under the root.
 */
function relativeOf(world: World, path: string): string {
  return path.startsWith(`${world.root}/`)
    ? path.slice(world.root.length + 1)
    : path
}

function packageOf(world: World, path: string): string {
  return relativeOf(world, path).split('/')[1] ?? world.topic.packages[0]
}

/**
 * The lines of one generated Go function, varied by `n`.
 */
function goBlockOf(name: string, n: number): string[] {
  const type = pascalOf(name)
  const verbs = ['Allow', 'Reset', 'Refill', 'Load', 'Flush', 'Observe']
  const verb = verbs[n % verbs.length] ?? 'Load'

  switch (n % 3) {
    case 0:
      return [
        `// ${verb}${n} reports whether the tenant may go on in this window.`,
        `func (s *${type}) ${verb}${n}(ctx context.Context, tenant string) (bool, error) {`,
        '\tbucket, err := s.store.Bucket(ctx, tenant)',
        '\tif err != nil {',
        `\t\treturn false, fmt.Errorf("${name}: bucket of %s: %w", tenant, err)`,
        '\t}',
        '',
        `\treturn bucket.Take(time.Now(), ${n + 1}), nil`,
        '}',
      ]
    case 1:
      return [
        `func (s *${type}) ${verb}${n}(ctx context.Context, id string) (*Record, error) {`,
        '\tctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)',
        '\tdefer cancel()',
        '',
        '\trow, err := s.db.QueryRow(ctx, selectRecord, id)',
        '\tif errors.Is(err, ErrNotFound) {',
        '\t\treturn nil, nil',
        '\t}',
        '',
        '\treturn row, err',
        '}',
      ]
    default:
      return [
        `const ${verb.toLowerCase()}Limit${n} = ${(n + 1) * 16}`,
        '',
        `func describe${verb}${n}(r *Record) string {`,
        `\treturn fmt.Sprintf("%s (%s, attempt %d) in ${name}", r.ID, r.Kind, r.Attempt)`,
        '}',
      ]
  }
}

/**
 * The lines of a Go source file of a package, at least `chars` long.
 */
function goSourceOf(name: string, chars: number): string[] {
  const head = [
    `package ${name}`,
    '',
    'import (',
    '\t"context"',
    '\t"errors"',
    '\t"fmt"',
    '\t"time"',
    ')',
  ]
  const lines = [...head]
  let length = head.join('\n').length

  for (let n = 0; length < chars; n++) {
    const block = ['', ...goBlockOf(name, n)]

    lines.push(...block)
    length += block.join('\n').length + 1
  }

  return lines
}

/**
 * What a Bash call runs, what it printed, and how it is described.
 */
type Command = {
  command: string
  description: string
  output: (chars: number, fails: boolean) => string
}

/**
 * Short commands a longer command line is padded with, `&&` apart.
 */
function paddingOf(world: World, name: string, n: number): string {
  const lines = [
    `go vet ./internal/${name}/...`,
    `go build -o /tmp/${world.repository}-${n} ./cmd/${world.repository}`,
    `git diff --stat -- internal/${name}`,
    `rg -n --glob '!*_test.go' '${pascalOf(name)}' internal/${name} | head -n ${20 + n}`,
    `wc -l internal/${name}/*.go`,
    `golangci-lint run ./internal/${name}/... --timeout=${2 + (n % 3)}m`,
    `go test ./internal/${name}/... -count=1 -run 'Test${pascalOf(name)}' 2>&1 | tail -n ${15 + n}`,
  ]

  return lines[n % lines.length] ?? lines[0] ?? ''
}

/**
 * A first command, then padding commands until the line is `chars` long.
 */
function chainOf(world: World, name: string, first: string, chars: number): string {
  const parts = [`cd ${world.root}`, first]

  for (let n = 0; parts.join(' && \\\n  ').length < chars; n++) {
    parts.push(paddingOf(world, name, n))
  }

  return parts.join(' && \\\n  ')
}

function goTestOutputOf(world: World, name: string, chars: number, fails: boolean): string {
  const test = `Test${pascalOf(name)}${pascalOf(world.topic.packages[1])}`
  const lines = filled(chars - 80, n => {
    const step = n % 3

    return step === 0
      ? `=== RUN   ${test}/case_${Math.floor(n / 3)}`
      : step === 1
        ? `    ${name}_test.go:${40 + n * 3}: tenant-${n % 17} took ${n % 9} of ${10 + (n % 5)} tokens`
        : `--- PASS: ${test}/case_${Math.floor(n / 3)} (0.0${n % 10}s)`
  })

  return [
    ...lines,
    ...(fails
      ? [
          `--- FAIL: ${test} (1.${lines.length % 10}2s)`,
          `    ${name}_test.go:${118 + lines.length}: got status 429, want 200`,
          'FAIL',
          `FAIL\t${world.module}/internal/${name}\t1.${lines.length % 10}4s`,
          'FAIL',
        ]
      : ['PASS', `ok  \t${world.module}/internal/${name}\t0.${lines.length % 10}31s`]),
  ].join('\n')
}

function gitOutputOf(name: string, chars: number): string {
  const subjects = [
    `${name}: read the limits per tenant`,
    `${name}: keep the bucket between requests`,
    'config: document the new keys',
    `${name}: count rejected requests`,
    'deploy: raise the replica count for the load test',
  ]

  return filled(chars, n =>
    n < 3
      ? ` M internal/${name}/${['options.go', `${name}.go`, `${name}_test.go`][n]}`
      : `${(0x7a31c0 + n * 0x2f1d3).toString(16)} ${subjects[n % subjects.length]}`,
  ).join('\n')
}

function grepOutputOf(world: World, name: string, chars: number): string {
  return filled(chars, n => {
    const file = `internal/${n % 4 === 3 ? world.topic.packages[2] : name}/${['options.go', `${name}.go`, 'server.go'][n % 3]}`

    return `${file}:${12 + n * 7}:\tif err := s.${pascalOf(name)}${n % 5}(ctx, tenant); err != nil {`
  }).join('\n')
}

function jsonOutputOf(name: string, chars: number): string {
  return [
    '{',
    `  "${name}": [`,
    ...filled(chars - 40, n =>
      `    { "tenant": "tenant-${n % 23}", "accepted": ${200 + n * 3}, "rejected": ${n % 7}, "window": "1s" },`,
    ),
    '    { "tenant": "default", "accepted": 0, "rejected": 0, "window": "1s" }',
    '  ]',
    '}',
  ].join('\n')
}

function rolloutOutputOf(world: World, name: string, chars: number, fails: boolean): string {
  if (fails) {
    return [
      `error: error validating "STDIN": error validating data: ValidationError(ConfigMap.data.${name}.burst): invalid type for io.k8s.api.core.v1.ConfigMap.data: got "integer", expected "string"`,
      'error: unable to decode "STDIN": json: cannot unmarshal number into Go struct field ConfigMap.data of type string',
    ].join('\n')
  }

  return [
    `configmap/${world.repository}-${name} configured`,
    `deployment.apps/${world.repository} restarted`,
    ...filled(chars - 160, n =>
      n % 4 === 3
        ? `${world.repository}-7c9f${(n * 4099).toString(16).slice(0, 4)}-x${n % 10}q   1/1     Running   0          ${n % 50}s`
        : `Waiting for deployment "${world.repository}" rollout to finish: ${n % 3} of 3 updated replicas are available...`,
    ),
    `deployment "${world.repository}" successfully rolled out`,
  ].join('\n')
}

function tableOutputOf(chars: number, fails: boolean): string {
  if (fails) {
    return [
      'Traceback (most recent call last):',
      '  File "<stdin>", line 14, in <module>',
      "KeyError: 'latency_ms'",
    ].join('\n')
  }

  return [
    'tenant        requests   p50_ms   p99_ms   rejected',
    ...filled(chars - 60, n =>
      `tenant-${String(n % 31).padEnd(6)} ${String(1200 + n * 37).padStart(9)} ${String(2 + (n % 5)).padStart(8)} ${String(40 + (n * 13) % 300).padStart(8)} ${String(n % 9).padStart(10)}`,
    ),
  ].join('\n')
}

/**
 * The kinds of Bash command the generator writes. A short command is one
 * line padded with others; a long one carries a heredoc.
 */
type CommandKind =
  | 'test'
  | 'git'
  | 'search'
  | 'curl'
  | 'kube'
  | 'python'
  | 'commit'
  | 'load'

const SHORT_KINDS: readonly CommandKind[] = ['test', 'git', 'search', 'curl']
const LONG_KINDS: readonly CommandKind[] = ['kube', 'python', 'commit', 'load', 'test']

/**
 * The quoted line a load test prints, by the call that ran it.
 */
function quotedOf(tag: string, p99: number, rate: number): string {
  return `run ${tag}: p99 ${p99}ms at ${rate} req/s`
}

function commandOf(world: World, kind: CommandKind, chars: number, tag: string): Command {
  const { draw } = world
  const name = draw.pick(world.topic.packages)
  const sentences = [
    `Read the ${name} limits per tenant from the config instead of one global value.`,
    `Keep the bucket of a tenant between requests, keyed by the tenant id.`,
    `Count the rejected requests per tenant so the dashboard can show them.`,
    `Tests cover a tenant at the limit, one over it and one with no limit set.`,
    `The default for a tenant with no entry stays unlimited, as before.`,
  ]

  switch (kind) {
    case 'test':
      return {
        command: chainOf(
          world,
          name,
          `go test ./internal/${name}/... -run 'Test${pascalOf(name)}' -count=1 -race -v 2>&1 | tail -n 80`,
          chars,
        ),
        description: `Run the ${name} tests with the race detector`,
        output: (out, fails) => goTestOutputOf(world, name, out, fails),
      }
    case 'git':
      return {
        command: chainOf(
          world,
          name,
          `git status --short && git log --oneline -n ${10 + draw.int(0, 20)} -- internal/${name}`,
          chars,
        ),
        description: 'Show the changes and the recent history',
        output: out => gitOutputOf(name, out),
      }
    case 'search':
      return {
        command: chainOf(
          world,
          name,
          `rg -n '${pascalOf(name)}[0-9]\\(ctx' internal cmd | head -n ${30 + draw.int(0, 40)}`,
          chars,
        ),
        description: `Find the callers of the ${name} methods`,
        output: out => grepOutputOf(world, name, out),
      }
    case 'curl': {
      const events = filled(chars - 260, n =>
        `{"tenant":"tenant-${n % 11}","kind":"page_view","at":"2026-10-2${n % 9}T0${n % 10}:1${n % 6}:00Z"}`,
      ).join(',')

      return {
        command: [
          `curl -sS -X POST http://127.0.0.1:8080/v1/${name} \\`,
          "  -H 'Content-Type: application/json' \\",
          `  -H 'X-Tenant: tenant-${draw.int(1, 40)}' \\`,
          `  -d '{"events":[${events}]}' \\`,
          "  | jq '.'",
        ].join('\n'),
        description: `Send a batch of events to the local ${name} endpoint`,
        output: out => jsonOutputOf(name, out),
      }
    }
    case 'kube': {
      const data = filled(chars - 320, n =>
        `  ${name}.tenant-${String(n + 1).padStart(2, '0')}.limit: "${100 + ((n * 75) % 900)}"`,
      )

      return {
        command: [
          `cat <<'EOF' | kubectl --context kind-${world.repository} -n ${world.repository} apply -f -`,
          'apiVersion: v1',
          'kind: ConfigMap',
          'metadata:',
          `  name: ${world.repository}-${name}`,
          'data:',
          ...data,
          'EOF',
          `kubectl --context kind-${world.repository} -n ${world.repository} rollout restart deploy/${world.repository}`,
          `kubectl --context kind-${world.repository} -n ${world.repository} rollout status deploy/${world.repository} --timeout=120s`,
          `kubectl --context kind-${world.repository} -n ${world.repository} get pods -o wide`,
        ].join('\n'),
        description: `Apply the ${name} config to the local cluster and roll out`,
        output: (out, fails) => rolloutOutputOf(world, name, out, fails),
      }
    }
    case 'python': {
      const body = filled(chars - 200, n =>
        [
          'rows = list(csv.DictReader(open(path)))',
          "by_tenant = collections.defaultdict(list)",
          'for row in rows:',
          "    by_tenant[row['tenant']].append(float(row['latency_ms']))",
          'for tenant, values in sorted(by_tenant.items()):',
          '    values.sort()',
          '    p50 = values[len(values) // 2]',
          '    p99 = values[min(len(values) - 1, int(len(values) * 0.99))]',
          "    rejected = sum(1 for row in rows if row['tenant'] == tenant and row['status'] == '429')",
          "    print(f'{tenant:<13} {len(values):>9} {p50:>8.0f} {p99:>8.0f} {rejected:>10}')",
          `path = '/tmp/${world.repository}-run-${n}.csv'`,
        ][n % 11] ?? '',
      )

      return {
        command: [
          `cd ${world.root} && python3 - <<'PY'`,
          'import collections',
          'import csv',
          '',
          `path = '/tmp/${world.repository}-run.csv'`,
          "print('tenant        requests   p50_ms   p99_ms   rejected')",
          ...body,
          'PY',
        ].join('\n'),
        description: 'Summarise the load test per tenant',
        output: (out, fails) => tableOutputOf(out, fails),
      }
    }
    case 'commit': {
      const body = filled(chars - 200, n => sentences[n % sentences.length] ?? '')

      return {
        command: [
          `cd ${world.root} && git add internal/${name} docs && git commit --gpg-sign -F - <<'EOF'`,
          `${name}: ${world.topic.task.replace(/^add /, 'support ')}`,
          '',
          ...body,
          'EOF',
          'git log --stat -n 1',
        ].join('\n'),
        description: `Commit the ${name} change`,
        output: out => gitOutputOf(name, out),
      }
    }
    case 'load': {
      const rate = 100 * draw.int(3, 12)
      const p99 = draw.int(40, 900)
      const targets = filled(chars - 520, n =>
        [
          `POST http://127.0.0.1:8080/v1/${name}`,
          'Content-Type: application/json',
          `X-Tenant: tenant-${String(n % 40).padStart(2, '0')}`,
          `@/tmp/${world.repository}-body.json`,
          '',
        ][n % 5] ?? '',
      )

      return {
        command: [
          `cat > /tmp/${world.repository}-targets.txt <<'EOF'`,
          ...targets,
          'EOF',
          `vegeta attack -targets=/tmp/${world.repository}-targets.txt -rate=${rate}/s -duration=30s | tee /tmp/${world.repository}-run.bin | vegeta report`,
          `vegeta report -type='hist[0,5ms,10ms,50ms,100ms,500ms]' /tmp/${world.repository}-run.bin`,
          `vegeta report -type=json /tmp/${world.repository}-run.bin | jq -r '"run ${tag}: p99 \\(.latencies["99th"] / 1e6 | floor)ms at ${rate} req/s"'`,
        ].join('\n'),
        description: `Load test the ${name} endpoint at ${rate} requests a second`,
        output: (out, fails) =>
          fails
            ? `Error: dial tcp 127.0.0.1:8080: connect: connection refused\nvegeta: no results in /tmp/${world.repository}-run.bin`
            : [
                `Requests      [total, rate, throughput]         ${rate * 30}, ${rate}.02, ${rate - 3}.71`,
                'Duration      [total, attack, wait]             30.08s, 29.998s, 79.9ms',
                `Latencies     [min, mean, 50, 90, 95, 99, max]  1.2ms, 9.8ms, 4.1ms, 21.7ms, 38.2ms, ${p99}.0ms, 1.31s`,
                'Bytes In      [total, mean]                     1840320, 122.69',
                'Success       [ratio]                           99.73%',
                `Status Codes  [code:count]                      200:${rate * 30 - 40}  429:40`,
                'Bucket           #      %       Histogram',
                ...filled(out - 520, n =>
                  `[${[0, 5, 10, 50, 100, 500][n % 6]}ms,\t${[5, 10, 50, 100, 500, 1000][n % 6]}ms]\t${(n * 977) % 9000}\t${((n * 13) % 60) + 0.5}%\t${'#'.repeat(1 + (n % 40))}`,
                ),
                quotedOf(tag, p99, rate),
              ].join('\n'),
      }
    }
  }
}

/**
 * One call as planned: its tool, the file it works on, and its part in the
 * session.
 */
type Plan = {
  tool: string
  file?: string
  fails?: boolean
  /** The index of the failed call this one runs again. */
  retries?: number
  /** True for the Bash whose output the newest prompt quotes. */
  isQuoted?: boolean
  /** True when the newest prompt depends on this call. */
  isDepended?: boolean
}

/**
 * Calls per tool for `calls` calls: each tool's share, rounded by largest
 * remainder so the counts add up and no tool strays a call from its share.
 */
function countsOf(shares: Readonly<Record<string, number>>, calls: number): [string, number][] {
  const entries = Object.entries(shares)
  const total = entries.reduce((sum, [, share]) => sum + share, 0)
  const exact = entries.map(([tool, share]) => [tool, (share / total) * calls] as const)
  const counts = exact.map(([tool, value]) => [tool, Math.floor(value)] as [string, number])
  const left = calls - counts.reduce((sum, [, count]) => sum + count, 0)
  const order = exact
    .map(([, value], index) => [index, value - Math.floor(value)] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])

  for (const [index] of order.slice(0, left)) {
    const entry = counts[index]

    if (entry !== undefined) {
      entry[1]++
    }
  }

  return counts
}

/**
 * The tools in the order they are called: the counts shuffled, then the
 * most used tool moved into the pinned tail, so the calls the newest prompt
 * depends on are all judged.
 */
function orderOf(draw: Draw, shares: Readonly<Record<string, number>>, calls: number): string[] {
  const counts = countsOf(shares, calls)
  const tools = counts.flatMap(([tool, count]) => Array<string>(count).fill(tool))

  for (let at = tools.length - 1; at > 0; at--) {
    const other = draw.int(0, at)
    const swap = tools[at] as string

    tools[at] = tools[other] as string
    tools[other] = swap
  }

  const [common] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['']

  for (let at = tools.length - TAIL_CALLS; at < tools.length; at++) {
    const from = tools.findLastIndex(
      (tool, index) => tool === common && index < tools.length - TAIL_CALLS,
    )

    if (at >= 0 && tools[at] !== common && from >= 0) {
      tools[from] = tools[at] as string
      tools[at] = common
    }
  }

  return tools
}

/**
 * Plans every call: which file each Read and Edit works on (mostly the
 * focus files, so later operations supersede earlier reads), which Bash
 * runs fail and are run again, and which calls the newest prompt depends
 * on: the last operation of up to two focus files, and one successful Bash
 * in the second half of the judged calls whose output it quotes, which is
 * never a retry.
 */
function planOf(world: World, tools: readonly string[]): Plan[] {
  const { draw } = world
  const judged = tools.length - TAIL_CALLS
  const plans: Plan[] = tools.map(tool => ({ tool }))
  const read = new Set<string>()
  let written = 0

  for (const plan of plans) {
    if (plan.tool === 'Read') {
      plan.file = draw.next() < 0.75 ? draw.pick(world.focus) : draw.pick(world.aside)
      read.add(plan.file)
    } else if (plan.tool === 'Edit') {
      const known = world.focus.filter(file => read.has(file))

      plan.file = draw.pick(known.length > 0 ? known : world.focus)
    } else if (plan.tool === 'Write') {
      plan.file = `${world.root}/docs/notes/${world.topic.packages[0]}-${++written}.md`
    }
  }

  for (let at = 0; at + 1 < judged; at++) {
    const [plan, after] = [plans[at], plans[at + 1]]

    if (plan?.tool === 'Bash' && after?.tool === 'Bash' && draw.next() < 0.15) {
      plan.fails = true
      after.retries = at
      at++
    }
  }

  const lastOf = new Map<string, number>()

  plans.forEach((plan, at) => {
    if (plan.file !== undefined) {
      lastOf.set(plan.file, at)
    }
  })

  const named = world.focus
    .filter(file => {
      const at = lastOf.get(file)
      const tool = at === undefined ? undefined : plans[at]?.tool

      return at !== undefined && at < judged && (tool === 'Read' || tool === 'Edit')
    })
    .slice(0, 2)

  for (const file of named) {
    const plan = plans[lastOf.get(file) ?? -1]

    if (plan !== undefined) {
      plan.isDepended = true
    }
  }

  const quotable = plans
    .map((plan, at) => [plan, at] as const)
    .filter(
      ([plan, at]) =>
        plan.tool === 'Bash' && plan.fails !== true && at >= judged / 2 && at < judged,
    )

  if (quotable.length > 0) {
    const [plan] = draw.pick(quotable)

    // A retry repeats the failed command and its output, so a quoted retry
    // would quote a line that other results print too. The quoted call runs
    // a load test of its own instead, and the run before it stays failed.
    delete plan.retries
    plan.isQuoted = true
    plan.isDepended = true
  }

  return plans
}

/**
 * A short note of what the assistant is about to do, about `chars` long:
 * the first sentence for the tool, then remarks. A note drawn under 25
 * characters is left empty, as when the assistant makes a call without a
 * word.
 */
function noteOf(world: World, plan: Plan, chars: number): string {
  if (chars < 25) {
    return ''
  }

  const { draw } = world
  const [main, helper] = world.topic.packages
  const file = plan.file === undefined ? '' : relativeOf(world, plan.file)
  const firsts: Readonly<Record<string, readonly string[]>> = {
    Bash: [
      `Running the ${main} tests.`,
      'Checking the rollout.',
      'Load test against the local build.',
      `Looking for other callers in ${helper}.`,
      'Committing this step.',
    ],
    Read: [`Reading ${file}.`, `Checking what ${file} does now.`],
    Edit: [`Updating ${file}.`, `Applying the fix to ${file}.`],
    Write: [`Writing the notes to ${file}.`],
    Grep: [`Searching for the ${helper} calls.`],
    SendMessage: [
      `Handing the ${helper} part to a worker.`,
      'Telling the reviewer what changed.',
    ],
    Agent: [`Asking an agent to survey the ${main} callers.`],
    AskUserQuestion: ['One choice needs your call.'],
  }
  const remarks = [
    'The previous run was green.',
    'Nothing else changed since the last commit.',
    `worker-2 is on the ${helper} side.`,
    'This is the step the plan put next.',
    `Keeping the ${main} API as it is.`,
  ]
  let text = draw.pick(firsts[plan.tool] ?? [`Using ${plan.tool}.`])

  if (plan.retries !== undefined) {
    text = 'That failed; fixing the cause and running it again.'
  }

  // Remarks are added from a place drawn per note, each only when it brings
  // the note nearer its length than it is without it.
  const from = draw.int(0, remarks.length - 1)

  for (let tried = 0; tried < remarks.length; tried++) {
    const remark = remarks[(from + tried) % remarks.length] ?? ''

    if (text.length + 1 + remark.length - chars >= chars - text.length) {
      break
    }

    text += ` ${remark}`
  }

  return text
}

/**
 * A message body of about `chars`: a brief to a worker or an agent.
 */
function briefOf(world: World, chars: number): string {
  const [main, helper, third] = world.topic.packages
  const head = [
    `Task: ${world.topic.task} in ${world.root}.`,
    '',
    `Files: internal/${main}/${main}.go, internal/${helper}/${helper}.go, internal/${main}/${main}_test.go.`,
    '',
  ]
  const steps = [
    `Read the current ${helper} code before changing it and keep its exported names.`,
    `Run go test ./internal/${main}/... -race after every edit and paste the last lines.`,
    `Do not touch internal/${third}; another worker owns it.`,
    'Write every timestamp from the date command, never from memory.',
    'Report the commit hash and the test output when done, and nothing longer.',
    `If the ${main} tests need a fixture, put it under testdata, not in the test file.`,
  ]

  return [
    ...head,
    ...filled(chars - head.join('\n').length, n => `${n + 1}. ${steps[n % steps.length] ?? ''}`),
  ].join('\n')
}

function reportOf(world: World, chars: number): string {
  const [main, helper] = world.topic.packages

  return [
    '## Report',
    '',
    ...filled(chars - 12, n =>
      [
        `- internal/${main}/${main}.go: ${n + 3} callers, all through the ${pascalOf(main)} type.`,
        `- internal/${helper}/${helper}.go: the bucket is created per request today (line ${40 + n * 9}).`,
        `- Tests: ${12 + n} pass, none covers a tenant without a limit.`,
        `- No other package reads the ${helper} options directly.`,
      ][n % 4] ?? '',
    ),
  ].join('\n')
}

/**
 * The input and the result of one call, at the lengths drawn for it.
 */
function renderedOf(
  world: World,
  plan: Plan,
  sizes: { input: number; result: number },
  tag: string,
  previous: Command | undefined,
): { input: Record<string, unknown>; result: string; command?: Command } {
  const { draw } = world
  const fails = plan.fails === true

  switch (plan.tool) {
    case 'Bash': {
      const chars = Math.min(COMMAND_MAX_CHARS, Math.max(COMMAND_MIN_CHARS, sizes.input))
      const kind: CommandKind = plan.isQuoted
        ? 'load'
        : draw.pick(chars < 600 ? SHORT_KINDS : LONG_KINDS)
      const command =
        plan.retries !== undefined && previous !== undefined
          ? {
              ...previous,
              command: `go mod tidy && ${previous.command}`.slice(0, COMMAND_MAX_CHARS),
            }
          : commandOf(world, kind, chars, tag)

      return {
        input: { command: command.command, description: command.description },
        result: command.output(sizes.result, fails),
        command,
      }
    }
    case 'Read': {
      const file = plan.file ?? world.focus[0] ?? ''
      const lines = goSourceOf(packageOf(world, file), sizes.result)
      const offset = draw.next() < 0.5 ? 1 : 1 + 20 * draw.int(1, 8)

      return {
        input:
          offset === 1
            ? { file_path: file }
            : { file_path: file, offset, limit: lines.length },
        result: numbered(lines, offset),
      }
    }
    case 'Edit': {
      const file = plan.file ?? world.focus[0] ?? ''
      const name = packageOf(world, file)
      const old = goSourceOf(name, sizes.input / 2.4).slice(8).join('\n')
      const replaced = old
        .replaceAll('s.store.Bucket(ctx, tenant)', 's.buckets.Get(ctx, tenant, s.limitOf(tenant))')
        .replaceAll('return row, err', 'return row, s.wrap(err)')
      const at = 20 * draw.int(1, 9)

      return {
        input: { file_path: file, old_string: old, new_string: `${replaced}\n` },
        result:
          `The file ${file} has been updated. Here's the result of running \`cat -n\` ` +
          `on a snippet of the edited file:\n${numbered(goSourceOf(name, sizes.result).slice(8), at)}`,
      }
    }
    case 'Write': {
      const file = plan.file ?? `${world.root}/docs/notes.md`

      return {
        input: { file_path: file, content: `# Notes\n\n${briefOf(world, sizes.input)}\n` },
        result: `File created successfully at: ${file}`,
      }
    }
    case 'Grep': {
      const name = draw.pick(world.topic.packages)

      return {
        input: {
          pattern: `${pascalOf(name)}[0-9]\\(ctx`,
          path: `${world.root}/internal`,
          output_mode: 'content',
          '-n': true,
        },
        result: grepOutputOf(world, name, sizes.result),
      }
    }
    case 'SendMessage': {
      const to = draw.pick(WORKERS)

      return {
        input: {
          to,
          summary: `${world.topic.packages[1]} part of the change`,
          message: briefOf(world, sizes.input),
        },
        result: JSON.stringify({
          success: true,
          message: `Message sent to ${to}'s inbox`,
          routing: { sender: 'team-lead', target: `@${to}` },
        }),
      }
    }
    case 'Agent':
      return {
        input: {
          description: `Survey the ${world.topic.packages[0]} callers`,
          subagent_type: 'Explore',
          prompt: briefOf(world, sizes.input),
        },
        result: reportOf(world, sizes.result),
      }
    case 'AskUserQuestion': {
      const [main, helper] = world.topic.packages
      const question = `Should the ${helper} limits live in the ${main} config or in their own file?`

      return {
        input: {
          questions: [
            {
              question,
              header: 'Limits',
              multiSelect: false,
              options: [
                { label: `In the ${main} config`, description: 'One file to deploy, the way the other options are read.' },
                { label: 'Their own file', description: 'Reloadable without a restart, at the cost of a second file.' },
                { label: 'Both', description: 'Defaults in the config, overrides in the file.' },
              ],
            },
          ],
        },
        result: `User has answered your questions: "${question}"="In the ${main} config". You can now continue with the user's answers in mind.`,
      }
    }
    default:
      return {
        input: { request: briefOf(world, sizes.input) },
        result: reportOf(world, sizes.result),
      }
  }
}

/**
 * How long a call's input and result are drawn: inputs around the shape's
 * per-call figure, longer for a brief or a heredoc, short for a path; the
 * result from the shape's median and 90th percentile, except where a tool's
 * answer has a fixed form.
 */
function sizesOf(draw: Draw, shape: Shape, plan: Plan): { input: number; result: number } {
  const center = shape.inputCharsPerCall
  const result = Math.min(
    30_000,
    Math.max(80, draw.logNormal(shape.resultMedian, shape.resultP90)),
  )
  const depended = plan.isDepended === true ? Math.max(DEPENDED_MIN_CHARS, result) : result

  switch (plan.tool) {
    case 'Bash':
      return {
        input: draw.logUniform(Math.max(COMMAND_MIN_CHARS, center / 4), Math.min(COMMAND_MAX_CHARS, center * 2)),
        result: depended,
      }
    case 'Edit':
      return { input: draw.logUniform(300, center), result: Math.max(500, Math.min(depended, 2500)) }
    case 'SendMessage':
      return { input: draw.logUniform(center / 3, center * 1.5), result: 0 }
    case 'Agent':
      return { input: draw.logUniform(center / 2, center * 2), result: depended * 1.5 }
    case 'Write':
      return { input: draw.logUniform(center / 4, center * 2), result: 0 }
    default:
      return { input: center, result: depended }
  }
}

const MID_PROMPTS = [
  'Looks right. Hand the docs part to worker-2 and keep going with the tests.',
  'CI on the branch failed on the race detector; look at that before anything else.',
  'Use the existing token bucket rather than writing a new one.',
  'Fine. Run the load test again once the rollout is done.',
  'Keep the old config key working for one release, with a warning.',
  'What did the reviewer say? Fix what it found and carry on.',
  'Do not commit yet; I want to see the numbers first.',
  'Good. Split the remaining work between the two workers.',
]

const SUMMARIES = [
  'The tests pass with the race detector and the rollout is done; the change is not committed yet.',
  'The first part is in: the limits are read per tenant. The bucket still lives per request.',
  'The workers reported back; one asked whether the old key must keep working.',
  'The load test ran at the planned rate; the numbers are in the last output.',
]

/**
 * The newest prompt: it names the files whose last operation it builds on,
 * in backticks and by the path the tools were given, and quotes the line
 * of the load test it wants in the pull request, in double quotes.
 */
function newestOf(world: World, named: readonly string[], quote: string | undefined): string {
  const files =
    named.length === 0
      ? ''
      : `The change in ${named.map(file => `\`${file}\``).join(' and ')} still misses one case: ` +
        `${world.topic.caveat}. Fix it there and add a test. `
  const quoted =
    quote === undefined
      ? 'Then open the PR.'
      : `Then open the PR, with the figure the load test printed, "${quote}", in its description.`

  return `${files}${quoted}`
}

/**
 * Builds an invented session in the shape of the measured ones: an opening
 * prompt, `calls` tool calls in the shape's tool mix, each with a short
 * note, an input of the shape's length and a result of its lengths, a few
 * prompts along the way, and a newest prompt that depends on a few earlier
 * calls. Those calls are labelled `keep`; every other judged call is `drop`
 * or `truncate`, among them the reads a later read or edit of the same file
 * superseded, the Bash runs that failed and were run again, and the briefs
 * and reports of work that is done.
 *
 * The same options give the same scenario: every choice comes from `seed`.
 *
 * @param options the scenario's id and title, its number of calls, the
 *   shape to follow and the seed
 * @returns the scenario with its labels
 */
export function generateScenario(options: {
  id: string
  title: string
  calls: number
  shape: Shape
  seed: number
}): Scenario {
  const { id, title, calls, shape, seed } = options
  const draw = drawOf(seed)
  const world = worldOf(draw)
  const plans = planOf(world, orderOf(draw, shape.toolShares, calls))
  const prompts = Math.min(9, Math.max(1, Math.round(calls / 25)))
  const before = new Set(
    Array.from({ length: prompts }, (_, k) => Math.floor((calls * (k + 1)) / (prompts + 1))),
  )
  const idOf = (n: number) => `${id}-${String(n + 1).padStart(3, '0')}`
  const messages: SessionMessage[] = [
    {
      role: 'user',
      text:
        `In ${world.root}, ${world.topic.task}. Keep the public API as it is, run the ` +
        'tests and the load test before you call it done, and split the work with the ' +
        'workers where it helps.',
      toolUses: [],
    },
  ]
  const commands: (Command | undefined)[] = []
  let quote: string | undefined

  plans.forEach((plan, at) => {
    if (before.has(at)) {
      messages.push(
        { role: 'assistant', text: draw.pick(SUMMARIES), toolUses: [] },
        { role: 'user', text: draw.pick(MID_PROMPTS), toolUses: [] },
      )
    }

    const toolUseId = idOf(at)
    const sizes = sizesOf(draw, shape, plan)
    const previous = plan.retries === undefined ? undefined : commands[plan.retries]
    const rendered = renderedOf(world, plan, sizes, String(at + 1), previous)
    const note = noteOf(
      world,
      plan,
      Math.min(600, draw.logNormal(shape.assistantCharsPerCall, shape.assistantCharsPerCall * 3)),
    )
    const use: ToolUseSummary = {
      tool_use_id: toolUseId,
      tool: plan.tool,
      input: rendered.input,
      text: rendered.result,
    }

    if (plan.fails === true) {
      use.isError = true
    }

    if (plan.isQuoted === true) {
      quote = rendered.result.split('\n').at(-1)
    }

    commands[at] = rendered.command
    messages.push(
      { role: 'assistant', text: note, toolUses: [use] },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          { tool_use_id: toolUseId, text: rendered.result, isError: plan.fails === true },
        ],
      },
    )
  })

  const named = plans
    .filter(plan => plan.isDepended === true && plan.file !== undefined)
    .map(plan => plan.file as string)

  messages.push(
    { role: 'assistant', text: draw.pick(SUMMARIES), toolUses: [] },
    { role: 'user', text: newestOf(world, named, quote), toolUses: [] },
  )

  const depended = new Set(
    plans.flatMap((plan, at) => (plan.isDepended === true ? [idOf(at)] : [])),
  )
  const expected: Record<string, Label> = {}

  for (const call of pairCalls(messages, PRESERVE_RECENT)) {
    if (call.isPinned) {
      if (depended.has(call.toolUseId)) {
        throw new Error(`${id}: the call ${call.toolUseId} the newest prompt depends on is pinned`)
      }

      continue
    }

    expected[call.toolUseId] = depended.has(call.toolUseId) ? KEEP : CUT
  }

  return { id, title, messages, expected }
}
