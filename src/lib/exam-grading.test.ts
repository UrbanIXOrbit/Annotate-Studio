import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeExam, isAnswerCorrect, type GradableQuestion } from './exam-grading.ts';

const question = (over: Partial<GradableQuestion> = {}): GradableQuestion => ({
  type: 'verbal',
  correctAnswer: 'Attention',
  ...over,
});

test('multiple-choice grading is exact', () => {
  assert.equal(isAnswerCorrect(question({ type: 'multiple-choice', correctAnswer: 'B', userAnswer: 'B' })), true);
  assert.equal(isAnswerCorrect(question({ type: 'multiple-choice', correctAnswer: 'B', userAnswer: 'b' })), false);
});

test('verbal grading ignores case, punctuation and extra whitespace', () => {
  assert.equal(isAnswerCorrect(question({ userAnswer: '  attention! ' })), true);
  assert.equal(isAnswerCorrect(question({ correctAnswer: 'Long-term memory', userAnswer: 'long term, memory' })), true);
  assert.equal(isAnswerCorrect(question({ userAnswer: 'memory' })), false);
  assert.equal(isAnswerCorrect(question({ userAnswer: '' })), false);
});

test('an explicit verdict overrides the answer', () => {
  assert.equal(isAnswerCorrect(question({ userAnswer: 'wrong', verdict: 'correct' })), true);
  assert.equal(isAnswerCorrect(question({ userAnswer: 'Attention', verdict: 'incorrect' })), false);
});

test('gradeExam handles empty and partially answered exams', () => {
  assert.deepEqual(gradeExam([]), { score: 0, total: 0, percentage: 0 });
  assert.deepEqual(
    gradeExam([
      question({ userAnswer: 'Attention' }),
      question({ userAnswer: 'wrong' }),
      question({ type: 'multiple-choice', correctAnswer: 'A', userAnswer: 'A' }),
    ]),
    { score: 2, total: 3, percentage: 67 },
  );
});
