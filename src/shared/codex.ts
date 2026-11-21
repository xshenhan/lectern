export interface CodexThreadSummary {
  id: string;
  title: string;
  /** Milliseconds since the Unix epoch. */
  updatedAt: number;
  status: 'idle' | 'working' | 'waiting' | 'error';
}

export interface CodexThread extends CodexThreadSummary {
  messages: { id: string; role: 'user' | 'assistant'; text: string }[];
  approvals: { id: string; title: string; detail: string }[];
  error?: string;
}

export interface CodexWorkspace {
  threads: CodexThreadSummary[];
  thread?: CodexThread;
  threadError?: string;
}

export type CodexDecision = 'accept' | 'decline';
