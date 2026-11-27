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
- додає у `~/.claude/settings.json` три записи:
  - `PreToolUse` і `PostToolUse` з matcher `Edit|MultiEdit|Write|NotebookEdit|Bash`;
  - `UserPromptSubmit` (без matcher);
- перед зміною робить резервну копію `settings.json.bak-claude-inline-diff-<час>`, зберігає права доступу до файлу й не чіпає чужі хуки;
- якщо `settings.json` містить невалідний JSON, нічого не змінює й показує помилку.

Офіційне розширення Claude Code і CLI використовують **той самий** `~/.claude/settings.json`, тож хук працює в обох (за документацією Anthropic; 🔶 запуск хуків саме офіційним розширенням у пісочниці перевірити неможливо, бо потрібен вхід у Claude). Після встановлення **почніть нову розмову** в панелі Claude Code.

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

- Попросіть Claude щось змінити. Файл відкриється сам (у preview-вкладці, фокус залишиться в чаті), зміни будуть підсвічені.
- Курсор у зміні: **Cmd/Ctrl+Y** залишає (Keep), **Cmd/Ctrl+N** скасовує (Undo). Після цього курсор переходить до наступної зміни, а потім до наступного файлу.
- Весь файл: **Cmd/Ctrl+Enter** залишає, **Cmd/Ctrl+Shift+Backspace** скасовує (як у Cursor). Працюють і Cmd/Ctrl+Shift+Y / N.
- Під кожною зміною справа є «пігулка», як у Cursor: **⌃ 2 of 5 ⌄ │ Undo │ Keep │ …**. Стрілки перемикають зміни, а **…** означає «Undo з поясненням»: причину отримає Claude разом із вашим наступним повідомленням.
- Унизу праворуч у редакторі плавають кнопки **Undo All / Keep All** (і **Next File ›**, якщо змінено кілька файлів).
- Коли Claude робить нову правку у відкритому файлі, редактор сам прокручується до неї й на мить підсвічує нові рядки. Поки ваш курсор стоїть у зміні, вигляд не зсувається.
- **Review All Changes** (у панелі Claude Changes) відкриває всі файли в одному multi-diff, як Review у Cursor 3.
- У статусбарі є «N files · M changes» зі стрілками ▲ ▼ та індикатор «Claude editing <файл>».
- **Source Control → Claude Changes** показує всі зміни (по сесіях → файлах → змінах). **Claude Steps** показує кроки (один на промпт) з можливістю відкотити крок.
- **Claude Inline Diff: Revert Last Keep/Undo** відкочує будь-яку дію рев'ю. Cmd/Ctrl+Z одразу після Keep теж його відкочує.
- Якщо Cmd+N заважає (наприклад, ви звикли так створювати файл), виставте `"claudeInlineDiff.keybindingScheme": "alt"`. Тоді працюватимуть Cmd/Ctrl+Alt+Enter і Cmd/Ctrl+Alt+Backspace. Утім, Cmd+Y/N і так діють **лише коли курсор усередині зміни Claude**.

Знімки «до» зберігаються в `<корінь git>/.claude-review/`. Ця папка ігнорує сама себе через власний `.gitignore` із `*`, тож ваш `.gitignore` не змінюється.

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
   - пропонує видалити знімки (`.claude-review/` і `~/.claude/inline-diff/store`).
2. Видаліть розширення: Extensions → Claude Inline Diff → Uninstall, або
   ```bash
   cursor --uninstall-extension inlinediff.claude-inline-diff
   ```
   Страховка: VS Code при повному видаленні розширення й наступному перезапуску запускає скрипт `vscode:uninstall`. Наш скрипт робить те саме, що й крок 1 (окрім знімків). ✅ за документацією VS Code і тестом скрипта; 🔶 чи виконує його Cursor, не перевірено. Тому крок 1 надійніший.
3. Приберіть рядок `"enable-proposed-api": ["inlinediff.claude-inline-diff"]` з `~/.cursor/argv.json`.
4. Якщо лишились знімки в проєктах:
   ```bash
   find ~/projects -type d -name .claude-review -prune -exec rm -rf {} +
   rm -rf ~/.claude/inline-diff
   ```

Ручне прибирання, якщо команди недоступні: відкрийте `~/.claude/settings.json` і видаліть усі об'єкти, у яких `command` містить `claude-inline-diff-hook.js`. Потім видаліть сам файл `~/.claude/hooks/claude-inline-diff-hook.js`.

## 11. Якщо щось не працює

- **Show Hook Status** показує, чи встановлено хук, чи він актуальний, режим дозволів і стан `editorInsets`.
- View → Output → **Claude Inline Diff** містить журнал розширення.
- Правок не видно:
  - перевірте, що розмова почалась **після** встановлення хука;
  - у панелі Claude Code → Customize → Hooks мають бути наші хуки;
  - файл має бути всередині відкритої папки;
  - ви перебуваєте в тому самому git-репозиторії, де працює Claude.
- Червоних блоків немає, лише риска: `argv.json` не підхопився. Повністю перезапустіть Cursor і перевірте id.
