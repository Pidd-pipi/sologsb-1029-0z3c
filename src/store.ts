import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type { Lesson, MistakeEntry, PersistedState, PracticeAttempt } from './types';
import { normalizeToken } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

// “记住了”的复习间隔，按掌握次数逐级拉长。
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 15, 30];

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.schemaVersion === 1) {
        // 旧版本存档没有错词档案，补上空表后由 rebuildMistakes 从历史作答回填。
        parsed.mistakes ??= {};
        return parsed;
      }
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

// 合并历次作答里的错词：按词归并错误次数、最近写法和出处，
// 同时保留已有复习排期；复习之后再次出错会重新变为到期。
export function rebuildMistakes() {
  const previous = state.mistakes ?? {};
  const nowIso = new Date().toISOString();
  const merged: Record<string, MistakeEntry> = {};
  const chronological = [...state.attempts].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const attempt of chronological) {
    attempt.sentenceAttempts.forEach((sentenceAttempt, sentenceIndex) => {
      for (const token of sentenceAttempt.tokens) {
        if (token.correct || !token.expected) continue;
        const key = normalizeToken(token.expected);
        if (!key) continue;
        const carried = merged[key] ?? previous[key];
        const entry: MistakeEntry = {
          id: key,
          word: token.expected,
          normalized: key,
          errorCount: (merged[key]?.errorCount ?? 0) + 1,
          lastActual: token.actual,
          source: `${attempt.courseTitle} · ${attempt.lessonTitle} 第${sentenceIndex + 1}句`,
          lessonId: attempt.lessonId,
          sentenceId: sentenceAttempt.sentenceId,
          sentenceText: sentenceAttempt.source,
          category: token.category,
          reviewCount: carried?.reviewCount ?? 0,
          lastReviewedAt: carried?.lastReviewedAt ?? '',
          dueAt: carried?.dueAt ?? nowIso,
          updatedAt: attempt.submittedAt
        };
        if (carried?.lastReviewedAt && attempt.submittedAt > carried.lastReviewedAt) {
          entry.dueAt = nowIso;
        }
        merged[key] = entry;
      }
    });
  }
  state.mistakes = merged;
}

export function markMistakeRemembered(id: string) {
  const entry = state.mistakes[id];
  if (!entry) return;
  entry.reviewCount += 1;
  entry.lastReviewedAt = new Date().toISOString();
  const days = REVIEW_INTERVALS_DAYS[Math.min(entry.reviewCount - 1, REVIEW_INTERVALS_DAYS.length - 1)];
  entry.dueAt = new Date(Date.now() + days * 86_400_000).toISOString();
}

export function markMistakeAgain(id: string) {
  const entry = state.mistakes[id];
  if (!entry) return;
  entry.lastReviewedAt = new Date().toISOString();
  entry.dueAt = entry.lastReviewedAt;
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
  rebuildMistakes();
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
  rebuildMistakes();
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    attempts: state.attempts,
    mistakes: Object.values(state.mistakes),
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
  rebuildMistakes();
}

rebuildMistakes();
