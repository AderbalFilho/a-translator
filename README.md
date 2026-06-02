# A-Translator v 2.0.0

Unofficial localization tool for **Alchemy VTT**, based on community dictionaries and local customization.

A-Translator allows players and Game Masters to translate Alchemy VTT's interface and game-system terminology using modular dictionaries stored entirely on their own computer.

All translations are applied locally in the browser. No data is sent to any external service.

---

# What is A-Translator?

A-Translator is a _Tampermonkey userscript_ that translates Alchemy VTT's interface using community-maintained dictionaries.

Unlike traditional translation tools, A-Translator does not rely on a single translation file. Version 2 introduces a modular architecture where multiple dictionaries can coexist and work together.

For example:

txt French UI ├─ D&D 5E ├─ Pathfinder 2E ├─ Shadow of the Demon Lord ├─ Custom Pack └─ User Overrides 

The general Alchemy interface is translated by the language dictionary, while each game system can provide its own terminology.

This allows several systems to remain available simultaneously inside the same Alchemy installation.

---

# What A-Translator is NOT

A-Translator:

- Is not an official Alchemy feature
- Is not affiliated with Arboreal, LLC
- Is not a machine translation tool
- Does not modify Alchemy servers
- Does not modify game content
- Does not access your account data
- Does not send data anywhere

Everything happens locally inside your browser.

---

# Installation

## 1. Install Tampermonkey

### Chrome / Edge / Brave

https://www.tampermonkey.net/

### Firefox

https://www.tampermonkey.net/

---

## 2. Configure Tampermonkey

Open:

txt Tampermonkey Dashboard → Settings 

Recommended settings:

- Enable Developer Mode
- Enable User Scripts
- Allow access to file URLs
- Allow scripts in private/incognito windows

---

## 3. Install A-Translator

Open:

txt https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/userscript/a-translator.user.js 

Confirm installation in Tampermonkey.

Future script updates are handled automatically.

---

# Usage

Open:

txt https://app.alchemyrpg.com 

A globe icon appears on the left side of the screen.

Click it to open A-Translator.

From there you can:

- Import official GitHub dictionaries
- Import local JSON dictionaries
- Enable or disable individual dictionaries
- Export active translations
- Edit your personal translations
- Check for available updates

Changes are applied immediately after saving.

---

# Dictionary Types

A-Translator supports four dictionary types.

## Core Dictionaries

Core dictionaries translate the general Alchemy interface.

Examples:

- French UI
- Spanish UI
- German UI

Only one core dictionary is normally active for a given language.

---

## System Dictionaries

System dictionaries translate terminology specific to game systems.

Examples:

- D&D 5E
- Pathfinder 2E
- Shadow of the Demon Lord
- Call of Cthulhu

Multiple system dictionaries may coexist simultaneously.

This is one of the major features introduced in Version 2.

---

## Custom Dictionaries

Custom dictionaries provide optional additions.

Examples:

- Community extensions
- Homebrew terminology
- Module-specific translations
- Personal shared packs

---

## User Overrides

User Overrides contain personal modifications made through the editor.

They are automatically applied after all other dictionaries.

This guarantees that your custom translations always take priority.

---

# Dictionary Format

Dictionaries use the following structure:

json {   "meta": {     "id": "fr-core",     "name": "French UI",     "lang": "fr",     "type": "core",     "dictVersion": "2.0"   },   "entries": {     "game": "Partie",     "character": "Personnage"   } } 

## Metadata Fields

| Field | Description |
|---------|-------------|
| id | Unique dictionary identifier |
| name | Display name |
| lang | Language code |
| type | Dictionary type |
| dictVersion | Dictionary version |

Supported dictionary types:

- core
- system
- custom
- user

Additional metadata may be stored locally for update tracking and source information.

---

# Dictionary Stack

A-Translator builds an active translation stack from all enabled dictionaries.

Translations are applied in order.

Typical example:

txt Core UI ↓ System Dictionaries ↓ Custom Dictionaries ↓ User Overrides 

User Overrides always have the highest priority.

---

# GitHub Dictionaries

Official dictionaries can be distributed directly through GitHub.

A-Translator can:

- Discover available dictionaries
- Import dictionaries directly from GitHub
- Detect newer versions
- Update individual dictionaries

Updates are applied only after confirmation and saving.

---

# Dictionary Editor

The editor is hidden by default.

Click:

txt Edit current dictionary 

to display it.

Features include:

- Search entries
- Edit translations
- Entry counting
- Personal overrides
- Immediate preview after saving

Manual edits are stored separately from imported dictionaries whenever possible.

---

# Migration from Version 1

Version 2 automatically migrates existing Version 1 installations.

Existing dictionaries are preserved and converted into the new modular architecture.

No manual conversion is required.

---

# Data Storage

A-Translator stores the following locally:

- Installed dictionaries
- Active dictionary configuration
- User overrides
- Translation settings

No cloud synchronization is used.

No translation data is transmitted externally.

---

# Community Contributions

Community contributions are welcome.

You can contribute:

- New languages
- System dictionaries
- Translation improvements
- Bug fixes
- Documentation

Repository:

txt https://github.com/BriocheMasquee/a-translator 

---

# Reset

## Delete All Modules

This removes:

- Installed dictionaries
- User overrides
- Dictionary configuration
- Translation metadata

The userscript itself remains installed.

---

# Uninstall

To completely remove A-Translator:

1. Open Tampermonkey
2. Disable or remove the A-Translator userscript
3. Optionally use "Delete All Modules" beforehand

---

# Disclaimer

Alchemy is © Arboreal, LLC.

A-Translator is an unofficial community project and is not affiliated with Arboreal, LLC.

Use at your own discretion.

---

# License

MIT License
