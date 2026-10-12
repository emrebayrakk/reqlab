# Gizlilik Politikası · Privacy Policy

**ReqLab – İstek Denetleyici ve API İstemcisi / Request Inspector & API Client** (Chrome eklentisi / Chrome extension)

Son güncelleme / Last updated: 12 Ekim 2026 / October 12, 2026

[Türkçe](#türkçe) · [English](#english)

---

## Türkçe

### Kısaca

ReqLab **hiçbir veriyi geliştiriciye ya da üçüncü taraflara göndermez**. Sunucusu, analitik aracı veya reklamı yoktur. Eklentinin işlediği her şey yalnızca senin tarayıcında kalır.

### Hangi verileri işler?

| Veri | Ne için | Nerede |
|---|---|---|
| Sayfaların ağ istekleri: URL, yöntem, durum kodu, istek ve yanıt başlıkları (Cookie ve Authorization dahil), zamanlama, sunucu IP adresi | İstekleri listede göstermek, incelemek, filtrelemek | Yalnızca açık ReqLab penceresinin belleğinde; pencere kapanınca silinir |
| fetch/XHR istek ve yanıt gövdeleri | İstek/yanıt gövdesini göstermek | Yalnızca açık ReqLab penceresinin belleğinde |
| Kaydettiğin kayıtlar, koleksiyonlar, geçmiş, ortam değişkenleri, kurallar ve ayarlar | Senin isteğinle saklamak ve sonradan kullanmak | Yalnızca tarayıcında (`chrome.storage.local`) |
| İstemci’den gönderdiğin istekler ve yanıtları | İsteği senin belirttiğin adrese göndermek ve yanıtı göstermek | İstek yalnızca senin yazdığın adrese gider; sonuç tarayıcında kalır |

ReqLab yakalamayı yalnızca ReqLab penceresi (sekme, yan panel ya da DevTools paneli) açıkken yapar.

### Ağ bağlantıları

- ReqLab kendiliğinden hiçbir sunucuya bağlanmaz.
- İstemci’de **senin** gönderdiğin istekler yalnızca senin yazdığın adrese gider.
- Senin oluşturduğun kurallar (engelle, yönlendir, başlık değiştir, sahte yanıt, gecikme) tarayıcının kendi ağ katmanında uygulanır.
- Eklenti dışarıdan kod indirmez veya çalıştırmaz.

### Veri paylaşımı

Veriler satılmaz, kiralanmaz, paylaşılmaz ve eklentinin amacı dışında kullanılmaz. Kredi değerlendirmesi veya benzeri amaçlarla kullanılmaz.

### Saklama süresi ve silme

- Yakalanan istekler ReqLab penceresi kapanınca silinir.
- Kayıtları, koleksiyonları, geçmişi ve kuralları ReqLab içinden tek tek ya da **Ayarlar → Sıfırla** ile toptan silebilirsin.
- Eklentiyi kaldırdığında Chrome eklentinin bütün verilerini siler.

### İzinler

- `webRequest` ve tüm sitelere erişim: sayfaların isteklerini görüntülemek (yalnızca ReqLab açıkken).
- `scripting`: fetch/XHR gövdelerini yakalayan sayfa kancasını eklemek ve “sayfa içinden gönder” özelliği.
- `declarativeNetRequest`: senin oluşturduğun engelle / yönlendir / başlık kurallarını uygulamak.
- `storage`, `unlimitedStorage`: kayıtları, koleksiyonları ve ayarları yerelde saklamak.
- `sidePanel`: ReqLab’i sayfanın yanında açmak. `contextMenus`: simgeye sağ tık menüsü.

### İletişim

Sorular için: [emrebayrak.com.tr](https://emrebayrak.com.tr)

---

## English

### In short

ReqLab **does not send any data to the developer or to third parties**. It has no server, no analytics and no ads. Everything the extension handles stays in your browser.

### What data it handles

| Data | Why | Where |
|---|---|---|
| Pages’ network requests: URL, method, status code, request and response headers (including Cookie and Authorization), timing, server IP | To list, inspect and filter requests | Only in the memory of the open ReqLab window; deleted when it closes |
| fetch/XHR request and response bodies | To show request/response bodies | Only in the memory of the open ReqLab window |
| Recordings, collections, history, environment variables, rules and settings you save | To keep them for later at your request | Your browser only (`chrome.storage.local`) |
| Requests you send from the Client and their responses | To send the request to the address you entered and show the response | The request goes only to the address you typed; the result stays in your browser |

ReqLab only captures while a ReqLab window (tab, side panel or DevTools panel) is open.

### Network connections

- ReqLab never connects to any server on its own.
- Requests **you** send from the Client go only to the address you entered.
- Rules you create (block, redirect, rewrite headers, mock, delay) are applied in the browser’s own network layer.
- The extension does not download or run remote code.

### Data sharing

Data is not sold, rented or shared, and is not used for anything other than the extension’s purpose. It is not used for creditworthiness or similar purposes.

### Retention and deletion

- Captured requests are deleted when the ReqLab window closes.
- You can delete recordings, collections, history and rules one by one inside ReqLab, or all at once with **Settings → Reset**.
- Removing the extension makes Chrome delete all of its data.

### Permissions

- `webRequest` and access to all sites: to show pages’ requests (only while ReqLab is open).
- `scripting`: to add the page hook that captures fetch/XHR bodies, and for “send in page”.
- `declarativeNetRequest`: to apply the block / redirect / header rules you create.
- `storage`, `unlimitedStorage`: to keep recordings, collections and settings locally.
- `sidePanel`: to open ReqLab next to the page. `contextMenus`: the icon’s right-click menu.

### Contact

Questions: [emrebayrak.com.tr](https://emrebayrak.com.tr)
