# monopoly-kit

Claude Code plugin для бекенду онлайн-Монополії [monopoly-online](https://github.com/Kaavaal/monopoly-online)
(Fastify + `node:sqlite`, hexagonal по bounded contexts).

## Purpose

Кожна нова сутність у monopoly-online — це той самий наскрізний шматок: міграція, domain, service, sqlite-репозиторій,
Fastify-маршрути зі схемами, wiring у `module.ts` і HTTP-тести. Першу фічу (Player) зроблено руками: ті самі
промпти, рішення, що їх Claude щоразу перепитує (trim, регістр унікальних полів, зайві поля), ручні `pnpm check` і
коміт із рядком у `LOG.md`. Плагін забирає це повторюване: план зі специфікацією → генератор у формі першого слайсу →
доповнення тестів доменними правилами → коміт і лог, а hooks не пускають імпорти через межі контекстів і коміт без
зелених тестів.

## Install

З GitHub (репозиторій сам є marketplace з одним плагіном):

```bash
claude plugin marketplace add Kaavaal/monopoly-kit
claude plugin install monopoly-kit@monopoly-kit
```

У сесії те саме: `/plugin marketplace add Kaavaal/monopoly-kit`, потім `/plugin install monopoly-kit@monopoly-kit`.

Розробка, без встановлення: `claude --plugin-dir ../monopoly-kit` з кореня monopoly-online (репозиторії лежать
поруч), після правок — `/reload-plugins`.

Потрібно: Node 24.2+ (hooks і генератор — Node-скрипти без залежностей; `import.meta.main` з'явився в 24.2, на
24.0–24.1 вони мовчки нічого не роблять), `pnpm`, `git`, репозиторій у формі
monopoly-online (`src/<context>/module.ts`, `migrations/`, `pnpm check`).

## Commands

| Команда | Що робить | Приклад |
| --- | --- | --- |
| `/monopoly-kit:feature-scaffold <plan>` | Запускає генератор `monopoly-slice` за планом, робить його `NEEDS` (зазвичай `exists(id)` в api контексту, на який посилається поле), доводить `pnpm check` до зеленого. Без коміту. | `/monopoly-kit:feature-scaffold docs/features/board-property.md` |

Генератор доступний і напряму, бо `bin/` плагіна в `PATH`, поки плагін увімкнено:

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
| `feature-ship` | тільки вручну: `/monopoly-kit:feature-ship <plan>` (`disable-model-invocation: true`) | — | `pnpm check`, коміт рівно файлів слайсу з переліком кроків плагіна в тексті, рядок у `LOG.md` окремим `chore(log)` комітом. Без push |

Agent `slice-scout` (read-only, Haiku): знаходить найближчий слайс-зразок, наступний номер міграції і що вже є в api
контекстів, від яких залежить нова сутність. Його кличе `feature-plan`, коли фактів генератора замало.

## Hooks

| Event | Matcher | Команда | Умова |
| --- | --- | --- | --- |
| `PreToolUse` | `Edit\|Write\|MultiEdit` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/module-boundary.mjs"` | Файл у `src/<context>/` після правки імпортує нутрощі іншого контексту (будь-що, крім `src/<other>/module.ts`; type-only, re-export, dynamic import і `import x = require` теж; закоментовані імпорти не рахуються) → `exit 2` з поясненням, що відкрити в `<Other>Api`. Блокує тільки імпорти, які додає саме ця правка; `src/app.ts`, `shared/` і тести не перевіряє |
| `PreToolUse` | `Bash` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/commit-gate.mjs"` (timeout 300 s) | Команда містить `git commit` (також `-C`, `cd … &&`, шляхи в лапках, `-a`) → тести змінених контекстів (`vitest run test/<context>`; весь набір, якщо змінено щось поза `src/<context>/`, `test/<context>/` і `migrations/`: `shared/`, `src/app.ts`, `scripts/`, конфіги), потім `pnpm typecheck` і `pnpm arch:check`. Змінене — це індекс плюс те, що `git add` раніше в тій самій команді і `git commit <paths>` візьмуть з робочого дерева (hook бачить команду до її запуску). Червоне або контекст без `test/<context>/` → `exit 2` з хвостом виводу. Без перевірок проходять лише коміти з `*.md` і `docs/`. Текст heredoc і рядків у лапках командою не вважається |

Обидва hooks без мережі й без залежностей. Кожне рішення (allow / block, файл або контексти) вони дописують рядком у
`<git dir>/monopoly-kit-hooks.log`, тож після фічі видно, скільки правок і комітів перевірено і що зупинено. Тести:
`node --test 'tests/*.test.mjs'`, генератор на справжньому репо: `tests/e2e.sh <monopoly-online>`.

## Як зроблено

Плагін витягнутий з першої фічі (лог у `CAPSTONE_LOG.md` monopoly-online) і з артефактів модуля 5: структура
команди з pre-flight і звітом (урок 1), skill зі скриптом замість інструкцій (урок 3), hook, що перевіряє файл
*після* правки і блокує тільки додане (урок 4), розбір shell-команди з git-guardrails, README і маніфест (урок 5),
власний `marketplace.json` у цьому репозиторії (урок 6).

## License

MIT
