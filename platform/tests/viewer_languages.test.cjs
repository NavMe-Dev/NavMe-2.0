const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

test("public viewer offers every shipped locale instead of venue-only languages", () => {
  const boot = fs.readFileSync(path.join(ROOT, "viewer", "wf-boot.js"), "utf8");
  const i18n = fs.readFileSync(path.join(ROOT, "locales", "i18n.js"), "utf8");
  const localeFiles = fs.readdirSync(path.join(ROOT, "locales"))
    .filter(name => /^[a-z]{2}\.json$/.test(name))
    .map(name => name.slice(0, 2))
    .sort();

  assert.match(boot, /WFi18n\.catalog\.map\(item => item\.code\)/);
  assert.doesNotMatch(boot, /br\.enabled_languages\s*\|\|\s*br\.enabledLanguages/);
  for (const code of localeFiles) {
    assert.match(i18n, new RegExp(`code: ["']${code}["']`), `${code} is missing from the language catalog`);
  }
});
