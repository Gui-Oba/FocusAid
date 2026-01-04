/* 
January 2026
Chrome extension content script for blocking specified websites
and filtering Instagram feed posts based on a local allowlist.
*/

(() => {
  const BLOCKLIST_FILE = "blocklist.txt";
  let blocklist = new Set();

  //WEBSITE BLOCKER FUNCTIONS ************************************

  // Normalize a blocklist entry into a hostname or wildcard rule.
  function normalizeHost(raw) {
    if (!raw) return null;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed.includes("://")) {
      try {
        return new URL(trimmed).hostname.toLowerCase();
      } catch {
        return null;
      }
    }
    return trimmed.replace(/\/.*$/, "");
  }

  // Check whether a hostname matches any blocklist entry (exact or wildcard).
  function isBlockedHost(hostname) {
    const host = (hostname || "").toLowerCase();
    if (!host) return false;
    if (blocklist.has(host)) return true;
    for (const entry of blocklist) {
      if (entry.startsWith("*.")) {
        const suffix = entry.slice(1);
        if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
      } else if (entry.startsWith(".")) {
        if (host === entry.slice(1) || host.endsWith(entry)) return true;
      }
    }
    return false;
  }

  // Replace the page with a full-screen blocked message.
  function showBlockScreen(hostname) {
    const blocker = document.createElement("div");
    blocker.textContent = `${hostname} is blocked. Are you spending your time intentionally?`;
    blocker.style.cssText = `
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0b0b0b;
      color: #f5f5f5;
      font: 600 20px/1.4 "Helvetica Neue", Arial, sans-serif;
      z-index: 2147483647;
      text-align: center;
    `;
    document.documentElement.innerHTML = "";
    document.documentElement.appendChild(blocker);
    document.title = "Blocked";
  }

  // Load and parse blocklist.txt into a Set.
  async function loadBlocklistFromFile() {
    const url = chrome.runtime.getURL(BLOCKLIST_FILE);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const text = await response.text();
      const list = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map(normalizeHost)
        .filter(Boolean);
      blocklist = new Set(list);
    } catch (error) {
      console.warn("Blocklist file read failed", url, error);
      blocklist = new Set();
    }
  }

  //INSTAGRAM ALLOWLIST FUNCTIONS ********************************

  // Early CSS to reduce flicker before DOM is fully built.
  const preStyle = document.createElement("style");
  preStyle.textContent = `
    a[href^="/reels/"],
    a[href^="/explore/"],
    a[href^="/stories/"],
    [data-pagelet="story_tray"],
    .x1dr59a3.x13vifvy.x7vhb2i.x6bx242 {
      display: none !important;
    }
  `;
  document.documentElement.appendChild(preStyle);

  const PROCESSED_ATTR = "data-ig-allowlist-processed";
  const HIDDEN_ATTR = "data-ig-allowlist-hidden";
  const UNKNOWN_ATTR = "data-ig-allowlist-unknown";

  let allowlist = new Set();
  let pendingFlush = null;

  // Normalize IG usernames for allowlist matching.
  function normalizeUsername(raw) {
    if (!raw) return null;
    return raw.toLowerCase().replace(/^@+/, "").trim();
  }

  // Load and parse allowlist.txt into a Set.
  async function loadAllowlistFromFile() {
    const url = chrome.runtime.getURL("allowlist.txt");
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const text = await response.text();
      const list = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map(normalizeUsername)
        .filter(Boolean);
      allowlist = new Set(list);
    } catch (error) {
      console.warn("IG allowlist file read failed", url, error);
      allowlist = new Set();
    }
  }

  // Instagram DOM shifts often. We use common roles/tags to find feed posts.
  // If feed detection breaks, update the selectors in getPostElements.
  // Find likely feed post containers within the given root.
  function getPostElements(root = document) {
    // Instagram sometimes uses <article> or div[role="article"] for feed items.
    const articles = Array.from(root.querySelectorAll("article, div[role='article']"));
    return articles.filter((article) => {
      const isFeedPost = article.querySelector("a[href^='/' i]");
      return Boolean(isFeedPost);
    });
  }

  // Attempt to extract the author username from a feed post element.
  function extractUsernameFromPost(article) {
    // Best-effort: find profile links; avoid post/reel/story URLs.
    const exclude = new Set([
      "p",
      "reel",
      "stories",
      "explore",
      "accounts",
      "about",
      "legal",
      "direct",
      "developer",
      "press",
      "privacy",
      "terms"
    ]);

    const links = Array.from(article.querySelectorAll("a[href^='/' i]"));
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;
      if (href.startsWith("/p/") || href.startsWith("/reel/") || href.startsWith("/stories/")) {
        continue;
      }
      const match = href.match(/^\/([^/?#]+)\/?/);
      if (!match || !match[1]) continue;
      const segment = match[1];
      if (exclude.has(segment.toLowerCase())) continue;
      return normalizeUsername(segment);
    }
    return null;
  }

  // Hide a post and mark it with state attributes.
  function hidePost(article, username) {
    article.style.display = "none";
    article.setAttribute(HIDDEN_ATTR, "1");
    if (!username) {
      article.setAttribute(UNKNOWN_ATTR, "1");
    } else {
      article.removeAttribute(UNKNOWN_ATTR);
    }
  }

  // Reveal a previously hidden post and clear state attributes.
  function revealPost(article) {
    article.style.display = "";
    article.removeAttribute(HIDDEN_ATTR);
    article.removeAttribute(UNKNOWN_ATTR);
  }

  // Apply allowlist filtering to a single post.
  function processPost(article) {
    if (article.hasAttribute(PROCESSED_ATTR)) return;
    article.setAttribute(PROCESSED_ATTR, "1");

    const username = extractUsernameFromPost(article);
    if (!username) {
      hidePost(article, username);
      return;
    }

    if (allowlist.has(username)) {
      revealPost(article);
      return;
    }

    hidePost(article, username);
  }

  // Hide stories tray containers when present.
  function hideStoriesTray(root = document) {
    // Stories tray can move; hide the nearest container to any /stories/ link.
    const storyLink = root.querySelector("a[href^='/stories/']");
    if (!storyLink) return;
    const container =
      storyLink.closest("section") ||
      storyLink.closest("div[role='presentation']") ||
      storyLink.closest("ul") ||
      storyLink.closest("div");
    if (container) {
      container.style.display = "none";
    }
    // Also hide any explicit Stories tray by aria-label.
    root
      .querySelectorAll("[aria-label*='Stories' i]")
      .forEach((node) => (node.style.display = "none"));

    root
      .querySelectorAll("[data-pagelet='story_tray']")
      .forEach((node) => (node.style.display = "none"));
  }

  // Remove "Suggested for you" sections.
  function removeSuggestedForYou(root = document) {
    const headers = Array.from(root.querySelectorAll("div, span, h2, h3")).filter(
      (node) =>
        node.textContent &&
        node.textContent.trim().toLowerCase() === "suggested for you"
    );

    headers.forEach((header) => {
      const container = header.closest("div") || header.parentElement;
      if (!container) return;
      container.style.display = "none";
    });
  }

  // Insert a spacer to prevent "Suggested posts" from appearing.
  function addSuggestedPostsBlocker(root = document) {
    const headers = Array.from(root.querySelectorAll("div, span, h2, h3")).filter(
      (node) => node.textContent && node.textContent.trim().toLowerCase() === "suggested posts"
    );

    headers.forEach((header) => {
      const container = header.closest("div") || header.parentElement;
      if (!container || container.querySelector(".ig-suggested-blocker")) return;
      const blocker = document.createElement("div");
      blocker.className = "ig-suggested-blocker";
      blocker.style.width = "100%";
      blocker.style.height = "1200px";
      blocker.style.margin = "12px 0";
      container.insertBefore(blocker, container.firstChild);
    });
  }

  // // Hide "Suggested accounts" sections.
  // function removeSuggestedAccounts(root = document) {
  //   const labels = new Set(["suggested accounts", "suggested for you"]);
  //   const headers = Array.from(root.querySelectorAll("div, span, h2, h3")).filter(
  //     (node) =>
  //       node.textContent &&
  //       labels.has(node.textContent.trim().toLowerCase())
  //   );

  //   headers.forEach((header) => {
  //     const container = header.closest("div") || header.parentElement;
  //     if (!container) return;
  //     container.style.display = "none";
  //   });
  // }

  // Run all IG filtering and hiding routines for the current DOM.
  function processAll(root = document) {
    // Retry username extraction for previously unknown posts.
    const unknownPosts = root.querySelectorAll(
      `article[${UNKNOWN_ATTR}], div[role='article'][${UNKNOWN_ATTR}]`
    );
    unknownPosts.forEach((article) => article.removeAttribute(PROCESSED_ATTR));
    const posts = getPostElements(root);
    posts.forEach(processPost);
    hideStoriesTray(root);
    removeSuggestedForYou(root);
    addSuggestedPostsBlocker(root);
    hideRightThirdHome(root);
  }

  // Debounce DOM updates to avoid thrashing.
  function debounceProcess() {
    if (pendingFlush) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      processAll();
    }, 200);
  }

  // Watch for DOM changes and re-run processing.
  function installObserver() {
    const observer = new MutationObserver(debounceProcess);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  (async () => {
    await loadBlocklistFromFile();
    if (isBlockedHost(location.hostname)) {
      showBlockScreen(location.hostname);
      return;
    }
    if (location.hostname !== "www.instagram.com") {
      return;
    }
    await loadAllowlistFromFile();
    processAll();
    installObserver();
  })();

  // Hide the right-most column on the IG home layout.
  function hideRightThirdHome(root = document) {
    if (location.pathname !== "/" && location.pathname !== "/home/") {
      return;
    }
    const main = root.querySelector("main");
    if (!main) return;
    const cutoff = window.innerWidth * 0.66;
    const candidates = Array.from(main.children);
    candidates.forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.left >= cutoff && rect.width > 0 && rect.height > 0) {
        node.style.display = "none";
      }
    });

    root
      .querySelectorAll(".x1dr59a3.x13vifvy.x7vhb2i.x6bx242")
      .forEach((node) => (node.style.display = "none"));
  }

  // Hide left nav entries for Reels and Explore on desktop layout.
  const style = document.createElement("style");
  style.textContent = `
    a[href^="/reels/"],
    a[href^="/explore/"] {
      display: none !important;
    }

    /* Hide stories tray (defensive selectors; may need updates as IG DOM changes). */
    a[href^="/stories/"] {
      display: none !important;
    }

    section[role="presentation"] ul {
      display: none !important;
    }

    [data-pagelet="story_tray"] {
      display: none !important;
    }

    .ig-suggested-blocker {
      display: block;
    }

  `;
  document.documentElement.appendChild(style);
})();
