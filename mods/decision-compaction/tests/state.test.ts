import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { bytesBesideOf, routeOf } from '../hooks/providers'
import {
  estimatedTokensOf,
  stateWithin,
  goalOf,
  headOf,
  pairCalls,
} from '../hooks/state'
import type { CallNote, Fitted, Stage } from '../hooks/state'
import { BARE } from '../hooks/systemone'
import { answering, calling, said, sessionOf } from './fixtures'

describe('estimatedTokensOf', () => {
  const sizes: Record<string, [string, number]> = {
    'success: an empty text costs nothing': ['', 0],
    'success: white space is free': ['  \n\t ', 0],
    'success: a short word is one token': ['hello', 1],
    'success: six letters are still one token': ['abcdef', 1],
    'success: the seventh letter starts a second token': ['abcdefg', 2],
    'success: a long identifier costs a token per six letters': [
      'preserveRecentMessages',
      4,
    ],
    'success: two words are two tokens': ['a b', 2],
    'success: digits cost half a token each': ['1234', 2],
    'success: an odd count of digits rounds up': ['12345', 3],
    'success: symbols cost nine tenths each': ['{"a":1}', 6],
    'success: ten symbols are nine tokens': ['!!!!!!!!!!', 9],
    'success: an underscore splits a word': ['foo_bar', 3],
    'success: a CJK character is one token': ['日本語', 3],
    'success: an accented letter ends the ASCII run': ['héllo', 3],
  }

  for (const [name, [text, tokens]] of Object.entries(sizes)) {
    test(name, () => {
      expect(estimatedTokensOf(text)).toBe(tokens)
    })
  }
})

describe('headOf', () => {
  test('success: a cut never ends on half a surrogate pair', () => {
    expect(headOf('ab😀cd', 3)).toBe('ab')
    expect(headOf('ab😀cd', 4)).toBe('ab😀')
    expect(headOf('abc', 10)).toBe('abc')
    expect(headOf('abc', 0)).toBe('')
  })
})

describe('pairCalls', () => {
  test('success: calls are paired by tool_use_id and numbered in order', () => {
    const calls = pairCalls(sessionOf(), 2)

    expect(
      calls.map(call => [
        call.id,
        call.toolUseId,
        call.tool,
        call.callIndex,
        call.resultIndex,
        call.resultChars,
        call.isError,
        call.isPinned,
      ]),
    ).toEqual([
      ['t1', 'u1', 'Read', 1, 2, 5000, false, false],
      ['t2', 'u2', 'Bash', 3, 4, 4000, true, false],
      ['t3', 'u3', 'Grep', 5, 6, 3000, false, false],
      ['t4', 'u4', 'Edit', 9, 10, 2, false, true],
    ])
  })

  const pinning: Record<string, { recent: number; pinned: string[] }> = {
    'success: no recent message pinned leaves every call a candidate': {
      recent: 0,
      pinned: [],
    },
    'success: a call whose result is pinned is pinned with it': {
      recent: 5,
      pinned: ['t3', 't4'],
    },
    'success: six recent messages pin the calls among them': {
      recent: 6,
      pinned: ['t3', 't4'],
    },
    'success: a window larger than the session pins everything': {
      recent: 50,
      pinned: ['t1', 't2', 't3', 't4'],
    },
  }

  for (const [name, { recent, pinned }] of Object.entries(pinning)) {
    test(name, () => {
      expect(
        pairCalls(sessionOf(), recent)
          .filter(call => call.isPinned)
          .map(call => call.id),
      ).toEqual(pinned)
    })
  }

  test('success: a call in the first message is pinned', () => {
    const messages = [
      calling('', [['u1', 'Read', {}]]),
      answering([['u1', 'x']]),
      said('a'),
      said('b'),
    ]

    expect(pairCalls(messages, 0).map(call => call.isPinned)).toEqual([true])
  })

  const shared: Record<
    string,
    {
      messages: SessionMessage[]
      expected: [string, string, number, number, boolean][]
    }
  > = {
    'success: an id on two tool uses leaves both unjudged': {
      messages: [
        said('go'),
        calling('', [['dup', 'Read', {}]]),
        answering([['dup', 'one']]),
        calling('', [['u2', 'Read', {}]]),
        answering([['u2', 'two']]),
        calling('', [['dup', 'Read', {}]]),
        answering([['dup', 'three']]),
        said('done'),
      ],
      expected: [
        ['t1', 'dup', 1, 2, true],
        ['t2', 'u2', 3, 4, false],
        ['t3', 'dup', 5, 2, true],
      ],
    },
    'success: an id on two results leaves its call unjudged': {
      messages: [
        said('go'),
        calling('', [
          ['dup', 'Read', {}],
          ['u2', 'Read', {}],
        ]),
        answering([
          ['dup', 'one'],
          ['u2', 'two'],
        ]),
        answering([['dup', 'again']]),
        said('done'),
      ],
      expected: [
        ['t1', 'dup', 1, 2, true],
        ['t2', 'u2', 1, 2, false],
      ],
    },
  }

  for (const [name, { messages, expected }] of Object.entries(shared)) {
    test(name, () => {
      expect(
        pairCalls(messages, 0).map(call => [
          call.id,
          call.toolUseId,
          call.callIndex,
          call.resultIndex,
          call.isPinned,
        ]),
      ).toEqual(expected)
    })
  }

  test('success: a call still in flight is not paired', () => {
    const messages = [
      said('go'),
      calling('', [
        ['u1', 'Read', {}],
        ['u2', 'Bash', {}],
      ]),
      answering([['u2', 'done']]),
      said('more'),
    ]

    expect(
      pairCalls(messages, 0).map(call => [call.id, call.toolUseId]),
    ).toEqual([['t1', 'u2']])
  })
})

