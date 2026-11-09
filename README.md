# 💃 DanceDNS

Портативный DNS-over-HTTPS клиент для Windows с правилами по процессам. Похож на YogaDNS, но это один `.exe` без установки и со встроенной веб-панелью.

- **Настоящий DNS-сервер** на `127.0.0.1:53` и `[::1]:53` (UDP и TCP).
- **DoH (RFC 8484)**: Cloudflare, Quad9, Google, AdGuard, Mullvad, Control D и любые свои серверы. Соединения HTTP/2 переиспользуются, адреса серверов задаются bootstrap-IP, поэтому нет зацикливания на самого себя.
- **Пулы серверов** со стратегиями «самый быстрый», «по порядку (резерв)», «по очереди». Если сервер не отвечает, запрос автоматически уходит на следующий.
- **Правила** по имени процесса, пути к exe, домену и типу запроса. Действия: через пул DoH, блокировать (NXDOMAIN или 0.0.0.0), свой IP, напрямую (обычный DNS).
- **Определение процесса** по сокету клиента через `GetExtendedUdpTable`/`GetExtendedTcpTable`.
- **Кэш** с учётом TTL, включая отрицательные ответы.
- **Журнал запросов в реальном времени**: процесс, правило, сервер, время ответа, записи ответа. Из журнала можно в один клик заблокировать домен или создать правило.
- **Переключение системного DNS** одной кнопкой. Прежние настройки сохраняются в файл и восстанавливаются при выходе, даже после аварийного завершения (`--restore-dns`).
- **Портативность**: все настройки лежат рядом с программой в `dancedns.yaml`. Изменения из панели применяются сразу, без перезапуска.

## Как пользоваться

1. Скачайте `DanceDNS-windows-x64.zip` со страницы [Releases](../../releases) или из артефактов GitHub Actions и распакуйте его в любую папку.
2. Запустите `dancedns.exe` и подтвердите запрос прав администратора.
3. Откроется панель `http://127.0.0.1:5380`. На вкладке «Обзор» нажмите **«Направить систему на DanceDNS»**.
4. Чтобы выключить DanceDNS, закройте окно консоли или нажмите ⏻ в панели. Системный DNS вернётся к прежним настройкам.

```
dancedns.exe --help
  -c, --config <FILE>   файл настроек (по умолчанию dancedns.yaml рядом с exe)
  -l, --listen <ADDRS>  адреса DNS через запятую, например 127.0.0.1:5353
      --ui <ADDR>       адрес панели, например 127.0.0.1:5380
      --no-browser      не открывать браузер
      --restore-dns     вернуть сохранённые настройки DNS и выйти
  -v, --verbose         подробный лог каждого запроса
```

Переменная окружения `DANCEDNS_EXTRA_CA=путь.pem` добавляет доверенный корневой сертификат. Она нужна в сетях с корпоративной TLS-инспекцией.

### Важно про правила по процессам в Windows

Большинство программ Windows обращаются к DNS не сами, а через системную службу «DNS-клиент» (Dnscache). DanceDNS видит такие запросы от `svchost.exe`. Правила по именам процессов срабатывают для программ, которые отправляют DNS-запросы сами: браузеров со встроенным DNS-клиентом, многих игр, `curl`, `nslookup`, Java- и Go-программ. Правила по доменам работают для всех. Чтобы перехватывать запросы каждого процесса через Dnscache, нужен драйвер WFP, как в YogaDNS. В DanceDNS его пока нет.

## Пример `dancedns.yaml`

```yaml
listen: ["127.0.0.1:53", "[::1]:53"]
default_pool: default
servers:
  - id: quad9
    name: Quad9
    url: https://dns.quad9.net/dns-query
    bootstrap: [9.9.9.9, 149.112.112.112]
pools:
  - id: default
    servers: [quad9]
    strategy: fastest        # fastest | failover | round_robin
rules:
  - name: Браузеры через Quad9
    process: chrome.exe, firefox.exe   # через запятую, можно * и ?
    action: route
    pool: default
  - name: Блокировать DoubleClick
    domain: doubleclick.net            # сам домен и все поддомены
    action: block
    sinkhole: 0.0.0.0                  # пусто = NXDOMAIN
  - name: Локальная разработка
    domain: localdev.internal
    action: local
    ip: 127.0.0.1
```

## Сборка из исходников

Нужны Node.js 20+ и Rust (stable). На Windows:

```bash
npm ci
npm run build:app          # UI + core\target\release\dancedns.exe
```

Кросс-сборка из Linux (нужен `mingw-w64`):

```bash
rustup target add x86_64-pc-windows-gnu
npm run build:win          # core/target/x86_64-pc-windows-gnu/release/dancedns.exe
```

Разработка интерфейса с горячей перезагрузкой: запустите ядро (`cargo run --manifest-path core/Cargo.toml -- --no-browser -l 127.0.0.1:5353`) и в другом терминале `npm run dev`. Vite проксирует `/api` на ядро.

Тесты: `npm test`. При каждом push GitHub Actions собирает Windows-версию. Тег `v*` публикует релиз с архивом.

## Устройство

```
core/                  ядро на Rust (tokio, hickory-proto, reqwest+rustls, axum)
  src/server.rs        DNS-серверы UDP/TCP
  src/engine.rs        обработка запроса: процесс → правило → кэш/DoH → ответ + журнал
  src/rules.rs         движок правил
  src/upstream.rs      DoH-клиенты, пулы, bootstrap, обычный DNS для «напрямую»
  src/process.rs       определение процесса по сокету
  src/sysdns.rs        переключение и восстановление системного DNS
  src/api.rs           REST API панели и встроенные файлы UI
src/                   веб-панель (React + Tailwind), встраивается в exe при сборке
```

Панель доступна только с `127.0.0.1`: запросы с чужим заголовком `Host` отклоняются, а изменяющие запросы требуют `Content-Type: application/json`. Это защищает от DNS-rebinding и CSRF со сторонних сайтов.
