# Traceless (İzsiz): fotoğraf ve videodan meta veri ve konum silme, yüz gizleme, internetsiz

[English](README.md) · [فارسی](README.fa.md) · **Türkçe**

Bir fotoğrafı, videoyu veya sesli mesajı göndermeden önce tek adımda ve tamamen internetsiz olarak güvenli hâle
getirin. Traceless, bir dosyanın nerede, ne zaman ve hangi cihazla yapıldığını ele verebilecek gizli bilgileri siler:
EXIF meta verisi, GPS konumu, telefon modeli ve seri numarası, tarihler. Yüzleri, araç plakalarını ve yazıları da düz
renkle kapatır. Ücretsiz ve açık kaynaktır; hiçbir dosya bir yere yüklenmez.

**Kullanın:** https://pouyamsmartcity.github.io/traceless/tr/

Bir kez internetle açın; sonrasında internetsiz de çalışır. Telefonun ana ekranına eklenip bir uygulama gibi
kullanılabilir.

## Ne yapar

- **İnternetsiz.** Her şey kendi telefonunuzda veya bilgisayarınızda olur. Sayfanın hiçbir sunucuya bağlanmasına
  izin verilmez; hesap ve istatistik toplama yoktur.
- **Fotoğraf yeniden oluşturulur.** Resim piksel renklerinden yepyeni bir dosyaya çizilir. Konum, telefon modeli,
  seri numarası, sahibinin adı, tarihler, gizli küçük resimler, düzenleme geçmişi, İçerik Kimlik Bilgileri (C2PA),
  hareketli fotoğraf videoları ve kırpılmış ekran görüntülerinin artıkları yeni dosyaya geçmez. Yeni dosya teslim
  edilmeden önce yeniden kontrol edilir.
- **Fotoğraflarda ve videolarda yüz ve plaka kapatma.** Yüzler (kalabalıktaki küçük yüzler dahil) ve araç plakaları
  cihazın kendisinde bulunup kapatılır. Kapatmalar bulanıklaştırma veya pikselleştirme değil düz renktir; çünkü
  bunlar bazen geri alınabilir. Videolarda her yüz tüm karelerde izlenip kapatılır.
- **İstenirse yazıları ve insanları tamamen kapatma:** dükkân ve sokak tabelaları, isimler ve numaralar; vücut,
  kıyafet ve saç.
- **Videolarda ve sesli mesajlarda sesi değiştirme veya kaldırma.** Kalınlaştırılmış ses sıradan dinleyiciyi durdurur,
  araçlarla uğraşan birini değil; en güvenlisi sesi kaldırmaktır.
- **Kamera tanınmasına karşı ek koruma** (sensörün görünmez deseni).
- **Video ve fotoğraf kırpma,** tek dokunuşla her şeyi silme ve uygulamadan çıktıktan beş dakika sonra **otomatik
  unutma**.
- **Özgün dosyayı parolayla mühürleme:** gerekirse bir gün, paylaşılan kopyanın hangi gerçek fotoğraftan geldiğini
  özgün dosyayı göndermeden kanıtlamak için.
- **Üç dil:** Türkçe, İngilizce ve Farsça.

## Neleri gizleyemez

Traceless hiçbir zaman bir dosyanın "%100 güvenli" olduğunu söylemez. Şunları gizlemez:

- resimde görünenleri: tabelalar, tanınan binalar, gölgeler, camlarda ve gözlüklerde yansımalar, kıyafetler, dövmeler;
- bulunamayan bir yüzü veya plakayı; göndermeden önce resme her zaman kendiniz bakın;
- kamera sensörünün izini ("ek koruma" bunu çok zorlaştırır, imkânsız kılmaz);
- videolardaki kelimeleri, aksanı ve ortam seslerini (ses değiştirilebilir veya kaldırılabilir);
- daha önce bir yere gönderdiğiniz kopyaları.

Ayrıntılar (İngilizce): [docs/SECURITY.md](docs/SECURITY.md).

## Programlar ve yapay zekâ ajanları için

Traceless bir komut satırı aracı ve bir [MCP](https://modelcontextprotocol.io) sunucusudur da: betikler ve yapay zekâ
ajanları (Claude, Cursor ve diğerleri) bilgisayardaki dosyaları yine tamamen internetsiz olarak inceleyip
temizleyebilir. Rehber: [docs/API.md](docs/API.md). Teknik ayrıntılar ve derleme: [README.md](README.md).

## Güvenlik sorunu bildirme

Temizlenmiş bir dosyanın hâlâ bir şey ele verdiği bir yol bulursanız lütfen herkese açık bildirmeyin;
[SECURITY.md](SECURITY.md) dosyasına bakın.

Özgür yazılım (MIT), [Pouyam](https://www.pouyam.com) tarafından.
