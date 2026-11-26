# Capture8K

<img src="extension/icons/capture8k-mark.svg" width="88" align="right" alt="Icône Capture8K">

Enregistrez la partie visible d’une page web en PNG 4K ou 8K. Capture8K conserve les proportions et vérifie le résultat avant l’enregistrement. Il peut aussi envoyer la capture dans votre projet Premiere Pro.

**[Télécharger Capture8K](https://github.com/Coraubanne/Capture8K/releases/latest)** · [Historique des versions](CHANGELOG.md) · [English](README.en.md)

Apple Silicon · macOS 13+ · Chrome 125+ ou Firefox 125+

## Installer Capture8K

1. Téléchargez l’archive `Capture8K-complet-v…zip` dans la dernière release et décompressez-la. Sur GitHub, **Code → Download ZIP** donne accès au code source.
2. Dans Terminal, placez-vous dans le dossier **Capture8K complet** et lancez `./install-macos.sh`. Le script installe l’application macOS et copie les extensions dans `~/Documents/Capture8K`.
3. Suivez les étapes correspondant à votre navigateur.

   | Navigateur | Configuration |
   | --- | --- |
   | Google Chrome | Ouvrez `chrome://extensions`, activez le **Mode développeur** et chargez le dossier `~/Documents/Capture8K/Chrome` avec **Charger l’extension non empaquetée**. Copiez l’identifiant affiché par Chrome, puis relancez `./install-macos.sh IDENTIFIANT_DE_L_EXTENSION` depuis le dossier de l’installateur. |
   | Firefox | Ouvrez `about:debugging#/runtime/this-firefox` et choisissez `~/Documents/Capture8K/Firefox/manifest.json` avec **Charger un module complémentaire temporaire**. Rechargez le module après avoir quitté puis relancé Firefox. |

## Faire une capture

Ouvrez une page, choisissez **4K** ou **8K** dans l’extension et cliquez sur **Capturer**. Le raccourci `⌘⇧8` relance une capture avec le réglage courant. La roue ouvre les réglages pour choisir le dossier d’enregistrement, la langue de l’interface et le son de fin.

Le grand côté du PNG mesure **3 840 px en 4K** ou **7 680 px en 8K**. Capture8K effectue un nouveau rendu de la zone visible avec le moteur du navigateur et conserve les proportions. Les images intégrées conservent le niveau de détail de leurs sources.

Les captures sont traitées sur le Mac. Le compagnon vérifie leurs dimensions et compare des images témoins avant d’écrire le PNG.

## Envoyer une capture vers Premiere Pro

Ouvrez un projet enregistré dans **Premiere Pro 25.6 ou ultérieur**, puis affichez **Fenêtre → Plug-ins UXP → Creator Bridge**. Dans Capture8K, choisissez **Premiere Pro** comme destination. La capture est enregistrée dans `Captures Capture8K` à côté du projet, puis Creator Bridge reçoit la demande d’import dans le panneau Projet. [Creator Bridge](https://github.com/Coraubanne/CreatorBridge)

## Mettre à jour

Ouvrez **Réglages → Chercher une mise à jour** dans l’extension. Le compagnon vérifie l’empreinte SHA-256 avant de remplacer l’app et les fichiers des extensions. Sous Firefox, rechargez le module temporaire pour utiliser les nouveaux fichiers. Lorsque Premiere Pro est la destination choisie, Capture8K vérifie aussi Creator Bridge séparément.

## Projet et assistance

- [Signaler un problème](https://github.com/Coraubanne/Capture8K/issues) · [Tests GitHub Actions](https://github.com/Coraubanne/Capture8K/actions/workflows/test.yml)
- Code source consultable sur GitHub. Tous droits réservés.

<details>
<summary>Architecture et tests</summary>

Les extensions se trouvent dans `extension/` et `extension-firefox/`. Le compagnon macOS et l’hôte de messagerie native sont écrits en Objective-C dans `macos/`. Le panneau Creator Bridge est référencé comme sous-module dans `vendor/CreatorBridge`.

Chrome utilise `chrome.debugger` et `Page.captureScreenshot`. L’agent macOS peut relancer Chrome dans son mode de capture pour conserver la hauteur de la zone visible. Firefox utilise `tabs.captureVisibleTab` et le facteur d’échelle du moteur Gecko.

Les tests s’exécutent sur macOS avec les outils de ligne de commande Xcode et Node.js.

```sh
git submodule update --init
./macos/build.sh
node --test tests/test-background.mjs macos/Tests/test-native-host.mjs
```

</details>
