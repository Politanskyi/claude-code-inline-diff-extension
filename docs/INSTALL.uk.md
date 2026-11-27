# Claude Inline Diff: встановлення в Cursor

Розширення показує правки Claude Code прямо у файлі, як у агента Cursor. Видалений код з'являється червоними блоками між рядками, доданий підсвічується зеленим. Кожну зміну можна залишити (**Keep**, Cmd/Ctrl+Y) або скасувати (**Undo**, Cmd/Ctrl+N). Назви, клавіші й кольори взяті з коду самого Cursor 3.32.

Воно працює з **офіційним розширенням Claude Code** (його панеллю чату) і з CLI. API-ключ і проксі не потрібні: розширення читає дані з хуків Claude Code і не ходить у мережу.

**Точний id розширення:** `inlinediff.claude-inline-diff`

> Позначки в цьому документі: ✅ перевірено автотестами (unit або e2e у справжньому **Cursor 3.32.4** і VS Code 1.148, з імітованими пейлоадами хука); 🔶 лише теоретично або за документацією (див. [MANUAL_TESTING.uk.md](MANUAL_TESTING.uk.md)).

---

## 1. Що потрібно

- Cursor (або VS Code ≥ 1.90).
- Офіційне розширення **Claude Code** (`anthropic.claude-code`), у яке ви вже увійшли з корпоративною підпискою.
- Node.js ≥ 18, щоб зібрати розширення.
  - Для роботи хука Node бажаний, але не обов'язковий. Якщо `node` немає в PATH, хук запускається самим Cursor у режимі Node (`ELECTRON_RUN_AS_NODE=1`). ✅ на Linux/macOS (sh), 🔶 на Windows.
- `git`, тільки якщо хочете бачити правки, які Claude робить через Bash.

## 2. Збірка .vsix

```bash
git clone <ваш-репозиторій> claude-inline-diff
cd claude-inline-diff
npm ci
npm test            # необов'язково: юніт-тести
npm run package     # → claude-inline-diff.vsix у корені проєкту
```
✅ Збирається в CI на Linux, macOS і Windows.

## 3. Встановлення в Cursor

```bash
cursor --install-extension claude-inline-diff.vsix
```

Якщо команда `cursor` не знайдена, є два варіанти:
- у Cursor виконайте **Cmd/Ctrl+Shift+P → "Shell Command: Install 'cursor' command in PATH"**;
- або відкрийте панель Extensions → меню `…` → **Install from VSIX…** і виберіть файл.

## 4. Увімкнути червоні блоки між рядками (proposed API `editorInsets`)

Без цього кроку розширення теж працює, але у спрощеному режимі: на місці видалених рядків буде червона риска з підписом «−N lines removed», а старий код видно при наведенні курсора.

**Варіант А, автоматично:** Cmd/Ctrl+Shift+P → **Claude Inline Diff: Enable Inline Removed-Code Blocks (argv.json)…** → **Add Automatically**. Розширення акуратно додасть рядок, збереже коментарі у файлі й зробить резервну копію `argv.json.bak-claude-inline-diff`. ✅ логіка редагування покрита unit-тестами.

**Варіант Б, вручну:** Cmd/Ctrl+Shift+P → **Preferences: Configure Runtime Arguments**. Відкриється файл:
- macOS / Linux: `~/.cursor/argv.json`
- Windows: `%USERPROFILE%\.cursor\argv.json`

Додайте всередину `{ … }` такий рядок (не забудьте кому після попереднього рядка):

```jsonc
"enable-proposed-api": ["inlinediff.claude-inline-diff"]
```

Якщо ключ `enable-proposed-api` у файлі вже є, допишіть id у наявний масив.

## 5. Повний перезапуск Cursor

**Повністю закрийте Cursor** (macOS: Cmd+Q; Windows/Linux: File → Exit) і запустіть знову. «Developer: Reload Window» **не підходить**: `argv.json` читається тільки під час старту програми.

