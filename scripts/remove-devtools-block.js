const fs = require("fs");
const path = require("path");

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, files);
    } else if (name.endsWith(".js") && name !== "all.min.js") {
      files.push(p);
    }
  }
  return files;
}

const root = path.join(__dirname, "../../public");
const block =
  /document\.addEventListener\("contextmenu"[\s\S]*?document\.addEventListener\("keydown"[\s\S]*?\}\);\s*/g;

let count = 0;
for (const file of walk(root)) {
  const src = fs.readFileSync(file, "utf8");
  if (!block.test(src)) continue;
  const next = src.replace(block, "");
  if (next !== src) {
    fs.writeFileSync(file, next);
    count++;
    console.log("cleaned", path.relative(root, file));
  }
}
console.log("done", count, "files");
