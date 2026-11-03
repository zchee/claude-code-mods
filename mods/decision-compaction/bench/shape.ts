/**
 * What a session looks like right before a compaction, in figures measured
 * on one project's transcripts. The generator builds a session to these.
 */
export type Shape = {
  /** How many compactions the figures come from. */
  compactions: number
  /** Tool calls between two compaction boundaries. */
  calls: { median: number; p10: number; p90: number }
  /** The median length of the assistant text that goes with one call. */
  assistantCharsPerCall: number
  /**
   * The median length of a segment's tool input JSON divided by the median
   * calls of a segment: about what one call's input takes.
   */
  inputCharsPerCall: number
  /** The median and the 90th percentile of a tool result's length. */
  resultMedian: number
  resultP90: number
  /**
   * The share of the calls each of the most used tools made, as fractions
   * of the calls of the tools listed.
   */
  toolShares: Readonly<Record<string, number>>
}

/**
 * The measured shapes, by project. A project is added by adding its figures
 * here; the generator reads nothing else.
 *
 * The test runner loads only code files, so the figures live in a module
 * rather than in a JSON file next to it.
 */
export const SHAPES = {
  measuredAt: '2026-11-03',
  source:
    "this machine's Claude Code transcripts, main chain between compaction boundaries",
  projects: {
    'ai-gateway': {
      compactions: 167,
      calls: { median: 55, p10: 2, p90: 228 },
      assistantCharsPerCall: 116,
      inputCharsPerCall: 1456,
      resultMedian: 1074,
      resultP90: 6232,
      toolShares: {
        Bash: 0.6969,
        SendMessage: 0.1383,
        Agent: 0.086,
        Read: 0.0323,
        Write: 0.025,
        AskUserQuestion: 0.014,
        Edit: 0.0075,
      },
    },
    'ganja-code': {
      compactions: 101,
      calls: { median: 22, p10: 4, p90: 348 },
      assistantCharsPerCall: 56,
      inputCharsPerCall: 1526,
      resultMedian: 629,
      resultP90: 6382,
      toolShares: {
        Bash: 0.6305,
        Edit: 0.1291,
        SendMessage: 0.0794,
        Read: 0.0627,
        Agent: 0.0444,
        Write: 0.0357,
        Grep: 0.0182,
      },
    },
  },
} as const satisfies {
  measuredAt: string
  source: string
  projects: Readonly<Record<string, Shape>>
}
