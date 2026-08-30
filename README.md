# En Yakın — Backend Proxy

Bu küçük sunucu, uygulamanın gerçek zamanlı veri çekmesini sağlar.
**Hiçbir API anahtarı gerektirmiyor** — tüm veriler OpenStreetMap'in
ücretsiz servislerinden (Overpass API ve Nominatim) geliyor. Google
Places API kullanılmıyor; bunun ne anlama geldiği aşağıda "Sınırlar"
bölümünde açık.

## 1. Yerelde çalıştır (test için)

```bash
npm install
npm start
```

Anahtar/`.env` dosyasına gerek yok. `http://localhost:3000/api/health`
adresine gidip `{"ok":true}` görürsen sunucu çalışıyor demektir.

Test isteği:
```
http://localhost:3000/api/places?category=eczane&lat=38.907&lng=27.814
```

## 2. Ücretsiz olarak deploy et (Render.com)

1. Bu klasörü bir GitHub reposuna yükle (ya da Render'ın "Deploy from a
   public Git repository" seçeneğini kullan).
2. https://render.com üzerinde ücretsiz hesap aç → **New → Web Service**.
3. Reponu bağla. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Environment** sekmesine hiçbir şey eklemene gerek yok.
5. Deploy'u başlat. Birkaç dakika sonra sana
   `https://en-yakin-proxy-xxxx.onrender.com` gibi bir URL verecek.
6. Bu URL'i mobil projenin `.env` dosyasındaki `VITE_BACKEND_URL`
   değişkenine yaz, uygulamayı yeniden derle.

> Not: Render'ın ücretsiz planı 15 dakika kullanılmayınca sunucuyu
> uyutur; ilk istek birkaç saniye gecikebilir. Bu ölçekte sorun değil.
> Bunu tamamen ortadan kaldırmak istersen, ücretsiz bir "uptime
> pinger" servisiyle (UptimeRobot, cron-job.org vb.) `/api/health`
> adresini 10 dakikada bir çağırtabilirsin.

## API

### `GET /api/places`

| Parametre | Zorunlu | Açıklama |
|---|---|---|
| `category` | evet | Desteklenen kategori id'lerinden biri — `server.js`'teki `OSM_TAG_CONFIG` nesnesinin anahtarlarına bak |
| `lat` | evet | Enlem |
| `lng` | evet | Boylam |
| `radius` | hayır | Metre cinsinden arama yarıçapı (varsayılan 50000) |
| `limit` | hayır | Dönecek maksimum sonuç sayısı (varsayılan 8, tavan 20) |

Yanıt, frontend'in beklediği şekle birebir uyan bir JSON dizisi döner:
`{ catId, idx, place_id, name, address, lat, lng, phone, rating, ratingCount, hours, photos }`

OpenStreetMap kaynaklı sonuçlarda `rating`, `ratingCount`, `hours` ve
`photos` her zaman boş/`null` gelir — OSM'de bu veriler yok (aşağıdaki
"Sınırlar" bölümüne bak).

### `GET /api/geocode`

| Parametre | Zorunlu | Açıklama |
|---|---|---|
| `q` | evet | Aranacak yer/adres metni |

OpenStreetMap'in Nominatim servisini kullanır, `{ name, address, lat, lng }`
döner.

### `GET /api/health`

Basit bir "ayakta mıyım" kontrolü, `{"ok":true}` döner.

### `GET /api/kv`, `POST /api/kv`

Uygulamanın topluluk özelliklerini (puanlar, "yerinde" bildirimleri,
bildirilen fiyatlar) destekleyen genel amaçlı anahtar/değer deposu.

## Sınırlar (dürüst olmak gerekirse)

- **Hiçbir zaman ücret riski yok.** OpenStreetMap'in bu servislerinde
  (Overpass API, Nominatim) faturalandırma sistemi yok — kullandıkça
  ödeme diye bir şey yapısal olarak mümkün değil. Aşırı yoğun kullanımda
  en kötü ihtimalle geçici olarak yavaşlatılır/reddedilirsin, asla
  fatura kesilmez.
- **Puan, yorum, fotoğraf yok.** Bunlar OSM'de hiç bulunmayan veri
  türleri — bir işletme değerlendirme platformu değil, bir harita veri
  projesi.
- **Çalışma saatleri çoğu yerde boş.** OSM'in kendi saat formatı
  ("Mo-Fr 08:00-18:00" gibi) uygulamanın ayrıştırıcısıyla uyumlu değil;
  yanlış göstermektense hiç göstermemeyi tercih ettik.
- **"Nöbetçi" durumu değil, olsa olsa genel bilgi.** Ne Google ne de
  OSM resmi nöbet çizelgesini bilir — uygulama bunu zaten bir uyarıyla
  belirtip kullanıcıların "yerinde" bildirimleriyle tamamlanmasını
  öneriyor.
- **Kapsam, özellikle küçük yerleşimlerde, Google'dan daha seyrek
  olabilir.** OSM verisi gönüllülerce giriliyor — büyük şehirlerde
  genelde iyi, küçük ilçelerde bazı işletmeler hiç işaretlenmemiş
  olabilir.
- **İki kategori (Halı Yıkama, Yol Yardım/Çekici) hiç OSM karşılığı
  yok** — bunlar için `/api/places` her zaman boş bir liste döner.
- **Cache bellek içinde**, sunucu yeniden başlayınca sıfırlanır. Bu
  ölçekte sorun yaratmaz.
- **Rate limit basit ve IP bazlı** — güvenilir bir DDoS koruması değil,
  sadece kaba bir kötüye kullanım freni.
