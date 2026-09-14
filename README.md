# imyavel.github.io — «Будущий Мир» (хаб)

Канонический **отказоустойчивый** адрес сайта. User-репо `imyavel/imyavel.github.io`,
GitHub Pages, БЕЗ кастомного домена (привязан к аккаунту GitHub, переживает падение домена).

## Маршрутизация доменов (с 2026-06-03)

- **Канон = `imyavel.github.io`** — отдаёт хаб напрямую: главная + подпапка `modus-operandi/`.
  Project-страницы под тем же origin: `/yaniktoim/` (репо `yaniktoim`, Pages source `main` `/docs`),
  `/zohar-sulam/` (репо `zohar-sulam`).
- **`bneiadam.com` = redirect-псевдоним** (отдельный репо `imyavel/bneiadam-redirect`):
  держит `CNAME` + `index.html`/`404.html` с path-preserving пересылкой
  `location.replace("https://imyavel.github.io" + location.pathname + …)`. Корень → 200,
  подпути → 404.html (статус 404, но браузер редиректит сам — для ботов косметика, для людей работает).

## Почему так (не вешать домен на user-репо)

Кастомный домен на user-репо заставляет GitHub 301-редиректить ВСЕ `*.github.io`
(включая project-страницы) на домен → падение домена ломает и github.io. Зависимость
перевёрнута: домен пересылает на github.io, а не наоборот. Цена: в адресной строке канон =
`imyavel.github.io`, `bneiadam.com` отскакивает на него (совместить «домен в адресной строке»
и «github.io независим» одновременно нельзя). Первая (отменённая) итерация вешала домен прямо
на user-репо — красивый URL, но без отказоустойчивости.

## Не удалять

- `zen_…k2.html` в корне — верификация домена `imyavel.github.io` в Дзен-Студии, нужна постоянно
  (см. `C:\Users\admin\dzenru\project.md`).

Репо `zohar-sulam-mirror` архивирован (RETIRED), домена не держит.
