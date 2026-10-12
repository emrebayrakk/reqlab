// Geliştirici araçlarına "ReqLab" paneli ekler. Panel uygulamanın kendisidir; içinde chrome.devtools
// bulunduğunu görünce incelenen sekmeye kilitlenir. (Yollar eklenti köküne göredir.)
chrome.devtools.panels.create('ReqLab', 'icons/icon32.png', 'app/index.html?embed=1');
