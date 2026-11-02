# Capture8K

Capture8K est une extension Chrome accompagnée d’une app macOS native. Elle
demande à Chrome de rerastériser la partie visible de la page avec un grand côté
de 3 840 px (4K) ou 7 680 px (8K), sans upscale IA, assemblage par défilement ni
changement de viewport.

> Projet expérimental pour macOS. Une capture certifiée a les dimensions
> annoncées et a passé les contrôles géométriques et visuels, mais une image
> bitmap intégrée à la page ne peut pas contenir plus de détails que sa source.

## Fonctionnalités

- capture immédiate du viewport visible complet en 4K ou 8K ;
- conservation du ratio, du zoom Chrome, du DPR et des media queries ;
- stabilisation des animations, médias et pages dynamiques ;
- validation indépendante par l’app macOS avant l’écriture du PNG ;
- dossier d’export personnalisable ;
- raccourci macOS `⌘⇧8` ;
- aucune IA et aucun envoi vers un service distant.

## Prérequis

- macOS 13 ou ultérieur ;
- Google Chrome 125 ou ultérieur ;
- les outils de ligne de commande Xcode (`clang`, `codesign`) ;
- Node.js pour lancer les tests.

## Installation locale

1. Cloner le dépôt.
2. Dans `chrome://extensions`, activer le mode développeur, choisir **Charger
   l’extension non empaquetée**, puis sélectionner le dossier `extension`.
3. Copier l’identifiant affiché par Chrome pour Capture8K.
4. Depuis la racine du dépôt, lancer :

   ```sh
   ./install-macos.sh IDENTIFIANT_DE_L_EXTENSION
   ```

5. Ouvrir Capture8K depuis `~/Applications`, puis utiliser **Préparer Chrome**.
   Chrome demande une relance afin d’activer le mode fidèle et restaure ensuite
   la session précédente.

## Utilisation

Ouvrir une page web, choisir 4K ou 8K dans le popup, puis cliquer sur
**Capturer** ou utiliser `⌘⇧8`. Le bouton **Dossier…** choisit la destination
des prochaines captures.

## Architecture

- `extension/` : extension Chrome Manifest V3 ;
- `macos/` : app de barre des menus et hôte Native Messaging en Objective-C ;
- `tests/` : tests du moteur de capture ;
- `install-macos.sh` : compilation, installation de l’app et génération du
  manifeste Native Messaging propre à l’utilisateur.

La capture utilise `chrome.debugger` et `Page.captureScreenshot`. L’app relance
Chrome avec `--silent-debugger-extension-api` afin d’éviter la barre technique
qui modifierait la hauteur des pages responsives. Ne conserve que des
extensions de confiance ayant accès au débogueur.

## Tests

```sh
node tests/test-background.mjs
./macos/build.sh
node macos/Tests/test-native-host.mjs
```

## Licence

Aucune licence open source n’est accordée pour le moment. Tous droits réservés.
