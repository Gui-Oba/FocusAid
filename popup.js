const listEl = document.getElementById("allowlist");
const emptyEl = document.getElementById("empty");
const refreshBtn = document.getElementById("refresh-btn");

function normalizeUsername(raw) {
  if (!raw) return null;
  return raw.toLowerCase().replace(/^@+/, "").trim();
}

async function getAllowlistFromFile() {
  const url = chrome.runtime.getURL("allowlist.txt");
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const text = await response.text();
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(normalizeUsername)
      .filter(Boolean);
  } catch (error) {
    console.warn("Allowlist file read failed", url, error);
    return [];
  }
}

function render(list) {
  listEl.innerHTML = "";
  const sorted = [...new Set(list)].sort();

  if (!sorted.length) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";

  sorted.forEach((username) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `@${username}`;
    row.appendChild(name);
    listEl.appendChild(row);
  });
}

async function refresh() {
  const list = await getAllowlistFromFile();
  render(list);
}

refreshBtn.addEventListener("click", refresh);
refresh();
