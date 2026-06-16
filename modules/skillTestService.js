const jwt = require("jsonwebtoken");
const { pickQuestions } = require("./skillQuestionBank");
const {
  SKILL_TEST_QUESTION_COUNT,
  SKILL_TEST_PASS_PCT,
  SKILL_TEST_MIN_PASS_SCORE,
} = require("./skillTestRules");

const SESSION_TTL_SEC = 15 * 60; // 15 minutes per attempt

function createSkillTestSession(jwtSecret, userId, skill) {
  const picked = pickQuestions(skill, SKILL_TEST_QUESTION_COUNT);
  if (!picked.length) {
    return { ok: false, error: "لا توجد أسئلة لهذه المهارة" };
  }

  const answerKey = picked.map((q) => q.ans);
  const sessionToken = jwt.sign(
    {
      type: "skill_test",
      userId: String(userId),
      skill: skill.trim(),
      answerKey,
      startedAt: Date.now(),
    },
    jwtSecret,
    { expiresIn: SESSION_TTL_SEC }
  );

  const questions = picked.map((q) => ({
    q: q.q,
    opts: [...q.opts],
  }));

  return {
    ok: true,
    sessionToken,
    questions,
    total: questions.length,
    expiresInSec: SESSION_TTL_SEC,
  };
}

function gradeSkillTestSubmission(jwtSecret, userId, { sessionToken, answers, skill }) {
  if (!sessionToken || !Array.isArray(answers)) {
    return { ok: false, error: "بيانات الاختبار غير مكتملة" };
  }

  let decoded;
  try {
    decoded = jwt.verify(sessionToken, jwtSecret);
  } catch {
    return { ok: false, error: "انتهت صلاحية جلسة الاختبار، أعد المحاولة" };
  }

  if (decoded.type !== "skill_test" || String(decoded.userId) !== String(userId)) {
    return { ok: false, error: "جلسة اختبار غير صالحة" };
  }

  const sessionSkill = (decoded.skill || "").trim();
  if (skill && skill.trim() !== sessionSkill) {
    return { ok: false, error: "المهارة لا تطابق جلسة الاختبار" };
  }

  const answerKey = decoded.answerKey || [];
  if (answers.length !== answerKey.length) {
    return { ok: false, error: "عدد الإجابات لا يطابق عدد الأسئلة" };
  }

  let score = 0;
  for (let i = 0; i < answerKey.length; i++) {
    const chosen = Number(answers[i]);
    const expected = Number(answerKey[i]);
    if (
      Number.isInteger(chosen) &&
      Number.isInteger(expected) &&
      chosen >= 0 &&
      chosen === expected
    ) {
      score++;
    }
  }

  const total = answerKey.length;
  const pct = Math.round((score / total) * 100);
  const passed = score >= SKILL_TEST_MIN_PASS_SCORE && pct >= SKILL_TEST_PASS_PCT;

  return {
    ok: true,
    skill: sessionSkill,
    score,
    total,
    pct,
    passed,
  };
}

module.exports = { createSkillTestSession, gradeSkillTestSubmission };
