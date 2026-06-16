const fs = require("fs");
const path = require("path");

function walk(dir, files = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (!["node_modules", ".git"].includes(name)) walk(p, files);
    } else if (name.endsWith(".html")) {
      files.push(p);
    }
  }
  return files;
}

const root = path.join(__dirname, "../../public");
let count = 0;

for (const file of walk(root)) {
  let html = fs.readFileSync(file, "utf8");
  let next = html;

  next = next.replace(/src="\.\.\/images\/logo\.png"/g, 'src="/images/logo.svg"');
  next = next.replace(/src="\.\/images\/logo\.png"/g, 'src="/images/logo.svg"');
  next = next.replace(/src="\/images\/logo\.png"/g, 'src="/images/logo.svg"');

  next = next.replace(
    /<button onclick="applyTheme\('light'\)"/g,
    '<button type="button" data-theme="light"'
  );
  next = next.replace(
    /<button onclick="applyTheme\('dark'\)"/g,
    '<button type="button" data-theme="dark"'
  );

  next = next.replace(/href="\.\.\/index\.html"/g, 'href="/index.html"');
  next = next.replace(/href="\.\/index\.html"/g, 'href="/index.html"');

  if (next !== html) {
    fs.writeFileSync(file, next);
    count++;
    console.log(path.relative(root, file));
  }
}

console.log("updated", count, "html files");
