# Capture8K.app

Compagnon macOS natif des extensions Capture8K 2.7.3 pour Chrome et Firefox.

- garde automatique qui relance Chrome en mode fidèle uniquement lorsqu'il manque ;
- prise en charge directe du rerendu haute densité natif de Firefox ;
- menu 4K / 8K dans la barre des menus ;
- réglages partagés avec le raccourci Chrome `⌘⇧8` ;
- dossier de destination personnalisable directement depuis l’extension ;
- réception locale des PNG par Native Messaging ;
- comparaison de la référence, du témoin direct et du rendu final ;
- composition fidèle et contrôlée des surfaces vidéo, canvas et iframe ;
- contrôle 3840×2160 ou 7680×4320 ;
- écriture atomique et copie du fichier dans le presse-papiers.

Compilation sans Xcode complet :

```sh
./build.sh
clang -fobjc-arc -fmodules -fmodules-cache-path=build/ModuleCache \
  -framework AppKit -I Sources/Shared \
  Sources/Shared/Capture8KShared.m Tests/test-persistent-mode.m \
  -o build/test-persistent-mode && build/test-persistent-mode
```

Le bundle généré se trouve dans `build/Capture8K.app`. Chrome utilise
`allowed_origins` dans son manifeste Native Messaging ; Firefox utilise
`allowed_extensions` avec l’identifiant `capture8k@coraubanne`.
