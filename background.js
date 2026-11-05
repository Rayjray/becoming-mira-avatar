// Avatar-variant: klein venster met alleen het bolletje; popup.js maakt het
// groter als Jack groot in beeld komt.
browser.browserAction.setPopupStyles({
  backgroundColor: "#FFFFFF00",
  borderRadius: "20px",
});
browser.browserAction.resizePopup(230, 260);
browser.browserAction.setPopupPosition({ bottom: "30px", right: "30px" });
browser.browserAction.detachPopup();
browser.browserAction.openPopup(true);
