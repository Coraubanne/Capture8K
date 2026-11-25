# Capture8K

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
- les outils de ligne de commande Xcode (`clang`, `codesign`) ;
- Node.js pour lancer les tests.

## Installation locale

1. Cloner le dépôt.
2. Initialiser les dépendances avec `git submodule update --init`, puis ouvrir
   `chrome://extensions`, activer le mode développeur, choisir **Charger
   l’extension non empaquetée**, puis sélectionner `extension`.
3. Copier l’identifiant affiché par Chrome pour Capture8K, puis lancer :

   ```sh
   ./install-macos.sh IDENTIFIANT_DE_L_EXTENSION
   ```

4. L’installation démarre l’agent Capture8K à l’ouverture de session. Si Chrome
   est lancé sans son mode fidèle, l’agent le relance automatiquement avec la
   session précédente ; aucune réparation manuelle récurrente n’est nécessaire.

Pour tester Firefox sans publication AMO, ouvrir
`about:debugging#/runtime/this-firefox`, cliquer sur **Charger un module
complémentaire temporaire…** et sélectionner `extension-firefox/manifest.json`.
Firefox n’a besoin d’aucune préparation. Mozilla impose cependant une signature
AMO pour conserver une extension après la fermeture de Firefox.

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

```sh
node tests/test-background.mjs
./macos/build.sh
node macos/Tests/test-native-host.mjs
```

## Mises à jour et composants partagés

Chaque [version publiée](https://github.com/Coraubanne/Capture8K-Releases/releases)
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
