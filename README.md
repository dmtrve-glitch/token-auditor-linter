# Token Auditor & Linter

[Русский](#русский) · [English](#english)

## Русский

**Плагин для Figma, который помогает навести порядок в цветовых токенах дизайн-системы: найти значения без привязки, разобраться в стилях и переменных и подобрать ближайшие цвета из локальной палитры.**

В реальных макетах один цвет может быть задан вручную, через стиль или через переменную. Token Auditor & Linter собирает эти случаи в один отчёт, чтобы дизайнеру не приходилось проверять каждый слой вручную.

### Что умеет текущая версия

- Сканирует выделенные объекты вместе с вложенными слоями. Если выделения нет, сканирует текущую страницу.
- Анализирует заливки (**FILL**) и обводки (**STROKE**).
- Разделяет результаты по источнику значения: **RAW**, **STYLE**, **VARIABLE**; показывает доступные сведения о локальных и внешних привязках.
- Группирует результаты по цвету, стилю или переменной; позволяет фильтровать их по свойству, типу слоя и источнику.
- Показывает сведения о слое, его заливке, обводке и прозрачности.
- Для поддерживаемых RAW-цветов предлагает ближайшие локальные цветовые переменные с визуальным сравнением образцов. При построении палитры разрешает доступные алиасы.
- Выделяет отдельный слой или группу слоёв в Figma и переводит к ним область просмотра.

Это инструмент **аудита без автоматического изменения оформления**. Наличие записи STYLE или VARIABLE в отчёте само по себе не означает ошибку: решение зависит от правил вашей дизайн-системы. Предложения по близости цвета тоже требуют проверки дизайнером.

### Для кого и зачем

Для продуктовых дизайнеров и команд дизайн-систем: проверить макет перед передачей в разработку, оценить объём нетокенизированных цветов или подготовить файл к переходу на переменные.

Рабочий сценарий: **выделить область → Scan → выбрать FILL/STROKE и источник → раскрыть группу → сравнить варианты → перейти к нужным слоям**.

### Границы текущей версии

- Подбор основан на локальных COLOR variables, а не на полном каталоге командных библиотек.
- Разрешение имён и алиасов ограничено данными, доступными через Figma Plugin API. Подбор цвета не является проверкой семантической совместимости токенов или всех режимов переменных.
- NUMERIC присутствует в интерфейсе как заготовка, но отдельный аудит числовых свойств ещё не реализован.
- Массовые исправления, правила разрешённых библиотек и коллекций, аудит типографики и других свойств относятся к дальнейшему развитию.
- Это development-плагин. Автоматические тесты пока не настроены.

### Установка и разработка

Нужны Node.js с npm и настольная Figma.

```bash
git clone https://github.com/dmtrve-glitch/token-auditor-linter.git
cd token-auditor-linter
npm ci
npm run build
```

В Figma откройте **Plugins → Development → Import plugin from manifest…** и выберите `manifest.json`. Запустите **Token Auditor & Linter** из меню Development.

Для пересборки при изменениях:

```bash
npm run watch
```

Основные файлы: `code.ts` (логика плагина), `ui.html` (интерфейс), `manifest.json` (конфигурация), `dist/code.js` (сборка). Перед запуском пересобирайте код из исходников.

### Данные

Текущий manifest запрещает сетевой доступ (`allowedDomains: ["none"]`). Аудит работает внутри Figma; внешний сервер, OAuth и API-ключи для этой версии не нужны.

---

## English

**A Figma plugin for auditing design-system color tokens: find unbound values, inspect styles and variables, and discover nearby colors in the local variable palette.**

In real design files, the same color can be hard-coded, applied through a style, or bound to a variable. Token Auditor & Linter brings these cases into one report so designers do not have to inspect every layer manually.

### Current capabilities

- Scans selected objects and their descendants, or the current page when nothing is selected.
- Audits **FILL** and **STROKE** properties.
- Classifies results as **RAW**, **STYLE**, or **VARIABLE**, with available local/external binding information.
- Groups results by color, style, or variable, with filters for property, layer type, and source.
- Shows layer details, fill and stroke values, and opacity.
- Suggests nearby local color variables for supported RAW colors, with side-by-side color swatches. Resolves accessible aliases when building the palette.
- Selects an individual layer or a group of layers and brings them into view in Figma.

This is an **audit tool, not an automatic restyling tool**. A STYLE or VARIABLE entry is not necessarily an error: that depends on your design-system rules. Color-distance suggestions also require a designer's judgment.

### Who it is for

Product designers and design-system teams checking files before handoff, assessing untokenized colors, or preparing a migration to variables.

Typical workflow: **select a scope → Scan → choose FILL/STROKE and source → expand a group → compare suggestions → select the relevant layers**.

### Current limitations

- Matching uses local COLOR variables, not a complete catalog of team libraries.
- Name and alias resolution depends on what the Figma Plugin API exposes. Color matching does not validate token semantics or every variable mode.
- NUMERIC is a UI placeholder; dedicated numeric-property auditing is not implemented.
- Bulk fixes, allowed-library and collection policies, typography auditing, and additional property domains are future work.
- This is a development plugin. Automated tests are not configured yet.

### Installation and development

Requires Node.js with npm and the Figma desktop app.

```bash
git clone https://github.com/dmtrve-glitch/token-auditor-linter.git
cd token-auditor-linter
npm ci
npm run build
```

In Figma, choose **Plugins → Development → Import plugin from manifest…** and select `manifest.json`. Run **Token Auditor & Linter** from the Development menu.

To rebuild when source files change:

```bash
npm run watch
```

Main files: `code.ts` (plugin logic), `ui.html` (interface), `manifest.json` (configuration), and `dist/code.js` (build output). Rebuild from source before running the plugin.

### Data handling

The current manifest disables network access (`allowedDomains: ["none"]`). Auditing runs inside Figma; this version needs no external server, OAuth connection, or API keys.
