import type { PracticeAttempt, SentenceAttempt, TextSegment, TokenResult, WrongWord } from './types';

export const segmentText = (text: string): TextSegment[] => {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]+/gu) ?? [];
  return matches.map((display, index) => ({
    index,
    display,
    normalized: normalizeToken(display)
  }));
};

export const normalizeToken = (token: string): string => token
  .toLocaleLowerCase('en')
  .replaceAll('’', "'")
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function compareSentence(expected: string, answer: string): TokenResult[] {
  const expectedTokens = segmentText(expected);
  const actualTokens = segmentText(answer);
  const rows = expectedTokens.length + actualTokens.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(rows + 1).fill(0));
  const move = Array.from({ length: rows + 1 }, () => Array<string>(rows + 1).fill(''));

  for (let i = 0; i <= expectedTokens.length; i += 1) {
    table[i][0] = i;
    move[i][0] = 'delete';
  }
  for (let j = 0; j <= actualTokens.length; j += 1) {
    table[0][j] = j;
    move[0][j] = 'insert';
  }

  for (let i = 1; i <= expectedTokens.length; i += 1) {
    for (let j = 1; j <= actualTokens.length; j += 1) {
      const substitution = table[i - 1][j - 1] + (expectedTokens[i - 1].normalized === actualTokens[j - 1].normalized ? 0 : 1);
      const deletion = table[i - 1][j] + 1;
      const insertion = table[i][j - 1] + 1;
      table[i][j] = Math.min(substitution, deletion, insertion);
      move[i][j] = substitution <= deletion && substitution <= insertion
        ? 'match'
        : deletion <= insertion ? 'delete' : 'insert';
    }
  }

  const reversed: TokenResult[] = [];
  let i = expectedTokens.length;
  let j = actualTokens.length;
  while (i > 0 || j > 0) {
    const direction = move[i][j];
    if (direction === 'match' && i > 0 && j > 0) {
      const expectedToken = expectedTokens[i - 1];
      const actualToken = actualTokens[j - 1];
      const correct = expectedToken.normalized === actualToken.normalized;
      reversed.push({
        index: i - 1,
        expected: expectedToken.display,
        actual: actualToken.display,
        correct,
        category: correct ? 'unclassified' : 'spelling',
        reason: ''
      });
      i -= 1;
      j -= 1;
    } else if (direction === 'delete' && i > 0) {
      reversed.push({ index: i - 1, expected: expectedTokens[i - 1].display, actual: '', correct: false, category: 'omitted', reason: '' });
      i -= 1;
    } else if (j > 0) {
      reversed.push({ index: Math.max(0, i - 1), expected: '', actual: actualTokens[j - 1].display, correct: false, category: 'extra', reason: '' });
      j -= 1;
    } else {
      break;
    }
  }

  const result = reversed.reverse();
  return result.map((token, index) => ({ ...token, index }));
}

export function scoreAttempt(sentenceAttempts: SentenceAttempt[]): number {
  const totals = sentenceAttempts.flatMap((attempt) => attempt.tokens);
  if (!totals.length) return 0;
  const correct = totals.filter((token) => token.correct).length;
  return Math.max(0, Math.round((correct / totals.length) * 100));
}

// 记住一次就沿阶梯往后推一档：10 分钟 → 1 小时 → 1 天 → 3 天 → 7 天 → 15 天 → 30 天。
export const REVIEW_INTERVALS_MINUTES = [10, 60, 1440, 4320, 10080, 21600, 43200];

export const reviewIntervalLabel = (rememberedCount: number): string => {
  const minutes = REVIEW_INTERVALS_MINUTES[Math.min(rememberedCount, REVIEW_INTERVALS_MINUTES.length - 1)];
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1440)} 天`;
};

export const nextReviewDueAt = (rememberedCount: number, from = Date.now()): string => {
  const minutes = REVIEW_INTERVALS_MINUTES[Math.min(rememberedCount, REVIEW_INTERVALS_MINUTES.length - 1)];
  return new Date(from + minutes * 60000).toISOString();
};

function collectWrongWord(attempt: PracticeAttempt, sentenceId: string, token: TokenResult, pool: WrongWord[]) {
  const normalized = normalizeToken(token.expected);
  if (!normalized) return;
  const existing = pool.find((item) => item.id === normalized);
  if (existing) {
    existing.errorCount += 1;
    existing.word = token.expected;
    existing.lastActual = token.actual;
    existing.lastSeenAt = attempt.submittedAt;
    existing.source = {
      attemptId: attempt.id,
      lessonId: attempt.lessonId,
      lessonTitle: attempt.lessonTitle,
      courseTitle: attempt.courseTitle,
      sentenceId,
      sentence: attempt.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.source ?? ''
    };
    // 再次写错说明还没掌握，回到第一档并立即可练。
    existing.rememberedCount = 0;
    existing.dueAt = attempt.submittedAt;
    return;
  }
  pool.push({
    id: normalized,
    word: token.expected,
    errorCount: 1,
    lastActual: token.actual,
    lastSeenAt: attempt.submittedAt,
    source: {
      attemptId: attempt.id,
      lessonId: attempt.lessonId,
      lessonTitle: attempt.lessonTitle,
      courseTitle: attempt.courseTitle,
      sentenceId,
      sentence: attempt.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.source ?? ''
    },
    dueAt: attempt.submittedAt,
    rememberedCount: 0,
    createdAt: attempt.submittedAt
  });
}

export function mergeAttemptWrongWords(attempt: PracticeAttempt, pool: WrongWord[]) {
  for (const sentenceAttempt of attempt.sentenceAttempts) {
    for (const token of sentenceAttempt.tokens) {
      // 只收录应写而写错/漏写的词；多出来的词没有“正确写法”可练。
      if (token.correct || !token.expected) continue;
      collectWrongWord(attempt, sentenceAttempt.sentenceId, token, pool);
    }
  }
}

export function buildWrongWordsFromAttempts(attempts: PracticeAttempt[]): WrongWord[] {
  const pool: WrongWord[] = [];
  const ordered = [...attempts].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const attempt of ordered) mergeAttemptWrongWords(attempt, pool);
  return pool;
}
