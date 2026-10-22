// The toolbar popup, used only on pages the in-page dialog can't open in (arc:// and chrome:// pages, the Web Store).
const style = document.createElement("style");
style.textContent = NerdfaderPanel.css;
document.head.append(style);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
NerdfaderPanel.mount(document.querySelector(".panel"), { tabId: tab?.id, url: tab?.url });
