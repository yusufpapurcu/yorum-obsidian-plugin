/**
 * One-click requests. Each maps to the question shown in the thread (what the user "said") and an
 * instruction the model gets for that turn only. Born from real usage: users kept typing
 * "try other ways to visually explain it", "is there anything you disagree with?", etc.
 */
export const ACTIONS = {
  explain: {
    label: "Explain",
    question: "Explain this.",
    instruction: "Explain the passage clearly from first principles, with one concrete example.",
    fast: true,
  },
  simplify: {
    label: "Simplify",
    question: "Explain this like I'm new to it.",
    instruction:
      "Explain for a smart beginner: plain words, one everyday analogy, no jargon. Shorter than usual.",
    fast: true,
  },
  challenge: {
    label: "Challenge me",
    question: "Where could I be wrong here?",
    instruction:
      "Act as a respectful but honest critic. Name the weakest claim or hidden assumption in the passage, say concretely why it may be wrong, and give the strongest counter-view. Do not soften this into agreement.",
  },
  visualize: {
    label: "Visualize",
    question: "Explain this visually.",
    instruction:
      "Answer mainly with exactly one visual (whichever of the visual formats above fits best) and at most two sentences of text.",
  },
  angle: {
    label: "Another angle",
    question: "Show me another angle on this.",
    instruction:
      "Give a perspective clearly different from the earlier comments in this thread and from the obvious reading. If an earlier answer used a visual, use a different kind of visual.",
  },
} as const satisfies Record<string, ActionSpec>;

export interface ActionSpec {
  label: string;
  question: string;
  instruction: string;
  /** Plain explanations don't need deep reasoning: answer with the faster thinking level. */
  fast?: boolean;
}

export type ActionId = keyof typeof ACTIONS;

export const isAction = (value: unknown): value is ActionId =>
  typeof value === "string" && Object.hasOwn(ACTIONS, value);

/** Lens value meaning "pick a fitting framework from another field for me". */
export const AUTO_LENS = "auto";

/** Suggested lenses shown in the UI; any free text works too. */
export const LENS_PRESETS = [
  "C.S. Holling's Adaptive Cycle",
  "Systems thinking (stocks, flows, feedback loops)",
  "Evolution by natural selection",
  "Thermodynamics and entropy",
  "Game theory",
  "Stoicism",
  "Control theory (feedback and setpoints)",
];

/**
 * Concept-bridging instructions: explain the user's idea through a framework from another field,
 * with an explicit mapping, the insight it reveals, and where the analogy breaks.
 */
export function lensInstruction(lens: string): string {
  const steps =
    "1) one line on why this lens fits; 2) map each key element of the user's idea onto an element of the lens explicitly, preferably as a visual (a diagram or a step-by-step sketch) or a compact table; 3) one insight the mapping reveals that the user's own framing hides; 4) where the analogy breaks.";
  if (lens === AUTO_LENS) {
    return `Explain the user's idea through the lens of one well-established framework from a clearly different field (ecology, physics, biology, economics, game theory, control theory, philosophy…). Prefer the most precise fit over the most famous one, and name it with its originator, e.g. "C.S. Holling's Adaptive Cycle". Start your comment with a line "**Lens:** <framework>". Then: ${steps}`;
  }
  return `Explain the user's idea through the lens of ${lens}. Start your comment with a line "**Lens:** ${lens}". Then: ${steps}`;
}

/** The framework the model announced with its "**Lens:** …" line, if any. */
export function detectLens(content: string): string | null {
  const m = /^\s*\*\*Lens:\*\*\s*(.+?)\s*$/m.exec(content);
  return m ? m[1].replace(/[*_.]+$/g, "").trim() : null;
}
