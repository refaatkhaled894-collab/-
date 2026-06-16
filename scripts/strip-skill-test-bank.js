const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "../../public/login-signup/skill-test.js");
let src = fs.readFileSync(filePath, "utf8");
const start = src.indexOf("const questionBank =");
const end = src.indexOf("// ── الحالة");
if (start < 0 || end < 0) {
  console.error("markers not found", start, end);
  process.exit(1);
}

const header = `/* ══════════════════════════════════════
   شريك – اختبار المهارات (تصحيح على السيرفر)
   ══════════════════════════════════════ */

let sessionToken = null;
let userAnswers = [];

async function fetchAvailableSkills() {
  const skills = new Set();
  try {
    const token = localStorage.getItem("token");
    const res = await fetch(apiUrl("/api/skill-test/skills"), {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    if (res.ok) {
      const data = await res.json();
      (data.skills || []).forEach((s) => skills.add(s));
    }
  } catch (e) {}
  try {
    const user = JSON.parse(localStorage.getItem("currentUser") || "{}");
    [...(user.teachSkills || []), ...(user.learnSkills || [])].forEach((s) =>
      skills.add(s)
    );
  } catch (e) {}
  return [...skills];
}

`;

fs.writeFileSync(filePath, src.slice(0, start) + header + src.slice(end));
console.log("stripped question bank from skill-test.js");