describe('goalOf', () => {
  test('success: the instructions given with the compaction are the goal', () => {
    expect(goalOf(sessionOf(), '  keep the migration plan  ')).toBe(
      'keep the migration plan',
    )
  })

  test('success: without instructions the last three prompts are the goal', () => {
    const messages = [
      said('one'),
      said('two'),
      answering([['u1', 'a tool result is not a prompt']]),
      calling('an assistant text is not a prompt', []),
      said('three'),
      said('   '),
      said('four'),
    ]

    expect(goalOf(messages)).toBe('two\nthree\nfour')
    expect(goalOf(messages, '   ')).toBe('two\nthree\nfour')
  })

  test('success: a long prompt is cut to 500 characters', () => {
    const goal = goalOf([said('p'.repeat(900))])

    expect(goal).toBe(`${'p'.repeat(499)}…`)
  })

  test('success: a conversation with no prompt has an empty goal', () => {
    expect(goalOf([calling('hi', [])])).toBe('')
  })
})

/**
 * A long session built to need every reduction: a pinned first prompt, old
 * rounds whose assistant messages have long texts and long inputs, old
 * prompts that hold no call, a run of call-only messages, and a pinned
 * recent pair.
 */
function longSession(): SessionMessage[] {
  const messages: SessionMessage[] = [
    said(`Refactor the parser. ${'context '.repeat(300)}`),
  ]

  for (let round = 1; round <= 6; round++) {
    messages.push(
      calling(`Step ${round}. ${'reasoning '.repeat(120)}`, [
        [
          `a${round}`,
          'Write',
          { file_path: `src/f${round}.ts`, content: 'x '.repeat(900) },
        ],
      ]),
      answering([[`a${round}`, 'written']]),
      said(`Follow-up ${round}: ${'detail '.repeat(40)}`),
    )
  }

  for (let run = 1; run <= 5; run++) {
    messages.push(
      calling('', [[`b${run}`, 'Bash', { command: `make target-${run}` }]]),
      answering([[`b${run}`, 'o'.repeat(700), run === 2]]),
    )
  }

  messages.push(
    said(`Now finish. ${'tail '.repeat(200)}`),
    calling('Finishing.', [['z1', 'Edit', { file_path: 'src/z.ts' }]]),
    answering([['z1', 'ok']]),
  )

  return messages
}

