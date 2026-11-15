// Product copy shares the desktop dictionary. User subtitles and filenames are excluded.
let dictionary = {};
export function t(text) { return dictionary[text] ?? text; }
export async function initCopy() {
  try { dictionary = await (await fetch('./lang/zh-CN.json')).json(); } catch { /* Original copy remains usable offline. */ }
  const translate = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script,style,textarea,input,[data-user-content]')) continue;
      const raw = node.nodeValue, key = raw.trim();
      if (dictionary[key] != null && dictionary[key] !== key) node.nodeValue = raw.replace(key, dictionary[key]);
    }
  };
  translate(document.body);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') {
        if (!record.target.parentElement?.closest('script,style,textarea,input,[data-user-content]')) {
          const raw = record.target.nodeValue, key = raw.trim();
          if (dictionary[key] != null && dictionary[key] !== key) record.target.nodeValue = raw.replace(key, dictionary[key]);
        }
      } else for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) translate(node);
        else if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest('[data-user-content]')) {
          const key = node.nodeValue.trim(); if (dictionary[key] != null && dictionary[key] !== key) node.nodeValue = node.nodeValue.replace(key, dictionary[key]);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
}
