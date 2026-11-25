<p align="center">
  <img src="extension/icons/capture8k-mark.svg" width="96" alt="Icône Capture8K">
</p>

<h1 align="center">Capture8K</h1>

<p align="center">
  Captures web 4K et 8K pour Chrome et Firefox sur macOS.
</p>

<p align="center">
  <a href="https://github.com/Coraubanne/Capture8K/releases/latest"><img alt="Télécharger Capture8K" src="https://img.shields.io/badge/T%C3%A9l%C3%A9charger_Capture8K-007AFF?style=for-the-badge&amp;logo=apple"></a>
</p>

<p align="center">
  <a href="https://github.com/Coraubanne/Capture8K/releases/latest"><img alt="Dernière version" src="https://img.shields.io/github/v/release/Coraubanne/Capture8K?style=flat-square"></a>
  <a href="https://github.com/Coraubanne/Capture8K/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/Coraubanne/Capture8K/test.yml?branch=main&amp;style=flat-square"></a>
  <a href="README.en.md">English</a> · <a href="CHANGELOG.md">Historique des versions</a>
</p>

Capture8K réunit des extensions Chrome et Firefox avec une app macOS native.
Le navigateur rerastérise la partie visible de la page avec un grand côté de
3 840 px (4K) ou 7 680 px (8K), sans upscale IA, assemblage par défilement ni
changement de viewport.

> Projet expérimental pour macOS. Une capture certifiée a les dimensions
> annoncées et a passé les contrôles géométriques et visuels, mais une image
> bitmap intégrée à la page ne peut pas contenir plus de détails que sa source.

## Fonctionnalités

- capture immédiate du viewport visible complet en 4K ou 8K ;
- conservation du ratio, du zoom Chrome, du DPR et des media queries ;
- stabilisation des animations, médias et pages dynamiques ;
- conservation fidèle des surfaces vidéo, canvas et iframe quand Chrome les
  compose séparément du document haute résolution ;
- garde locale qui rétablit automatiquement le mode fidèle après chaque lancement de Chrome ;
- validation indépendante par l’app macOS avant l’écriture du PNG ;
- dossier d’export personnalisable ;
- export direct dans le projet Premiere Pro actif via le pont partagé Creator Bridge ;
- mise à jour vérifiée par SHA-256 de l’app, des extensions et du pont ;
- installation anti-doublon : une seule version active par navigateur et un seul pont Premiere ;
- raccourci macOS `⌘⇧8` ;
- aucune IA et aucun envoi vers un service distant.

## Prérequis

- macOS 13 ou ultérieur ;
- Google Chrome 125 ou Firefox 125 (ou ultérieur) ;
- Adobe Premiere Pro 25.6 ou ultérieur pour l’import dans un projet.

## Installation

1. Téléchargez `Capture8K-complet-v…zip` dans la [dernière release](https://github.com/Coraubanne/Capture8K/releases/latest) et décompressez l’archive.
2. Dans Terminal, ouvrez le dossier **Capture8K complet**, puis lancez `./install-macos.sh`. Le script installe l’app précompilée et place les extensions dans `~/Documents/Capture8K`.
3. Pour Chrome, ouvrez `chrome://extensions`, activez le **Mode développeur**, choisissez **Charger l’extension non empaquetée** et sélectionnez le dossier `~/Documents/Capture8K/Chrome`.
4. Copiez l’identifiant affiché par Chrome et relancez le script depuis le même dossier, en remplaçant le texte d’exemple par cet identifiant.

   ```sh
   ./install-macos.sh IDENTIFIANT_DE_L_EXTENSION
   ```

Pour Firefox, ouvrez `about:debugging#/runtime/this-firefox`, cliquez sur **Charger un module complémentaire temporaire…** et sélectionnez `~/Documents/Capture8K/Firefox/manifest.json`. Firefox retire le module temporaire en quittant.

## Utilisation

Ouvrir une page web, choisir 4K ou 8K dans le popup, puis cliquer sur
**Capturer** ou utiliser `⌘⇧8`. La roue ouvre les réglages : destination
Téléchargements, autre dossier ou Premiere Pro, ainsi que la mise à jour.
La destination Premiere crée `Captures Capture8K` à côté du projet enregistré
et ajoute immédiatement le PNG au projet actif.

## Architecture

- `extension/` : extension Chrome Manifest V3 ;
- `extension-firefox/` : extension Firefox Manifest V3 ;
- `macos/` : app de barre des menus et hôte Native Messaging en Objective-C ;
- `vendor/CreatorBridge` : référence Git vers le projet autonome
  [Creator Bridge](https://github.com/Coraubanne/CreatorBridge) ;
- `scripts/build-release.sh` : archive complète et somme SHA-256 attendues par
  l’updater sécurisé ;
- `tests/` : tests du moteur de capture ;
- `install-macos.sh` : compilation, installation de l’app et génération du
  manifeste Native Messaging propre à l’utilisateur.

Chrome utilise `chrome.debugger` et `Page.captureScreenshot`. L’agent local
surveille Chrome et le relance avec `silent-debugger-extension-api` lorsque cet
argument manque, afin d’éviter la barre technique qui modifierait la hauteur
des pages responsives. Firefox utilise directement
`tabs.captureVisibleTab` avec le facteur d’échelle natif de Gecko. Dans les deux
cas, l’app certifie les dimensions et compare des captures témoins avant
d’enregistrer le fichier.

## Tests

Le build de développement utilise les outils de ligne de commande Xcode et les tests nécessitent Node.js.

```sh
git submodule update --init
./macos/build.sh
node --test tests/test-background.mjs macos/Tests/test-native-host.mjs
```

## Mises à jour et composants partagés

Chaque [version publiée](https://github.com/Coraubanne/Capture8K/releases)
contient l’app, les deux extensions et une version précise de
Creator Bridge. L’updater valide l’identité, la version, la signature de l’app
et la somme SHA-256 avant remplacement. Il met à jour tous les chemins Chrome
réellement chargés. Pour une première installation Chrome et pour Firefox,
les dossiers sont `~/Documents/Capture8K/Chrome` et `~/Documents/Capture8K/Firefox`.
Une version plus récente de Creator Bridge
n’est jamais rétrogradée ; les copies plus anciennes portant le même identifiant
validé sont supprimées après installation réussie.

## Licence

Aucune licence open source n’est accordée pour le moment. Tous droits réservés.