const RECENT = 3
const ORDER: Stage[] = [
  'whole',
  'inputs shortened',
  'long texts cut in the middle',
  'old texts replaced by their length',
  'old calls on one line',
  'old call-free messages omitted',
  'rows of old calls joined',
]

function fit(budget: number): Fitted {
  const messages = longSession()

  return stateWithin(messages, pairCalls(messages, RECENT), {
    maxStateTokens: budget,
    preserveRecentMessages: RECENT,
    goal: 'refactor the parser',
    wire: BARE,
  })
}

/**
 * What a budget shrinking from ample to impossible produces: the stages in
 * the order they first appear, the first fit at each, and the smallest
 * budget that still fitted. Walked once and kept, since every stage test
 * reads from the same walk.
 */
type Walk = {
  stages: Stage[]
  first: Map<Stage, Fitted>
  smallest: number
  isEveryFitWithinBudget: boolean
}

let walked: Walk | undefined

function walk(): Walk {
  if (walked !== undefined) {
    return walked
  }

  const found: Walk = {
    stages: [],
    first: new Map(),
    smallest: 0,
    isEveryFitWithinBudget: true,
  }

  for (let budget = fit(Infinity).tokens + 400; budget > 0; budget -= 7) {
    let fitted: Fitted

    try {
      fitted = fit(budget)
    } catch {
      break
    }

    found.smallest = budget
    found.isEveryFitWithinBudget &&= fitted.tokens <= budget

    if (!found.first.has(fitted.stage)) {
      found.stages.push(fitted.stage)
      found.first.set(fitted.stage, fitted)
    }
  }

  walked = found

  return found
}

/**
 * The fit at the largest budget that needs the given stage.
 */
function firstAt(stage: Stage): Fitted {
  const fitted = walk().first.get(stage)

  if (fitted === undefined) {
    throw new Error(`no budget reaches the stage ${stage}`)
  }

  return fitted
}

