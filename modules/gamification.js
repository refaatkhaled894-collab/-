function computeGamification(user) {
  const reviews = user?.reviews || [];
  const helped = reviews.length;
  const teachCount = (user?.teachSkills || []).length;
  const verifiedCount = (user?.verifiedSkills || []).length;
  const points =
    (user?.gamifyPoints != null && user.gamifyPoints > 0
      ? user.gamifyPoints
      : teachCount * 50 + verifiedCount * 25 + helped * 10);

  let level = user?.gamifyLevel || "عضو جديد";
  if (!user?.gamifyLevel) {
    if (points > 600) level = "أسطورة شارك";
    else if (points > 300) level = "معلّم خبير";
    else if (points > 100) level = "متعلم نشيط";
  }

  return { points, level, helped };
}

function pointsForNewReview(user, rating) {
  const r = Number(rating) || 5;
  return 10 + Math.min(10, Math.max(0, r - 3) * 2);
}

module.exports = { computeGamification, pointsForNewReview };
