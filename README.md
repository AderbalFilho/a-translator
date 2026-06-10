# Documentiation versions

Portuguese version [here](PTBR-README.md) (versão em português [aqui](PTBR-README.md)).

# A-Translator v 2.0.0

Unofficial localization tool for _Alchemy VTT_.

A-Translator allows players and Game Masters to translate _Alchemy VTT_'s interface and game-system terminology using modular dictionaries stored entirely on their own computer. All translations are applied locally in the browser. No data is sent anywhere.

![A-Translator interface](assets/a-translator-ui-v2.0.png)

---

# What is A-Translator?

A-Translator is a _Tampermonkey userscript_ that translates _Alchemy VTT_'s interface using community-maintained dictionaries.

Version 2 introduces a modular architecture where multiple dictionaries can coexist:
- Core UI dictionaries
- System dictionaries
- Custom dictionaries
- User overrides

---

# What A-Translator is NOT

A-Translator:

- Is not an official Alchemy feature
- Is not affiliated with Arboreal, LLC
- Does not modify Alchemy servers
- Does not modify or unlock game content
- Does not access your account data
- Does not send data anywhere

---

# Installation

## 1. Install Tampermonkey

https://www.tampermonkey.net/

## 2. Configure Tampermonkey

Recommended settings:
- Enable Developer Mode
- Enable User Scripts
- Allow access to file URLs
- Allow scripts in private/incognito windows

## 3. Install A-Translator

Obtain the file below, open in any text reader software and copy its contents:

https://raw.githubusercontent.com/BriocheMasquee/a-translator/main/userscript/a-translator.user.js 

Alternatively, you can access this link and copy its contents:

https://github.com/BriocheMasquee/a-translator/blob/main/userscript/a-translator.user.js

Click on the Tampermonkey extension, click on "Add new script..." and replace the content with the copied content above. Then go to file and save (or ctrl + s).

Future script updates are handled automatically.

---

# Usage

Open https://app.alchemyrpg.com 

Below the logo on the top left of the page you should see the globe icon to open A-Translator, click on it (in case you don't find it, please refresh the page).

![A-Translator location](assets/a-translator-location.png)

You can:
- Import local dictionaries
- Import GitHub dictionaries
- Enable or disable modules
- Export active modules
- Edit personal overrides
- Update installed dictionaries

---

# Dictionary Types

| Type | Purpose |
|--------|----------|
| core | Alchemy interface translation |
| system | Game-system terminology |
| custom | Optional community extensions |
| user | Personal overrides |

Multiple system dictionaries can coexist simultaneously. User overrides always have priority.

---

# Dictionary Format

```json
{
  "meta": {
      "id": "fr-core",
      "name": "French UI",
      "lang": "fr",
      "type": "core", // supported types : core, system, custom, user
      "dictVersion": "2.0"
  },
  "entries": {
      "game": "Partie",
      "character": "Personnage"
  }
}
``` 

---

# GitHub Dictionaries

Official dictionaries can be distributed through GitHub.

A-Translator can:
- Discover available dictionaries
- Import dictionaries directly from GitHub
- Detect updates
- Update individual modules

---

# Migration from Version 1

Existing Version 1 installations are migrated automatically. No manual conversion is required.

---

# Community Contributions

Community contributions are welcome.

You can contribute:
- Core UI translations
- System dictionaries
- Translation improvements
- Documentation

Repository: https://github.com/BriocheMasquee/a-translator 

---

# Reset

Delete All Modules removes:

- Installed dictionaries
- User overrides
- Translation settings

The userscript itself remains installed.

---

# Disclaimer

_Alchemy_ is © _Arboreal, LLC_.

A-Translator is an unofficial community project and is not affiliated with _Arboreal, LLC_.

---

# License

MIT License
