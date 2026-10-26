# monopoly-kit

Claude Code plugin для бекенду онлайн-Монополії [monopoly-online](https://github.com/Kaavaal/monopoly-online)
(Fastify + `node:sqlite`, hexagonal-архітектура в кожному bounded context).

## Purpose

Для кожної нової сутності в monopoly-online пишеться той самий наскрізний шматок. Це міграція, domain, service,
sqlite-репозиторій, Fastify-маршрути зі схемами, wiring у `module.ts` і HTTP-тести. Першу фічу (Player) зроблено
руками, і там щоразу повторювались ті самі промпти, ті самі питання від Claude (trim, регістр унікальних полів, зайві
поля), ручний `pnpm check` і коміт із рядком у `LOG.md`. Плагін проводить фічу за чотири кроки. Спершу план зі
специфікацією, потім генератор у формі першого слайсу, потім тести на доменні правила і наприкінці коміт із логом.
Hooks не пускають імпорти через межі контекстів і коміт без зелених тестів.

## Install

З GitHub, бо репозиторій сам є marketplace з одним плагіном.

```bash
claude plugin marketplace add Kaavaal/monopoly-kit
claude plugin install monopoly-kit@monopoly-kit
```

У сесії те саме роблять `/plugin marketplace add Kaavaal/monopoly-kit`, а потім `/plugin install monopoly-kit@monopoly-kit`.

Для розробки без встановлення запустіть `claude --plugin-dir ../monopoly-kit` з кореня monopoly-online (репозиторії лежать
поруч), а після правок виконайте `/reload-plugins`.

Потрібні Node 24.2+, `pnpm`, `git` і репозиторій у формі monopoly-online (`src/<context>/module.ts`, `migrations/`,
`pnpm check`). Hooks і генератор написані як Node-скрипти без залежностей і спираються на `import.meta.main`, який
з'явився в Node 24.2, тому на 24.0 і 24.1 вони мовчки нічого не роблять.

## Commands

| Команда | Що робить | Приклад |
| --- | --- | --- |
| `/monopoly-kit:feature-scaffold <plan>` | Запускає генератор `monopoly-slice` за планом, виконує рядки `NEEDS`, які він виводить (зазвичай `exists(id)` в api контексту, на який посилається поле), доводить `pnpm check` до зеленого. Без коміту. | `/monopoly-kit:feature-scaffold docs/features/board-property.md` |

Генератор доступний і напряму, бо `bin/` плагіна в `PATH`, поки плагін увімкнено.

```bash
monopoly-slice facts board                                # контексти, їхні api, наступна міграція, зразковий слайс
monopoly-slice docs/features/board-property.md --dry-run  # які файли з'являться
monopoly-slice log-row docs/features/board-property.md 98 # рядок у LOG.md для коміту на HEAD
```

## Skills

| Skill | Виклик | Тригери | Що робить |
| --- | --- | --- | --- |
| `feature-plan` | `/monopoly-kit:feature-plan <Entity> in <context>: <поля>` або автоматично | "add Property to board", "new entity", "нова сутність", "додай CRUD для …" | Факти з `monopoly-slice facts`, рішення за замовчуванням списком, `docs/features/<context>-<entity>.md` з `Started:` і блоком ```` ```json slice ````, перевірка `--dry-run` |
| `feature-tests` | `/monopoly-kit:feature-tests <context> <entity>` або автоматично | "add tests for …", "cover the rules of …", "допиши тести" | Доменні правила з плану, яких немає в згенерованій матриці, → HTTP-тести; red check для кожного нового тесту |
| `feature-ship` | тільки вручну, `/monopoly-kit:feature-ship <plan>` (`disable-model-invocation: true`) | немає | `pnpm check`, коміт рівно файлів слайсу з переліком кроків плагіна в тексті, рядок у `LOG.md` окремим `chore(log)` комітом. Без push |

Agent `slice-scout` (read-only, Haiku) знаходить найближчий слайс-зразок, наступний номер міграції і що вже є в api
контекстів, від яких залежить нова сутність. Його кличе `feature-plan`, коли зразкового слайсу ще немає або запит не вкладається у форму CRUD.

## Hooks

| Event | Matcher | Команда | Умова |
| --- | --- | --- | --- |
| `PreToolUse` | `Edit\|Write\|MultiEdit` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/module-boundary.mjs"` | Файл у `src/<context>/` після правки імпортує з іншого контексту будь-що, крім `src/<other>/module.ts` → `exit 2` з поясненням, що відкрити в `<Other>Api`. Рахуються й type-only, re-export, dynamic import і `import x = require`, а закоментовані імпорти ні. Блокує тільки імпорти, які додає саме ця правка. Не перевіряє `src/app.ts`, `shared/` і тести |
| `PreToolUse` | `Bash` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/commit-gate.mjs"` (timeout 300 s) | Команда містить `git commit` (також `-C`, `cd … &&`, шляхи в лапках, `-a`) → `vitest run test/<context>` для змінених контекстів, потім `pnpm typecheck` і `pnpm arch:check`. Якщо змінено щось поза `src/<context>/`, `test/<context>/` і `migrations/` (`shared/`, `src/app.ts`, `scripts/`, конфіги), запускається весь набір тестів. Змінені файли hook бере з індексу, а також враховує те, що `git add` раніше в тій самій команді і `git commit <paths>` візьмуть з робочого дерева, бо бачить команду ще до її запуску. Червоне або контекст без `test/<context>/` → `exit 2` з хвостом виводу. Без перевірок проходять лише коміти з `*.md` і `docs/`. Текст heredoc і рядків у лапках командою не вважається |

Обидва hooks працюють без мережі. Кожне рішення (allow / block, файл або контексти) вони дописують рядком у
`<git dir>/monopoly-kit-hooks.log`, тож після фічі видно, скільки правок і комітів перевірено і що зупинено. Тести плагіна запускаються через
`node --test 'tests/*.test.mjs'`, а генератор на справжньому репо перевіряє `tests/e2e.sh <monopoly-online>`.

## Як зроблено

Плагін витягнутий з першої фічі (лог у `CAPSTONE_LOG.md` monopoly-online) і з артефактів модуля 5. Звідти взято структуру
команди з pre-flight і звітом (урок 1), skill зі скриптом замість інструкцій (урок 3), hook, що перевіряє файл
*після* правки і блокує тільки додане (урок 4), розбір shell-команди з git-guardrails, README і маніфест (урок 5),
власний `marketplace.json` у цьому репозиторії (урок 6).

## License

MIT
