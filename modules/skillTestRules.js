const SKILL_TEST_QUESTION_COUNT = 10;
const SKILL_TEST_PASS_PCT = 60;
const SKILL_TEST_MIN_PASS_SCORE = 6;

function validateSkillTestSubmission({ skill, score, total, passed, pct }) {
  if (!skill || typeof skill !== "string" || !skill.trim()) {
    return { ok: false, error: "المهارة مطلوبة" };
  }

  const numScore = Number(score);
  const numTotal = Number(total);
  if (!Number.isFinite(numScore) || !Number.isFinite(numTotal)) {
    return { ok: false, error: "نتيجة الاختبار غير صالحة" };
  }
  if (numTotal !== SKILL_TEST_QUESTION_COUNT) {
    return { ok: false, error: "عدد أسئلة الاختبار غير صالح" };
  }
  if (numScore < 0 || numScore > numTotal) {
    return { ok: false, error: "الدرجة خارج النطاق المسموح" };
  }

  const computedPct = Math.round((numScore / numTotal) * 100);
  const submittedPct = pct != null ? Math.round(Number(pct)) : computedPct;
  if (submittedPct !== computedPct) {
    return { ok: false, error: "نسبة النجاح لا تطابق الدرجة" };
  }

  const serverPassed = numScore >= SKILL_TEST_MIN_PASS_SCORE && computedPct >= SKILL_TEST_PASS_PCT;
  if (passed === true && !serverPassed) {
    return { ok: false, error: "لم يتم اجتياز الاختبار" };
  }
  if (passed === false && serverPassed) {
    return { ok: false, error: "حالة النجاح غير متسقة" };
  }

  return {
    ok: true,
    skill: skill.trim(),
    score: numScore,
    total: numTotal,
    pct: computedPct,
    passed: serverPassed,
  };
}

module.exports = {
  SKILL_TEST_QUESTION_COUNT,
  SKILL_TEST_PASS_PCT,
  SKILL_TEST_MIN_PASS_SCORE,
  validateSkillTestSubmission,
};
