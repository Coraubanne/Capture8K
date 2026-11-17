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
- mode fidèle Chrome persistant après les redémarrages et mises à jour ;
- validation indépendante par l’app macOS avant l’écriture du PNG ;
- dossier d’export personnalisable ;
- raccourci macOS `⌘⇧8` ;
- aucune IA et aucun envoi vers un service distant.

## Prérequis

- macOS 13 ou ultérieur ;
- Google Chrome 125 ou Firefox 125 (ou ultérieur) ;
- les outils de ligne de commande Xcode (`clang`, `codesign`) ;
- Node.js pour lancer les tests.

## Installation locale

1. Cloner le dépôt.
2. Pour Chrome, ouvrir `chrome://extensions`, activer le mode développeur,
   choisir **Charger l’extension non empaquetée**, puis sélectionner `extension`.
3. Copier l’identifiant affiché par Chrome pour Capture8K, puis lancer :

   ```sh
   ./install-macos.sh IDENTIFIANT_DE_L_EXTENSION
   ```

4. Ouvrir Capture8K depuis `~/Applications`, puis utiliser **Préparer Chrome**
   une seule fois. L’app active le mode fidèle dans les réglages persistants de
   Chrome, relance le navigateur et restaure la session précédente.

Pour tester Firefox sans publication AMO, ouvrir
`about:debugging#/runtime/this-firefox`, cliquer sur **Charger un module
complémentaire temporaire…** et sélectionner `extension-firefox/manifest.json`.
Firefox n’a besoin d’aucune préparation. Mozilla impose cependant une signature
AMO pour conserver une extension après la fermeture de Firefox.

## Utilisation

Ouvrir une page web, choisir 4K ou 8K dans le popup, puis cliquer sur
**Capturer** ou utiliser `⌘⇧8`. Le bouton **Dossier…** choisit la destination
des prochaines captures.

## Architecture

- `extension/` : extension Chrome Manifest V3 ;
- `extension-firefox/` : extension Firefox Manifest V3 ;
- `macos/` : app de barre des menus et hôte Native Messaging en Objective-C ;
- `tests/` : tests du moteur de capture ;
- `install-macos.sh` : compilation, installation de l’app et génération du
  manifeste Native Messaging propre à l’utilisateur.

Chrome utilise `chrome.debugger` et `Page.captureScreenshot`. L’app active de
façon persistante `silent-debugger-extension-api` afin d’éviter la barre
technique qui modifierait la hauteur des pages responsives. Firefox utilise directement
`tabs.captureVisibleTab` avec le facteur d’échelle natif de Gecko. Dans les deux
cas, l’app certifie les dimensions et compare des captures témoins avant
d’enregistrer le fichier.

## Tests

```sh
node tests/test-background.mjs
./macos/build.sh
node macos/Tests/test-native-host.mjs
```

## Licence

Aucune licence open source n’est accordée pour le moment. Tous droits réservés.
