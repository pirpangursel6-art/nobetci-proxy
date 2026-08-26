# Nöbetçi App — Backend Proxy

Bu küçük sunucu, uygulamanın gerçek zamanlı veri çekmesini sağlar. Google
Places API anahtarını güvenle saklar (tarayıcıda asla saklanamaz) ve
frontend'in istediği kategori + konuma göre en yakın yerleri döndürür.

## 1. Google Places API anahtarı al

1. https://console.cloud.google.com/ adresinde yeni bir proje oluştur (veya
   var olanı kullan).
2. **APIs & Services → Library** kısmından **Places API** (Legacy) etkinleştir.
3. **APIs & Services → Credentials → Create Credentials → API Key** ile bir
   anahtar oluştur.
4. Anahtarı kısıtla: **Application restrictions** kısmından "None" bırakma —
   mümkünse **IP addresses** kısıtlaması ekle (sunucunu deploy ettikten sonra
   sunucunun çıkış IP'sini öğrenip oraya ekleyebilirsin), ya da en azından
   **API restrictions** kısmından sadece "Places API"yi seç.
5. Google, yeni hesaplara aylık ücretsiz kredi tanımlıyor; bu ölçekte
   (birkaç yüz istek/gün, 10 dakikalık cache ile) normal şartlarda ücretsiz
   kotanın içinde kalırsın. Yine de bir bütçe uyarısı kurmanı öneririm:
   **Billing → Budgets & alerts**.

## 2. Yerelde çalıştır (test için)

```bash
npm install
cp .env.example .env
# .env dosyasını aç, GOOGLE_PLACES_API_KEY değerini yapıştır
npm start
```

`http://localhost:3000/api/health` adresine gidip `{"ok":true}` görürsen
sunucu çalışıyor demektir.

Test isteği:
```
http://localhost:3000/api/places?category=eczane&lat=38.907&lng=27.814
```

## 3. Ücretsiz olarak deploy et (Render.com)

1. Bu klasörü bir GitHub reposuna yükle (ya da Render'ın "Deploy from a
   public Git repository" seçeneğini kullan).
2. https://render.com üzerinde ücretsiz hesap aç → **New → Web Service**.
3. Reponu bağla. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. **Environment** sekmesinden `GOOGLE_PLACES_API_KEY` değişkenini ekle.
5. Deploy'u başlat. Birkaç dakika sonra sana
   `https://nobetci-proxy-xxxx.onrender.com` gibi bir URL verecek.
6. Bu URL'i uygulamadaki **Ayarlar** (⚙️) ekranına yapıştır — uygulama o
   andan itibaren herkes için canlı veri çekmeye başlar.

> Not: Render'ın ücretsiz planı 15 dakika kullanılmayınca sunucuyu
> uyutur; ilk istek birkaç saniye gecikebilir. Bu ölçekte sorun değil,
> ama sürekli hızlı yanıt istiyorsan ücretli bir plana ya da Railway /
> Fly.io gibi bir alternatife geçebilirsin — kod değişmeden çalışır.

## 4. Alternatif: Vercel Serverless Function

`server.js`'i olduğu gibi bir Express app'e sarıp Vercel'e de
deploy edebilirsin (`vercel.json` ile route'ları `/api/*` fonksiyonuna
yönlendirerek). Render daha basit olduğu için burada onu önerdim.

## API

### `GET /api/places`

| Parametre | Zorunlu | Açıklama |
|---|---|---|
| `category` | evet | `eczane`, `firin`, `doviz`, `atm`, `tamirci`, `lastikci`, `cilingir`, `benzinlik`, `hastane`, `itfaiye`, `polis`, `yolyardim` |
| `lat` | evet | Enlem |
| `lng` | evet | Boylam |
| `radius` | hayır | Metre cinsinden arama yarıçapı (varsayılan 6000) |

Yanıt, frontend'in beklediği şekle birebir uyan bir JSON dizisi döner:
`{ catId, idx, place_id, name, address, lat, lng, phone, rating, ratingCount, hours }`

### `GET /api/health`

Basit bir "ayakta mıyım" kontrolü, `{"ok":true}` döner.

## Sınırlar (dürüst olmak gerekirse)

- **"Nöbetçi" durumu değil, genel çalışma saatleri.** Google Places, resmi
  nöbet çizelgesini bilmiyor — sadece işletmenin standart saatlerini
  biliyor. Uygulama bunu zaten bir uyarıyla belirtiyor ve kullanıcıların
  "yerinde" bildirimleriyle tamamlanmasını öneriyor.
- **Cache bellek içinde**, sunucu yeniden başlayınca sıfırlanır. Bu
  ölçekte sorun yaratmaz.
- **Rate limit basit ve IP bazlı** — güvenilir bir DDoS koruması değil,
  sadece anahtarın kazara/kötüye kullanımdan aşırı maliyetlenmesini
  önlemek için.
