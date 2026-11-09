# 💃 DanceDNS

Портативный DNS-клиент для Windows. Один `dancedns.exe` без установки: маленькое окно, значок в трее, весь DNS компьютера идёт через зашифрованный **DNS-over-QUIC** (RFC 9250), а запасной вариант — DNS-over-HTTPS.

## Что делает

- **Шифрует весь DNS Windows.** Запускает DNS-сервер на `127.0.0.1:53` / `[::1]:53` и переключает на него сетевые подключения. При выходе возвращает прежние настройки.
- **DNS-over-QUIC по умолчанию.** Серверы AdGuard DNS и Control D через QUIC (порт 853): одно соединение на сервер, повторные запросы без новых рукопожатий. Можно добавить любые `quic://` и `https://` серверы.
- **Перехватывает обход.** Через подписанный драйвер WinDivert ловит DNS-пакеты, которые программы шлют мимо системных настроек (жёстко прописанный 8.8.8.8, DNS роутера по IPv6, VPN-адаптеры), и отвечает на них сам. Отключает встроенный DoH Firefox (канареечный домен `use-application-dns.net`).
- **Видит, какая программа спросила.** Даже когда запрос идёт через системную службу «DNS-клиент» (`svchost.exe`), DanceDNS по ETW-событиям `Microsoft-Windows-DNS-Client` определяет настоящую программу. Поэтому правила по программам работают для всех.
- **Правила.** По имени программы, пути к exe, домену и типу запроса: отправить через выбранную группу серверов, заблокировать (NXDOMAIN или 0.0.0.0), ответить своим IP или отправить обычным DNS.
- **Пулы серверов** со стратегиями «самый быстрый», «по порядку», «по очереди» и автоматическим переходом на следующий сервер при сбое. Кэш с учётом TTL.

## Как пользоваться

1. Скачайте `DanceDNS-windows-x64.zip` со страницы [Releases](../../releases) и распакуйте.
2. Запустите `dancedns.exe`, подтвердите права администратора.
3. Защита включается сама. В окне видно состояние, серверы и последние запросы; закрытие окна сворачивает в трей.
4. Выход — правой кнопкой по значку в трее → «Выход».

Кнопка «Настройки…» открывает `dancedns.yaml` в Блокноте; после сохранения DanceDNS применяет изменения сам.

```yaml
default_pool: doq
auto_enable: true          # включать защиту при запуске
intercept_all: true        # перехват DNS мимо системных настроек (WinDivert)
etw_attribution: true      # определять программу за службой «DNS-клиент»
servers:
  - id: adguard-doq
    name: AdGuard DNS (DoQ)
    url: quic://unfiltered.adguard-dns.com
    bootstrap: [94.140.14.140, 94.140.14.141]
pools:
  - id: doq
    servers: [adguard-doq]
    strategy: fastest        # fastest | failover | round_robin
rules:
  - name: Браузеры — без рекламы
    process: chrome.exe, firefox.exe   # через запятую, можно * и ?
    action: route
    pool: doq-adblock
  - name: Блокировать DoubleClick
    domain: doubleclick.net            # сам домен и все поддомены
    action: block
    sinkhole: 0.0.0.0                  # пусто = NXDOMAIN
```

Аварийный откат DNS: `dancedns.exe --restore-dns`. Режим без окна: `dancedns.exe --headless`.

## Ограничения

- DNS-over-QUIC использует UDP-порт 853. Если сеть его блокирует, выберите в окне пул `default` (DNS-over-HTTPS).
- Перехват WinDivert работает для UDP. DNS-запросы по TCP к сторонним серверам (редкость) проходят как есть.
- Браузер с включённым вручную «безопасным DNS» (свой DoH) обходит любой локальный DNS-клиент: отключите его в настройках браузера.

## Сборка

Нужен Rust (stable). На Windows:

```bash
cargo build --release --manifest-path core/Cargo.toml
```

Кросс-сборка из Linux (нужен `mingw-w64`):

```bash
rustup target add x86_64-pc-windows-gnu
cargo build --release --manifest-path core/Cargo.toml --target x86_64-pc-windows-gnu
```

Тесты: `cargo test --manifest-path core/Cargo.toml`. Тестовый DoQ-сервер: `cargo run --manifest-path core/Cargo.toml --example doq_mock`.

## Устройство

```
core/src/
  gui.rs           окно и трей (Win32, native-windows-gui)
  app.rs           включение/выключение защиты, перечитывание настроек
  server.rs        DNS-серверы UDP/TCP на 127.0.0.1 и ::1
  engine.rs        обработка запроса: программа → правило → кэш/сервер → ответ
  doq.rs           клиент DNS-over-QUIC (quinn + rustls)
  upstream.rs      DoH/DoQ-серверы, пулы, обычный DNS для «напрямую»
  intercept.rs     перехват DNS-пакетов через WinDivert
  etw.rs           определение программы за службой «DNS-клиент»
  process.rs       программа по сокету (GetExtendedUdpTable/TcpTable)
  sysdns.rs        переключение и откат системного DNS
core/vendor/windivert/   WinDivert 2.2.2 (LGPLv3/GPLv2), встраивается в exe
```