Перевірити результат: Cmd/Ctrl+Shift+P → **Claude Inline Diff: Show Hook Status**. У виводі має бути рядок `Inline removed-code blocks (editorInsets): enabled`. ✅ Перевірено в Cursor 3.32.4: з рядком у `~/.cursor/argv.json` червоні блоки малюються, без нього розширення саме переходить у спрощений режим.

## 6. Встановити хук Claude Code

Cmd/Ctrl+Shift+P → **Claude Inline Diff: Install Claude Code Hook**

Що робить команда (✅ unit-тести на тимчасовому `CLAUDE_CONFIG_DIR`):
- копіює скрипт у `~/.claude/hooks/claude-inline-diff-hook.js`. Якщо задано `CLAUDE_CONFIG_DIR`, скрипт іде туди;
- додає у `~/.claude/settings.json` чотири записи:
  - `PreToolUse` і `PostToolUse` з matcher `Edit|MultiEdit|Write|NotebookEdit|Bash`;
  - `UserPromptSubmit` і `Stop` (без matcher; Stop показує, що Claude закінчив хід). Якщо хук уже встановлено, розширення саме додасть `Stop` під час оновлення;
- перед зміною робить резервну копію `settings.json.bak-claude-inline-diff-<час>`, зберігає права доступу до файлу й не чіпає чужі хуки;
- якщо `settings.json` містить невалідний JSON, нічого не змінює й показує помилку.

Офіційне розширення Claude Code і CLI використовують **той самий** `~/.claude/settings.json`, тож хук працює в обох (за документацією Anthropic; 🔶 запуск хуків саме офіційним розширенням автотестами не перевіряється, бо для цього потрібен вхід у Claude). Після встановлення **почніть нову розмову** в панелі Claude Code.

## 7. Автоматичне застосування правок в офіційному розширенні Claude Code

У режимі *Manual* офіційне розширення спочатку показує власну diff-вкладку й чекає вашого дозволу. Щоб правки одразу лягали у файл і ви переглядали їх **тільки інлайн**, перемкніть Claude у режим **Edit automatically** (`acceptEdits`). Є три способи:

1. **У самій панелі:** під полем вводу клацніть індикатор режиму й виберіть **Edit automatically**. Діє для поточної розмови.
2. **За замовчуванням для нових розмов:** Settings → знайдіть `claudeCode.initialPermissionMode` → `acceptEdits`. Або в **користувацьких** (не workspace) налаштуваннях:
   ```json
   "claudeCode.initialPermissionMode": "acceptEdits"
   ```
3. **Через розширення:** після встановлення хука з'явиться кнопка **Enable "Edit automatically"**. Вона виставляє і `claudeCode.initialPermissionMode`, і `permissions.defaultMode` у `~/.claude/settings.json`, а попередні значення запам'ятовує, щоб видалення хука повернуло їх назад. ✅ відкат перевірено тестами.

Якщо diff-вкладка Claude все ж відкрилась (режим Manual), наше розширення їй не заважає. Інлайн-рев'ю з'явиться, щойно правка ляже у файл.

## 8. Як користуватись

