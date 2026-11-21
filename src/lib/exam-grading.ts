/** Pure exam grading, shared by the store and the tests. */

export interface GradableQuestion {
  type: 'multiple-choice' | 'verbal';
  correctAnswer: string;
  userAnswer?: string;
  verdict?: 'correct' | 'incorrect';
}

function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[\s.,;:!?'"()-]+/g, ' ').trim();
}

export function isAnswerCorrect(question: GradableQuestion): boolean {
  if (question.verdict) return question.verdict === 'correct';
  const answer = question.userAnswer?.trim();
  if (!answer) return false;
  if (question.type === 'multiple-choice') return answer === question.correctAnswer.trim();
  return normalizeAnswer(answer) === normalizeAnswer(question.correctAnswer);
}

export function gradeExam(questions: GradableQuestion[]): { score: number; total: number; percentage: number } {
  const total = questions.length;
  const score = questions.filter(isAnswerCorrect).length;
  return { score, total, percentage: total === 0 ? 0 : Math.round((score / total) * 100) };
}
