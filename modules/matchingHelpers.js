function hasVerifiedTeachSkill(user) {
  const verified = user?.verifiedSkills || [];
  const teach = user?.teachSkills || [];
  return teach.some((s) => verified.includes(s));
}

function isBidirectionalMatch(currentUser, candidate) {
  const canTeachMe = (candidate.teachSkills || []).some((s) =>
    (currentUser.learnSkills || []).includes(s)
  );
  const canLearnFrom = (candidate.learnSkills || []).some((s) =>
    (currentUser.teachSkills || []).includes(s)
  );
  return canTeachMe && canLearnFrom;
}

function calcMatchScore(currentUser, user) {
  const uVerified = user.verifiedSkills || [];
  const myVerified = currentUser.verifiedSkills || [];
  const learnM = user.teachSkills.filter((s) => currentUser.learnSkills.includes(s)).length;
  const teachM = user.learnSkills.filter((s) => currentUser.teachSkills.includes(s)).length;
  const learnMV = user.teachSkills.filter(
    (s) => currentUser.learnSkills.includes(s) && uVerified.includes(s)
  ).length;
  const teachMV = user.learnSkills.filter(
    (s) => currentUser.teachSkills.includes(s) && myVerified.includes(s)
  ).length;
  const total = currentUser.learnSkills.length + currentUser.teachSkills.length || 1;
  return Math.min(
    100,
    Math.round(((learnM + teachM + learnMV + teachMV) / (total * 2)) * 100) ||
      Math.round(((learnM + teachM) / total) * 100)
  );
}

module.exports = { hasVerifiedTeachSkill, isBidirectionalMatch, calcMatchScore };