- Попросіть Claude щось змінити. Змінені файли з'являться в списку **Claude Changes** під чатом. Відкрийте файл (клік у списку), і зміни будуть підсвічені просто в ньому.
- Курсор у зміні: **Cmd/Ctrl+Y** залишає (Keep), **Cmd/Ctrl+N** скасовує (Undo). Як у Cursor, після Keep курсор переходить до наступної зміни в цьому ж файлі; після Undo, Keep File і Undo File лишається на місці.
- Навігація, як у Cursor: **Alt+J / Alt+K** — наступна / попередня зміна у файлі, **Alt+L / Alt+H** — наступний / попередній файл. Поки агент Cursor має неприйняті зміни, Alt+L перехоплює сам Cursor (його «Go to Next Diff File» має вищий пріоритет за будь-яке розширення) і переходить між файлами Cursor; тоді для файлів Claude є Cmd+Alt+PageDown / PageUp.
- Весь файл: **Cmd/Ctrl+Enter** залишає, **Cmd/Ctrl+Shift+Backspace** скасовує (як у Cursor). Працюють і Cmd/Ctrl+Shift+Y / N.
- Під зміною, найближчою до курсора або миші, справа є «пігулка», як у Cursor: **⌃ 2 of 5 ⌄ │ Undo ⌘N │ Keep** (одна на файл; лічильник лише коли змін кілька), того ж розміру й кольорів, що в Cursor. Розширення не може накласти її поверх коду, тому вона займає власний рядок, і текст нижче зсувається, коли вона переходить до іншої зміни. Стрілки перемикають зміни. «Undo з поясненням» (причину отримає Claude разом із вашим наступним повідомленням) є в контекстному меню на зміні.
- Унизу активного редактора плавають кнопки **Undo File / Keep File ⌘⏎** для поточного файлу (Cursor показує свої такі ж у рядку з назвою файлу, але розширенням туди не можна). У файлі без змін Claude (коли зміни є в інших) там **Keep all changes / Review Next File**.
- Як і Cursor, розширення саме не відкриває файли, які змінює Claude, і не прокручує до змін (можна ввімкнути: `revealOnEdit`, `followClaude`).
- З увімкненим `followClaude` редактор сам прокручується до нової правки Claude у відкритому файлі й на мить підсвічує нові рядки. Поки ваш курсор стоїть у зміні, вигляд не зсувається.
- **Review All Changes** (у панелі Claude Changes) відкриває всі файли в одному multi-diff, як Review у Cursor 3.
- Коли список Claude Changes не видно, у статусбарі є «N files · M changes» (клік відкриває список) та індикатор «Claude editing <файл>».
- Список **Claude Changes** стоїть під чатом Claude Code (як «N Files» під чатом агента Cursor) і за замовчуванням згорнутий; розгортаєте й згортаєте його лише ви, як список файлів у Cursor ; клік по підсумку в статусбарі теж його розгортає. Коли все переглянуто, як у Cursor, у списку лишаються всі файли, які змінював поточний чат Claude (без Undo / Keep; Review показує всі зміни чату), а новий чат починає з порожнього списку. Якщо нічого немає, там напис «No changes to review», а якщо хук не встановлено, кнопка його встановлення. Коли зміни є: угорі «N Files» і завжди видимі **Undo All / Keep All / Review** (коли файл один, просто **Undo / Keep**; поки Claude працює, лишається тільки Review; Undo All підтверджується другим кліком через **Confirm**, як у Cursor), рядок файлу з іконкою вашої теми й «+N -M», клік відкриває файл, при наведенні **✕** (Undo File) і **✓** (Keep File). Поки список видно, підсумок у статусбарі не показується. Розширення саме ставить його під чат; якщо перенесете деінде, він там і залишиться (повернути: команда *Show Claude Changes Under the Claude Code Chat*). **Claude Steps** показує кроки (один на промпт) з можливістю відкотити крок.
- **Claude Inline Diff: Revert Last Keep/Undo** відкочує будь-яку дію рев'ю. Cmd/Ctrl+Z одразу після Keep або Undo теж відкочує цю дію, і зміна знову чекає на рев'ю.
- Якщо Cmd+N заважає (наприклад, ви звикли так створювати файл), виставте `"claudeInlineDiff.keybindingScheme": "alt"`. Тоді працюватимуть Cmd/Ctrl+Alt+Enter і Cmd/Ctrl+Alt+Backspace. Утім, Cmd+Y/N і так діють **лише коли курсор усередині зміни Claude**.

Знімки «до» зберігаються поза проєктом, в окремій папці для кожного проєкту: `~/.claude/inline-diff/projects/<назва проєкту>-<хеш шляху>/`, тож проєкт лишається чистим. З `"claudeInlineDiff.storage.location": "project"` вони лежать у `<корінь git>/.claude-review/`, яка ігнорує сама себе через власний `.gitignore` із `*`. Під час перемикання розширення саме переносить наявні знімки, а стару папку `.claude-review` з попередніх версій переносить у новий типовий шлях. Якщо проєкт перейменувати чи перемістити, незавершене рев'ю й історія кроків для нього почнуться з нуля (код не постраждає).

