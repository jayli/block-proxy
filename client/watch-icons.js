const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "icons");
const SOURCES = ["socks_on_G.png", "socks_on_M.png"];

function resize(source) {
  const name = path.basename(source, ".png");
  const dest = path.join(ICONS_DIR, `${name}_bar.png`);
  execSync(`sips -z 40 39 "${source}" --out "${dest}"`, { stdio: "ignore" });
  console.log(`${new Date().toLocaleTimeString()}  regenerated ${name}_bar.png`);
}

function regenAll() {
  SOURCES.forEach((f) => resize(path.join(ICONS_DIR, f)));
}

const cmd = process.argv[2];
if (cmd === "--watch") {
  console.log("Watching icons for changes...");
  regenAll();
  SOURCES.forEach((f) => {
    const filePath = path.join(ICONS_DIR, f);
    fs.watch(filePath, (eventType) => {
      if (eventType === "change") resize(filePath);
    });
  });
} else {
  regenAll();
}