describe('stateWithin', () => {
  test(
    'success: a shrinking budget walks the stages in order, each within budget',
    { timeoutMs: 30_000 },
    () => {
      const { stages, smallest, isEveryFitWithinBudget } = walk()

      expect(stages).toEqual(ORDER)
      expect(isEveryFitWithinBudget).toBe(true)
      expect(() => fit(smallest - 7)).toThrow(
        'the conversation does not fit the state budget',
      )
    },
  )

  test('success: a budget with room keeps texts and inputs whole', () => {
    const { state, stage } = fit(Infinity)
    const first = state.conversation[1]

    expect(stage).toBe('whole')
    expect(state.goal).toBe('refactor the parser')
    expect(state.context).toContain('`conversation`')
    expect(state.conversation[0]).toEqual({
      at: 0,
      role: 'user',
      text: `Refactor the parser. ${'context '.repeat(300)}`,
    })
    expect(first?.at).toBe(1)
    expect((first?.calls?.[0] as CallNote).id).toBe('t1')
    expect((first?.calls?.[0] as CallNote).tool).toBe('Write')
    expect((first?.calls?.[0] as CallNote).result).toBe(
      'ok, 7 characters, not shown',
    )
    expect((first?.calls?.[0] as CallNote).input).toHaveLength(1000)
    expect(
      state.conversation.some(entry => entry.at === 2),
      'a result-only message is no entry',
    ).toBe(false)
  })

  test('success: an errored call says so in its result note', () => {
    const notes = fit(Infinity).state.conversation.flatMap(
      entry => (entry.calls ?? []) as CallNote[],
    )

    expect(notes.find(note => note.id === 't8')?.result).toBe(
      'error, 700 characters, not shown',
    )
  })

  test('success: shortened inputs keep every text', () => {
    const fitted = firstAt('inputs shortened')
    const first = fitted.state.conversation[1]

    expect((first?.calls?.[0] as CallNote).input.length <= 240).toBe(true)
    expect((first?.calls?.[0] as CallNote).input.endsWith('…')).toBe(true)
    expect(first?.text).toBe(`Step 1. ${'reasoning '.repeat(120)}`)
  })

  test('success: abridging starts with the oldest old message and leaves a count', () => {
    const fitted = firstAt('long texts cut in the middle')
    const first = fitted.state.conversation[1]
    const whole = `Step 1. ${'reasoning '.repeat(120)}`

    expect(first?.text).toBe(
      `${whole.slice(0, 400)}\n[${whole.length - 560} characters left out]\n${whole.slice(-160)}`,
    )
    expect(
      fitted.state.conversation[0]?.text,
      'the pinned first message comes last',
    ).toBe(`Refactor the parser. ${'context '.repeat(300)}`)
  })

  test('success: collapsing replaces an old text with its length', () => {
    const fitted = firstAt('old texts replaced by their length')
    const whole = `Step 1. ${'reasoning '.repeat(120)}`

    expect(fitted.state.conversation[1]?.text).toBe(
      `[${whole.length} characters of text left out]`,
    )
    expect(
      fitted.state.conversation[0]?.text.includes('characters left out]'),
      'pinned texts are only abridged',
    ).toBe(true)
    expect(
      fitted.state.conversation[0]?.text.startsWith('Refactor the parser.'),
    ).toBe(true)
  })

  test('success: an old call shrinks to one line that keeps its id', () => {
    const fitted = firstAt('old calls on one line')

    expect(fitted.state.conversation[1]?.calls).toEqual([
      `t1 Write(file_path=src/f1.ts content=${'x '.repeat(17)}x…) ok 7ch`,
    ])
    expect(
      typeof fitted.state.conversation.at(-1)?.calls?.[0],
      'a pinned call keeps its note',
    ).toBe('object')
  })

  test('success: leaving out drops old messages that hold no call, oldest first', () => {
    const fitted = firstAt('old call-free messages omitted')
    const kept = fitted.state.conversation.map(entry => entry.at)

    expect(kept.includes(3), 'the oldest call-less old message is gone').toBe(
      false,
    )
    expect(kept.includes(0), 'the pinned first message stays').toBe(true)
    expect(kept.includes(1), 'a message with a call stays').toBe(true)
  })

  test('success: folding joins a run of call-only messages into one entry', () => {
    const fitted = firstAt('rows of old calls joined')
    const run = fitted.state.conversation.find(entry => entry.at === 19)

    expect(run).toEqual({
      at: 19,
      role: 'assistant',
      text: '',
      calls: [
        't7 Bash(command=make target-1) ok 700ch',
        't8 Bash(command=make target-2) error 700ch',
        't9 Bash(command=make target-3) ok 700ch',
        't10 Bash(command=make target-4) ok 700ch',
        't11 Bash(command=make target-5) ok 700ch',
      ],
    })
    expect(fitted.state.conversation.some(entry => entry.at === 21)).toBe(false)
  })

  test(
    'success: a run of thousands of call-only messages folds into one entry, weighed as it is sent',
    { timeoutMs: 30_000 },
    () => {
      const count = 3000
      const messages = [said('go')]

      for (let n = 1; n <= count; n++) {
        messages.push(
          calling('', [[`u${n}`, 'Bash', { command: `make t${n}` }]]),
          answering([[`u${n}`, 'out']]),
        )
      }

      messages.push(said('done'))

      const calls = pairCalls(messages, 0)
      const fitAt = (budget: number) =>
        stateWithin(messages, calls, {
          maxStateTokens: budget,
          preserveRecentMessages: 0,
          goal: '',
          wire: BARE,
        })
      let refusal = ''

      try {
        fitAt(1)
      } catch (error) {
        refusal = (error as Error).message
      }

      // What the fitting says is left after its last reduction is the
      // smallest budget it accepts.
      const left = Number(/about (\d+) tokens are left/.exec(refusal)?.[1])
      const fitted = fitAt(left)
      const [first, run] = fitted.state.conversation

      expect(fitted.stage).toBe('rows of old calls joined')
      expect(fitted.state.conversation).toHaveLength(2)
      expect(first).toEqual({ at: 0, role: 'user', text: 'go' })
      expect(run?.at).toBe(1)
      expect(run?.calls).toHaveLength(count)
      expect(run?.calls?.[0]).toBe('t1 Bash(command=make t1) ok 3ch')
      expect(run?.calls?.at(-1)).toBe('t3000 Bash(command=make t3000) ok 3ch')
      expect(
        fitted.tokens <= left && left - fitted.tokens < 10,
        `the tally of ${left} is the size of the state as sent, ${fitted.tokens}`,
      ).toBe(true)
      expect(() => fitAt(left - 1)).toThrow(
        `about ${left} tokens are left after every reduction and ${left - 1} are allowed`,
      )
    },
  )

  test('error: a budget nothing can reach says how far it got', () => {
    expect(() => fit(50)).toThrow(
      /^the conversation does not fit the state budget: about \d+ tokens are left after every reduction and 50 are allowed$/,
    )
  })
})