Файли поза проєктом теж потрапляють на рев'ю, їхні знімки лежать у `~/.claude/inline-diff/store/`. Якщо такий знімок ніхто не розглянув за `stepRetentionDays` днів (типово 7), він прибирається, а файл лишається як є. Виняток: робочі папки самого Claude Code у `~/.claude` (`projects/` з пам'яттю, `plans/`, `todos/`) не знімаються взагалі. Ваші `settings.json`, `CLAUDE.md`, skills, agents, hooks і commands у `~/.claude` рев'юються як звичайні файли. Історія чату в Claude Changes і список Claude Steps показують лише чати, запущені в проєкті цього вікна.

## 9. Оновлення

```bash
git pull && npm ci && npm run package
cursor --install-extension claude-inline-diff.vsix --force
```

Після цього повністю перезапустіть Cursor. Скрипт хука оновиться автоматично при першому старті нової версії. Перевірити: **Show Hook Status**.

## 10. Повне видалення

1. Cmd/Ctrl+Shift+P → **Claude Inline Diff: Uninstall Claude Code Hook**. Команда:
   - прибирає **лише наші** записи з `~/.claude/settings.json` (з резервною копією);
   - видаляє скрипт `~/.claude/hooks/claude-inline-diff-hook.js`;
   - повертає `permissions.defaultMode` і `claudeCode.initialPermissionMode`, якщо їх змінювало розширення;
   - пропонує видалити знімки (`~/.claude/inline-diff/projects/…`, `~/.claude/inline-diff/store` і `.claude-review/`, якщо є).
2. Видаліть розширення: Extensions → Claude Inline Diff → Uninstall, або
   ```bash
   cursor --uninstall-extension inlinediff.claude-inline-diff
   ```
   Страховка: VS Code при повному видаленні розширення й наступному перезапуску запускає скрипт `vscode:uninstall`. Наш скрипт робить те саме, що й крок 1, окрім знімків і `claudeCode.initialPermissionMode` (його повертає лише команда Uninstall). ✅ за документацією VS Code і тестом скрипта; 🔶 чи виконує його Cursor, не перевірено. Тому крок 1 надійніший.
3. Приберіть рядок `"enable-proposed-api": ["inlinediff.claude-inline-diff"]` з `~/.cursor/argv.json`.
4. Якщо лишились знімки (у проєктах вони є лише з `storage.location: project` або з версій до 0.1.27):
   ```bash
   find ~/projects -type d -name .claude-review -prune -exec rm -rf {} +
   rm -rf ~/.claude/inline-diff
   ```

Ручне прибирання, якщо команди недоступні: відкрийте `~/.claude/settings.json` і видаліть усі об'єкти, у яких `command` містить `claude-inline-diff-hook.js`. Потім видаліть сам файл `~/.claude/hooks/claude-inline-diff-hook.js`.

## 11. Якщо щось не працює

- **Cmd+Y / Cmd+N не працюють** (відкривається щось інше, наприклад «No definition found»): ці клавіші зайняло інше розширення, найчастіше розкладка IntelliJ IDEA Keybindings. Розширення попереджає про це під час старту; натисніть **Fix Shortcuts** або виконайте **Claude Inline Diff: Fix Shortcut Conflicts with Other Extensions**. У ваш `keybindings.json` додаються записи, що діють лише всередині змін Claude (бекап — `keybindings.json.bak-claude-inline-diff`).

- **Show Hook Status** показує, чи встановлено хук, чи він актуальний, режим дозволів і стан `editorInsets`.
- View → Output → **Claude Inline Diff** містить журнал розширення.
- Правок не видно:
  - перевірте, що розмова почалась **після** встановлення хука;
  - у панелі Claude Code → Customize → Hooks мають бути наші хуки;
  - файл має бути всередині відкритої папки;
  - ви перебуваєте в тому самому git-репозиторії, де працює Claude.
- Червоних блоків немає, лише риска: `argv.json` не підхопився. Повністю перезапустіть Cursor і перевірте id.