describe('stateWithin under a cap in bytes', () => {
  const route = routeOf('decisionapi-net')
  const besideOf = (state: unknown) => bytesBesideOf(route, state)

  /**
   * Old messages of English prose: many letters to an estimated token, so
   * the state takes far more bytes than four a token.
   */
  function proseSession(): SessionMessage[] {
    const sentence =
      'The assistant reads the module again and compares the behaviour ' +
      'with what the specification describes before changing anything. '
    const messages = [said('refactor the parser')]

    for (let n = 1; n <= 12; n++) {
      messages.push(
        calling(sentence.repeat(12), [
          [`u${n}`, 'Read', { file_path: `src/f${n}.ts` }],
        ]),
        answering([[`u${n}`, 'x'.repeat(400)]]),
      )
    }

    messages.push(said('carry on'))

    return messages
  }

  function fitBytes(limit: number): Fitted {
    const messages = proseSession()

    return stateWithin(messages, pairCalls(messages, RECENT), {
      maxStateTokens: 1_000_000,
      preserveRecentMessages: RECENT,
      goal: 'refactor the parser',
      wire: BARE,
      bytes: { limit, besideOf },
    })
  }

  test('success: a letter-heavy state within its tokens is shrunk until its body fits the bytes', () => {
    const messages = proseSession()
    const whole = stateWithin(messages, pairCalls(messages, RECENT), {
      maxStateTokens: 1_000_000,
      preserveRecentMessages: RECENT,
      goal: 'refactor the parser',
      wire: BARE,
    })
    const wholeBytes = besideOf(whole.state)
    const limit = Math.floor(wholeBytes / 2)
    const fitted = fitBytes(limit)

    expect(whole.stage).toBe('whole')
    expect(
      wholeBytes > whole.tokens * 4,
      `${wholeBytes} bytes for ${whole.tokens} tokens`,
    ).toBe(true)
    expect(fitted.stage).not.toBe('whole')
    expect(
      besideOf(fitted.state) <= limit,
      `${besideOf(fitted.state)} bytes against ${limit}`,
    ).toBe(true)
  })

  test('success: an ample byte budget changes nothing', () => {
    const messages = proseSession()
    const calls = pairCalls(messages, RECENT)
    const need = {
      maxStateTokens: 3000,
      preserveRecentMessages: RECENT,
      goal: 'refactor the parser',
      wire: BARE,
    }

    expect(
      stateWithin(messages, calls, {
        ...need,
        bytes: { limit: 10_000_000, besideOf },
      }),
    ).toEqual(stateWithin(messages, calls, need))
  })

  test('success: a shrinking byte budget gives up detail in the order the token budget does', () => {
    const seen: Stage[] = []

    for (let limit = 60_000; limit >= 2_000; limit -= 500) {
      let stage: Stage

      try {
        stage = fitBytes(limit).stage
      } catch {
        break
      }

      if (seen.at(-1) !== stage) {
        seen.push(stage)
      }
    }

    expect(seen.length >= 3, seen.join(', ')).toBe(true)
    expect(
      seen.map(stage => ORDER.indexOf(stage)),
      seen.join(', '),
    ).toEqual(
      seen.map(stage => ORDER.indexOf(stage)).sort((a, b) => a - b),
    )
  })

  test('error: a byte budget nothing can reach says how far it got in bytes', () => {
    expect(() => fitBytes(50)).toThrow(
      /^the conversation does not fit the request body: about \d+ bytes are left after every reduction and 50 are allowed$/,
    )
  })
})
